import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createDetectionService } from '../backend/detection-service.js';
import { createEventStore } from '../backend/detection-store.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const person = [{ class: 'person', score: 0.9, bbox: [1, 2, 3, 4] }];
const observation = (second, predictions = person, frameKey = `frame${second}`) => ({
  occurredAt: new Date(NOW + second * 1000).toISOString(), predictions, frameKey, timing: 'stream',
});
async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'cam-detection-service-'));
  const config = { eventsRoot: path.join(temporary, 'events'), dataRoot: path.join(temporary, 'data'),
    cameraIds: ['cam1', 'cam2'], detectionEnabled: true, detectionIntervalMs: 2000,
    eventRetentionDays: 7, eventMaxCount: 20_000, recordingUtcOffset: '+08:00', ...options.config };
  const store = options.store ?? createEventStore(config, { now: () => NOW, ...options.storeOptions });
  let callbacks;
  let starts = 0;
  let stops = 0;
  const service = createDetectionService(config, { store, now: () => NOW,
    runtimeFactory: options.runtimeFactory ?? ((value) => {
      callbacks = value;
      return { start() { starts++; }, async stop() { stops++; } };
    }) });
  t.after(async () => { await service.stop(); await fs.rm(temporary, { recursive: true, force: true }); });
  await service.start();
  return { config, store, service, get callbacks() { return callbacks; }, get starts() { return starts; }, get stops() { return stops; } };
}

test('runtime starts without any HTTP clients and confirmed event preserves first positive stream timestamp', async (t) => {
  const { service, callbacks, starts } = await fixture(t);
  assert.equal(starts, 1);
  assert.equal(callbacks.isEnabled('cam1'), true);
  await callbacks.onObservation('cam1', observation(0));
  assert.equal(service.events().total, 0);
  callbacks.onStatus('cam1', { state: 'starting' });
  callbacks.onStatus('cam1', { state: 'waiting' });
  await callbacks.onObservation('cam1', observation(2));
  const [event] = service.events().events;
  assert.equal(event.occurredAt, observation(0).occurredAt);
  assert.equal(event.timing, 'stream');
  assert.equal(event.count, 1);
  assert.equal(event.score, 0.9);
  assert.equal(service.status().cameras[0].present, true);
  assert.equal(service.status().cameras[0].lastEventAt, event.occurredAt);
});

test('duplicate/reordered frames do not confirm presence or generate repeated events', async (t) => {
  const { service, callbacks } = await fixture(t);
  await callbacks.onObservation('cam1', observation(0));
  await callbacks.onObservation('cam1', observation(0));
  await callbacks.onObservation('cam1', observation(-1));
  await callbacks.onObservation('cam1', observation(1, person, 'frame0'));
  assert.equal(service.events().total, 0);
  await callbacks.onObservation('cam1', observation(2));
  await callbacks.onObservation('cam1', observation(4));
  await callbacks.onObservation('cam1', observation(2));
  assert.equal(service.events().total, 1);
});

test('three negative samples end presence and the 15 second cooldown suppresses immediate re-entry', async (t) => {
  const { service, callbacks } = await fixture(t);
  for (const second of [0, 2]) await callbacks.onObservation('cam1', observation(second));
  for (const second of [4, 6]) await callbacks.onObservation('cam1', observation(second, []));
  assert.equal(service.status().cameras[0].present, true);
  await callbacks.onObservation('cam1', observation(8, []));
  assert.equal(service.status().cameras[0].present, false);
  for (const second of [10, 12]) await callbacks.onObservation('cam1', observation(second));
  assert.equal(service.events().total, 1);
  for (const second of [14, 16, 18]) await callbacks.onObservation('cam1', observation(second, []));
  for (const second of [20, 22]) await callbacks.onObservation('cam1', observation(second));
  assert.equal(service.events().total, 2);
  assert.equal(service.events().events[0].occurredAt, observation(20).occurredAt);
});

test('restart preserves enabled settings, confirmed presence and cooldown without duplicate episode', async (t) => {
  const { service, callbacks, config } = await fixture(t);
  for (const second of [0, 2]) await callbacks.onObservation('cam1', observation(second));
  await service.setEnabled('cam2', false);
  await service.stop();
  let next;
  const restarted = createDetectionService(config, { now: () => NOW,
    store: createEventStore(config, { now: () => NOW }), runtimeFactory: (value) => {
      next = value; return { start() {}, async stop() {} };
    } });
  t.after(() => restarted.stop());
  await restarted.start();
  assert.equal(next.isEnabled('cam2'), false);
  for (const second of [2, 4, 6]) await next.onObservation('cam1', observation(second));
  assert.equal(restarted.events().total, 1);
  assert.equal(restarted.status().cameras[0].present, true);
  for (const second of [8, 10, 12]) await next.onObservation('cam1', observation(second, []));
  for (const second of [13, 14]) await next.onObservation('cam1', observation(second));
  assert.equal(restarted.events().total, 1);
});

