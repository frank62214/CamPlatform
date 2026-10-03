import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDetectionPlaylist, readLatestDetectionSegment, decodeDetectionFrame } from '../backend/detection-runtime-media.js';
import { createDetectionRuntime } from '../backend/detection-runtime.js';
import { createDetectionModel } from '../backend/detection-runtime-model.js';

const stamp = Date.parse('2026-10-03T10:00:00Z');
const playlist = (name = 'stream0.ts') => `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-10-03T10:00:00.000Z\n#EXTINF:2,\n${name}\n`;
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); }
  assert.fail('Expected async state was not reached');
}

test('PDT plus middle-of-segment offset is the event clock; implied following times remain precise', () => {
  const frames = parseDetectionPlaylist(`${playlist()}#EXTINF:4,\nstream_001.ts\n`);
  assert.equal(frames[0].occurredAt, '2026-10-03T10:00:01.000Z');
  assert.equal(frames[1].occurredAt, '2026-10-03T10:00:04.000Z');
  assert.equal(frames[1].offsetSeconds, 2);
  assert.notEqual(frames[0].frameKey, frames[1].frameKey);
});

test('missing PDT, gaps, and discontinuities never invent detection timestamps', () => {
  assert.deepEqual(parseDetectionPlaylist('#EXTM3U\n#EXTINF:2,\nstream0.ts'), []);
  const frames = parseDetectionPlaylist(`${playlist()}#EXT-X-DISCONTINUITY\n#EXTINF:2,\nstream1.ts\n`);
  assert.equal(frames.length, 1);
  assert.equal(parseDetectionPlaylist(playlist().replace('#EXTINF:', '#EXT-X-GAP\n#EXTINF:')).length, 0);
});

test('playlist rejects traversal, external protocols, unsupported encryption, and excessive durations', () => {
  for (const name of ['../stream.ts', '/stream.ts', 'http://test/stream.ts', 'sub/stream.ts', 'sub\\stream.ts', '.hidden.ts']) {
    assert.throws(() => parseDetectionPlaylist(playlist(name)), /Invalid HLS segment/);
  }
  assert.throws(() => parseDetectionPlaylist(`${playlist()}#EXT-X-KEY:METHOD=AES-128,URI="http://test"`), /Unsupported/);
  assert.throws(() => parseDetectionPlaylist(playlist().replace('#EXTINF:2', '#EXTINF:99')), /duration/);
  assert.throws(() => parseDetectionPlaylist(`#EXTM3U\n${'x'.repeat(131072)}`), /playlist/);
});

test('media reader bounds bytes and rejects stale/future streams and symbolic link files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'detection-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'cam1', 'hls');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'stream.m3u8'), playlist());
  await writeFile(path.join(folder, 'stream0.ts'), Buffer.from('media'));
  assert.equal((await readLatestDetectionSegment(root, 'cam1', stamp + 3000)).bytes.toString(), 'media');
  assert.equal(await readLatestDetectionSegment(root, 'cam1', stamp + 32000), null);
  assert.equal(await readLatestDetectionSegment(root, 'cam1', stamp - 6000), null);
  await assert.rejects(readLatestDetectionSegment(root, '../cam1', stamp), /camera/);
  await writeFile(path.join(folder, 'stream0.ts'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(readLatestDetectionSegment(root, 'cam1', stamp + 3000), /media file/);
  await rm(path.join(folder, 'stream0.ts'));
  await writeFile(path.join(root, 'outside.ts'), 'secret');
  try { await symlink(path.join(root, 'outside.ts'), path.join(folder, 'stream0.ts')); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows host does not permit file symlink creation'); return; } throw error; }
  await assert.rejects(readLatestDetectionSegment(root, 'cam1', stamp + 3000), /media file/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null)); };
  return child;
}

test('decoder forces pipe-only MPEG-TS and produces exactly one bounded RGB frame', async () => {
  const child = fakeChild();
  let args;
  const result = decodeDetectionFrame({ offsetSeconds: 1, bytes: Buffer.from('ts') }, {
    spawnProcess: (_command, input) => { args = input; return child; },
  });
  child.stdout.write(Buffer.alloc(320 * 180 * 3)); child.emit('close', 0);
  assert.equal((await result).length, 320 * 180 * 3);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
  assert.equal(args[args.indexOf('-ss') + 1], '1');
});

