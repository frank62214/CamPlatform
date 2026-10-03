import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createEventStore } from '../backend/detection-store.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const event = (id = 'event1', occurredAt = new Date(NOW - 1000).toISOString(), cameraId = 'cam1') => ({
  id, cameraId, cameraName: cameraId, occurredAt, recordedAt: new Date(NOW).toISOString(),
  count: 1, score: 0.9, timing: 'stream',
});
const checkpoint = { present: true, frameKey: 'frame2', lastObservedAt: new Date(NOW).toISOString(), lastNotificationAt: new Date(NOW).toISOString() };
async function fixture(t, overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'cam-detection-store-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return { eventsRoot: path.join(temporary, 'events'), cameraIds: ['cam1', 'cam2'], detectionEnabled: true,
    eventRetentionDays: 7, eventMaxCount: 20_000, recordingUtcOffset: '+08:00', ...overrides };
}

test('atomic store persists events, enabled settings and episode checkpoint across restart', async (t) => {
  const config = await fixture(t);
  const store = createEventStore(config, { now: () => NOW });
  await store.init();
  assert.equal(store.enabled('cam1'), true);
  assert.equal(store.enabled('cam2'), true);
  await store.commit('cam1', { event: event(), checkpoint });
  await store.commit('cam2', { enabled: false });
  await store.close();
  const restarted = createEventStore(config, { now: () => NOW });
  await restarted.init();
  assert.deepEqual(restarted.list().events, [event()]);
  assert.deepEqual(restarted.checkpoint('cam1'), checkpoint);
  assert.equal(restarted.enabled('cam2'), false);
  assert.deepEqual(await fs.readdir(config.eventsRoot), ['events.json']);
  await restarted.ready();
});

test('estimated event timestamps and precision survive persistence and restart alongside stream events', async (t) => {
  const config = await fixture(t);
  const estimated = { ...event('estimated', '2026-10-04T11:59:58.000Z'), timing: 'estimated' };
  const store = createEventStore(config, { now: () => NOW });
  await store.init();
  await store.commit('cam1', { event: estimated });
  await store.commit('cam1', { event: event() });
  await store.close();
  const restarted = createEventStore(config, { now: () => NOW });
  await restarted.init();
  assert.deepEqual(restarted.list().events, [event(), estimated]);
});

test('events are published only after rename; failed writes retain the prior durable state and can retry', async (t) => {
  const config = await fixture(t);
  let fail = false;
  const filesystem = { ...fs, rename: async (...args) => {
    if (fail) throw Object.assign(new Error('private-volume-path'), { code: 'EIO' });
    return fs.rename(...args);
  } };
  const store = createEventStore(config, { filesystem, now: () => NOW });
  await store.init();
  const before = await fs.readFile(path.join(config.eventsRoot, 'events.json'), 'utf8');
  fail = true;
  await assert.rejects(store.commit('cam1', { event: event(), checkpoint }), { code: 'EIO' });
  assert.equal(store.list().total, 0);
  assert.equal(store.checkpoint('cam1').present, false);
  assert.equal(await fs.readFile(path.join(config.eventsRoot, 'events.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(config.eventsRoot), ['events.json']);
  assert.equal(store.failure.code, 'EIO');
  fail = false;
  await store.commit('cam1', { event: event(), checkpoint });
  assert.equal(store.list().total, 1);
  assert.equal(store.failure, null);
});

test('simultaneous commits serialize without losing settings/events and duplicate IDs stay unique', async (t) => {
  const config = await fixture(t);
  const store = createEventStore(config, { now: () => NOW });
  await store.init();
  await Promise.all([
    store.commit('cam1', { event: event() }),
    store.commit('cam2', { enabled: false, event: event('event2', undefined, 'cam2') }),
    store.commit('cam1', { event: event(), checkpoint }),
  ]);
  assert.equal(store.list().total, 2);
  assert.equal(store.enabled('cam2'), false);
  assert.deepEqual(store.checkpoint('cam1'), checkpoint);
  const returned = store.list().events;
  returned[0].count = 99;
  assert.equal(store.list().events[0].count, 1);
});

test('retention and count limits are applied on writes, reads and restart; date filters use recording timezone', async (t) => {
  let now = NOW;
  const config = await fixture(t, { eventMaxCount: 2 });
  const store = createEventStore(config, { now: () => now });
  await store.init();
  await store.commit('cam1', { event: event('expired', new Date(NOW - 8 * 86_400_000).toISOString()) });
  await store.commit('cam1', { event: event('oldest', '2026-10-02T15:59:59.000Z') });
  await store.commit('cam1', { event: event('localOct3', '2026-10-02T16:00:00.000Z') });
  await store.commit('cam2', { event: event('latest', '2026-10-03T16:00:00.000Z', 'cam2') });
  assert.deepEqual(store.list().events.map((item) => item.id), ['latest', 'localOct3']);
  assert.deepEqual(store.list({ date: '2026-10-03' }).events.map((item) => item.id), ['localOct3']);
  assert.equal(store.list({ cameraId: 'cam2', limit: 1, offset: 1 }).events.length, 0);
  assert.equal(store.list({ cameraId: 'cam2', limit: 1, offset: 1 }).total, 1);
  now += 8 * 86_400_000;
  assert.equal(store.list().total, 0);
  await store.prune();
  const restarted = createEventStore(config, { now: () => now });
  await restarted.init();
  assert.equal(restarted.list().total, 0);
});

test('corrupt or unsupported snapshots fail visibly without overwriting stored bytes', async (t) => {
  const config = await fixture(t);
  await fs.mkdir(config.eventsRoot);
  const filename = path.join(config.eventsRoot, 'events.json');
  for (const contents of ['{truncated', JSON.stringify({ version: 2, events: [] }),
    JSON.stringify({ version: 1, settings: { cam1: 'yes' }, checkpoints: {}, events: [] }),
    JSON.stringify({ version: 1, settings: {}, checkpoints: {}, events: [event(), event()] })]) {
    await fs.writeFile(filename, contents);
    const store = createEventStore(config);
    await assert.rejects(store.init(), { code: 'EVENT_STORE_CORRUPT' });
    await assert.rejects(store.ready(), { code: 'EVENT_STORE_CORRUPT' });
    assert.equal(await fs.readFile(filename, 'utf8'), contents);
  }
});

test('readiness verifies actual write/fsync access and recovers after a storage outage', async (t) => {
  const config = await fixture(t);
  let fail = false;
  const store = createEventStore(config, { filesystem: { ...fs, open: async (...args) => {
    if (fail && args[1] === 'wx') throw Object.assign(new Error('read only'), { code: 'EROFS' });
    return fs.open(...args);
  } } });
  await store.init();
  fail = true;
  await assert.rejects(store.ready(), { code: 'EROFS' });
  assert.equal(store.failure.code, 'EROFS');
  fail = false;
  await store.ready();
  assert.equal(store.failure, null);
});

test('invalid event/checkpoint writes are rejected before changing storage', async (t) => {
  const config = await fixture(t);
  const store = createEventStore(config, { now: () => NOW });
  await store.init();
  await assert.rejects(store.commit('cam1', { event: { ...event(), score: NaN } }), TypeError);
  for (const timing of [undefined, null, 'unknown', 'STREAM', 1]) {
    await assert.rejects(store.commit('cam1', { event: { ...event(), timing } }), TypeError);
  }
  await assert.rejects(store.commit('cam1', { checkpoint: { ...checkpoint, lastObservedAt: 'tomorrow' } }), TypeError);
  await assert.rejects(store.commit('other', { enabled: true }), /Unknown/);
  assert.equal(store.list().total, 0);
});