test('storage write failure is visible, does not announce an event, and retries the same event exactly once', async (t) => {
  let fail = false;
  const { service, callbacks } = await fixture(t, { storeOptions: { filesystem: { ...fs,
    rename: async (...args) => {
      if (fail) throw Object.assign(new Error('private storage detail'), { code: 'EIO' });
      return fs.rename(...args);
    },
  } } });
  await callbacks.onObservation('cam1', observation(0));
  fail = true;
  await callbacks.onObservation('cam1', observation(2));
  callbacks.onStatus('cam1', { state: 'watching', lastFrameAt: observation(2).occurredAt });
  assert.equal(service.events().total, 0);
  assert.equal(service.status().cameras[0].state, 'error');
  assert.equal(service.status().cameras[0].lastEventAt, null);
  assert.equal(service.status().cameras[0].present, false);
  assert.ok(!JSON.stringify(service.status()).includes('private storage detail'));
  fail = false;
  await callbacks.onObservation('cam1', observation(4));
  await callbacks.onObservation('cam1', observation(6));
  assert.equal(service.events().total, 1);
  assert.equal(service.events().events[0].occurredAt, observation(0).occurredAt);
});

test('settings and observations serialize; callback queued before a toggle cannot restore stale presence', async (t) => {
  const { service, callbacks, store } = await fixture(t);
  await callbacks.onObservation('cam1', observation(0));
  const off = service.setEnabled('cam1', false);
  const stale = callbacks.onObservation('cam1', observation(2));
  await off;
  await service.setEnabled('cam1', true);
  await stale;
  assert.equal(callbacks.getRevision('cam1'), 2);
  assert.equal(store.enabled('cam1'), true);
  assert.equal(service.events().total, 0);
  await callbacks.onObservation('cam1', observation(4));
  assert.equal(service.events().total, 0);
  await callbacks.onObservation('cam1', observation(6));
  assert.equal(service.events().events[0].occurredAt, observation(4).occurredAt);
});

test('camera error or 30 second stream gap interrupts tentative positives without inventing a negative observation', async (t) => {
  const { service, callbacks } = await fixture(t);
  await callbacks.onObservation('cam1', observation(0));
  callbacks.onStatus('cam1', { state: 'error' });
  await callbacks.onObservation('cam1', observation(2));
  assert.equal(service.events().total, 0);
  await callbacks.onObservation('cam1', observation(34));
  assert.equal(service.events().total, 0);
  await callbacks.onObservation('cam1', observation(36));
  assert.equal(service.events().events[0].occurredAt, observation(34).occurredAt);
  callbacks.onStatus('cam1', { state: 'error' });
  await callbacks.onObservation('cam1', observation(80));
  assert.equal(service.events().total, 1);
});

test('camera gates are independent and a model failure leaves storage readiness and authenticated APIs usable', async (t) => {
  const { service, callbacks } = await fixture(t);
  await callbacks.onObservation('cam1', observation(0));
  await callbacks.onObservation('cam2', observation(0));
  await callbacks.onObservation('cam1', observation(2, []));
  await callbacks.onObservation('cam2', observation(2));
  assert.equal(service.events({ cameraId: 'cam1' }).total, 0);
  assert.equal(service.events({ cameraId: 'cam2' }).total, 1);
  callbacks.onStatus('cam1', { state: 'error', message: 'Model unavailable' });
  await service.ready();
  assert.equal(service.status().cameras[0].state, 'error');
});

test('disabled service does not touch storage or start a runtime; missing model does not fail startup', async (t) => {
  const disabled = await fixture(t, { config: { detectionEnabled: false }, runtimeFactory() { throw new Error('should not run'); } });
  assert.equal(disabled.service.status().enabled, false);
  assert.equal(disabled.service.events().total, 0);
  await assert.rejects(fs.stat(disabled.config.eventsRoot), { code: 'ENOENT' });
  await disabled.service.ready();
  const modelFailure = await fixture(t, { runtimeFactory() { throw new Error('model unavailable'); } });
  assert.equal(modelFailure.service.status().cameras[0].state, 'error');
  await modelFailure.service.ready();
});