test('decoder timeout and cancellation kill work instead of only rejecting a race', async () => {
  const hung = fakeChild();
  await assert.rejects(decodeDetectionFrame({ offsetSeconds: 1, bytes: Buffer.from('ts') }, {
    timeoutMs: 5, spawnProcess: () => hung,
  }), /timed out/);
  assert.deepEqual(hung.kills, ['SIGKILL']);
  const active = fakeChild(); const controller = new AbortController();
  const pending = decodeDetectionFrame({ offsetSeconds: 1, bytes: Buffer.from('ts') }, {
    signal: controller.signal, spawnProcess: () => active,
  });
  controller.abort();
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(active.kills, ['SIGKILL']);
});

function runtimeHarness(overrides = {}) {
  const observations = []; const statuses = []; const waits = [];
  let stopped = 0; let models = 0;
  const enabled = new Set(['cam1', 'cam2']);
  const runtime = createDetectionRuntime({ dataRoot: '/unused', cameraIds: ['cam1', 'cam2'], intervalMs: 100,
    isEnabled: (id) => enabled.has(id), onObservation: async (id, frame) => observations.push({ id, ...frame }),
    onStatus: (id, status) => statuses.push({ id, ...status }),
    ...overrides.options,
  }, { now: () => stamp + 3000,
    readSegment: async (_root, id) => ({ frameKey: id, occurredAtMs: stamp + 1000, occurredAt: new Date(stamp + 1000).toISOString() }),
    decode: async () => Buffer.alloc(320 * 180 * 3),
    createModel: () => { models++; return { ready: Promise.resolve(), detect: async () => [{ class: 'person', score: 0.9 }], stop: async () => { stopped++; } }; },
    wait: (_ms, signal) => new Promise((resolve) => { waits.push(resolve); signal.addEventListener('abort', resolve, { once: true }); }),
    ...overrides.dependencies,
  });
  return { runtime, observations, statuses, waits, enabled, models: () => models, stopped: () => stopped };
}

test('server loop shares one detector, records without a browser, and skips duplicate frames', async () => {
  const h = runtimeHarness(); h.runtime.start();
  await until(() => h.waits.length === 1);
  assert.deepEqual(h.observations.map((item) => item.id), ['cam1', 'cam2']);
  assert.equal(h.models(), 1);
  h.waits.shift()(); await until(() => h.waits.length === 1);
  assert.equal(h.observations.length, 2);
  assert.equal(h.statuses.filter((item) => item.state === 'starting').length, 1);
  assert.equal(h.statuses.filter((item) => item.state === 'waiting').length, 0);
  await h.runtime.stop(); assert.equal(h.stopped(), 1);
});

test('a rapid disable/enable revision change discards the old in-flight inference', async () => {
  let revision = 0; let finish; let started = false;
  const predictions = new Promise((resolve) => { finish = resolve; });
  const h = runtimeHarness({ options: { getRevision: () => revision }, dependencies: {
    createModel: () => ({ ready: Promise.resolve(), stop: async () => {}, detect: async () => { started = true; return predictions; } }),
  } });
  h.enabled.delete('cam2'); h.runtime.start(); await until(() => started);
  revision += 2; // The current boolean is enabled again, but this is a new settings generation.
  finish([{ class: 'person', score: 0.99 }]); await until(() => h.waits.length === 1);
  assert.equal(h.observations.length, 0); await h.runtime.stop();
});

test('a frame that becomes stale during inference never produces an event', async () => {
  let clock = stamp + 3000;
  const h = runtimeHarness({ dependencies: { now: () => clock,
    createModel: () => ({ ready: Promise.resolve(), stop: async () => {}, detect: async () => {
      clock += 31_000; return [{ class: 'person', score: 0.99 }];
    } }),
  } });
  h.enabled.delete('cam2'); h.runtime.start(); await until(() => h.waits.length === 1);
  assert.equal(h.observations.length, 0);
  assert.equal(h.statuses.at(-1).state, 'waiting'); await h.runtime.stop();
});

test('observation persistence applies serial backpressure across cameras', async () => {
  let complete; const persisted = new Promise((resolve) => { complete = resolve; });
  let calls = 0;
  const h = runtimeHarness({ options: { onObservation: async () => { calls++; await persisted; } } });
  h.runtime.start(); await until(() => calls === 1); await turn();
  assert.equal(calls, 1); complete(); await until(() => calls === 2); await h.runtime.stop();
});

test('a settings revision change during persistence cannot commit the old frame cursor or status', async () => {
  let revision = 0; let complete; let calls = 0;
  const persisted = new Promise((resolve) => { complete = resolve; });
  const h = runtimeHarness({ options: {
    getRevision: () => revision,
    onObservation: async () => { calls++; if (calls === 1) await persisted; },
  } });
  h.enabled.delete('cam2'); h.runtime.start(); await until(() => calls === 1);
  revision += 2; complete(); await until(() => h.waits.length === 1);
  assert.equal(h.statuses.some((item) => item.state === 'watching'), false);
  // The service discarded the first observation; the new generation can sample
  // the same still-fresh frame because the stale callback did not advance its cursor.
  h.waits.shift()(); await until(() => h.waits.length === 1);
  assert.equal(calls, 2);
  assert.equal(h.statuses.at(-1).state, 'watching'); await h.runtime.stop();
});

test('disabled cameras never consume frames; last disabled camera releases model', async () => {
  const h = runtimeHarness(); h.enabled.delete('cam2'); h.runtime.start();
  await until(() => h.waits.length === 1);
  assert.deepEqual(h.observations.map((item) => item.id), ['cam1']);
  h.enabled.clear(); h.waits.shift()(); await until(() => h.waits.length === 1);
  assert.equal(h.stopped(), 1); await h.runtime.stop();
});

test('one broken stream does not unload another camera model and retries are bounded', async () => {
  const h = runtimeHarness({ dependencies: { readSegment: async (_root, id) => {
    if (id === 'cam2') throw new Error('missing');
    return { frameKey: id, occurredAtMs: stamp + 1000, occurredAt: new Date(stamp + 1000).toISOString() };
  } } });
  h.runtime.start(); await until(() => h.waits.length === 1);
  assert.equal(h.observations.length, 1); assert.equal(h.stopped(), 0);
  const errors = h.statuses.filter((item) => item.state === 'error').length;
  h.waits.shift()(); await until(() => h.waits.length === 1);
  assert.equal(h.statuses.filter((item) => item.state === 'error').length, errors);
  await h.runtime.stop();
});

class FakeWorker extends EventEmitter {
  static latest;
  constructor() { super(); FakeWorker.latest = this; this.sent = []; this.terminated = 0; }
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated++; return Promise.resolve(0); }
}

test('model watchdog hard-terminates a hung load and settles readiness', async () => {
  const model = createDetectionModel({ modelPath: '/unused', WorkerClass: FakeWorker, loadTimeoutMs: 5 });
  await assert.rejects(model.ready, /loading timed out/);
  assert.equal(FakeWorker.latest.terminated, 1); await model.stop();
});

test('model watchdog hard-terminates hung inference; stop cancels loading immediately', async () => {
  const model = createDetectionModel({ modelPath: '/unused', WorkerClass: FakeWorker, inferenceTimeoutMs: 5 });
  FakeWorker.latest.emit('message', { type: 'ready' }); await model.ready;
  await assert.rejects(model.detect(Buffer.alloc(320 * 180 * 3)), /inference timed out/);
  assert.equal(FakeWorker.latest.terminated, 1); await model.stop();
  const loading = createDetectionModel({ modelPath: '/unused', WorkerClass: FakeWorker });
  await loading.stop(); await assert.rejects(loading.ready, /stopped/);
  assert.equal(FakeWorker.latest.terminated, 1);
});

test('actual local COCO/WASM worker loads packaged weights and infers an RGB frame', {
  skip: process.env.RUN_DETECTION_MODEL_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const model = createDetectionModel({ modelPath: path.resolve('models/person/model.json') });
  try { await model.ready; assert.deepEqual(await model.detect(Buffer.alloc(320 * 180 * 3)), []); }
  finally { await model.stop(); }
});
