import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDetectionModel } from './detection-runtime-model.js';
import { readLatestDetectionSegment, decodeDetectionFrame, MAX_FRAME_AGE_MS } from './detection-runtime-media.js';

/** One serialized server loop: no browser lifecycle, frame queue, or camera credentials. */
export function createDetectionRuntime({
  dataRoot, cameraIds, intervalMs = 2000, isEnabled, getRevision = () => 0, onObservation, onStatus,
  modelPath = path.resolve('models/person/model.json'),
}, dependencies = {}) {
  const readSegment = dependencies.readSegment ?? readLatestDetectionSegment;
  const decode = dependencies.decode ?? decodeDetectionFrame;
  const createModel = dependencies.createModel ?? createDetectionModel;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  if (!Array.isArray(cameraIds) || cameraIds.some((id) => !/^[a-z][a-z0-9_-]{0,31}$/.test(id))) throw new Error('Invalid detection cameras');
  if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error('Invalid detection interval');
  const states = new Map(cameraIds.map((id) => [id, { frameKey: null, lastTime: -Infinity, retryAt: 0, failures: 0, statusKey: '' }]));
  let controller;
  let loop;
  let model;
  let modelReady = false;
  let stopped = false;
  function status(id, state, extra = {}) {
    const value = { state, ...extra };
    const key = JSON.stringify(value);
    if (states.get(id).statusKey === key) return;
    states.get(id).statusKey = key;
    onStatus(id, value);
  }
  async function run() {
    while (!controller.signal.aborted) {
      let anyEnabled = false;
      for (const [id, state] of states) {
        if (controller.signal.aborted) break;
        if (!isEnabled(id)) continue;
        anyEnabled = true;
        if (now() < state.retryAt) continue;
        const revision = getRevision(id);
        const valid = () => !controller.signal.aborted && isEnabled(id) && getRevision(id) === revision;
        let modelFailed = false;
        try {
          const segment = await readSegment(dataRoot, id, now());
          if (!valid()) continue;
          if (!segment) {
            status(id, 'waiting', { message: 'Waiting for a fresh timestamped stream frame' });
            continue;
          }
          if (segment.frameKey === state.frameKey || segment.occurredAtMs <= state.lastTime) {
            if (now() - state.lastTime <= MAX_FRAME_AGE_MS) status(id, 'watching', { lastFrameAt: new Date(state.lastTime).toISOString() });
            continue;
          }
          if (!model) { modelReady = false; model = createModel({ modelPath }); }
          if (!modelReady) status(id, 'starting');
          try { await model.ready; } catch (error) { modelFailed = true; throw error; }
          modelReady = true;
          if (!valid()) continue;
          // A slow model start can outlive this segment. Never backfill stale frames.
          if (now() - segment.occurredAtMs > MAX_FRAME_AGE_MS) { status(id, 'waiting'); continue; }
          const pixels = await decode(segment, { signal: controller.signal });
          if (!valid()) continue;
          let predictions;
          try { predictions = await model.detect(pixels); } catch (error) { modelFailed = true; throw error; }
          if (!valid()) continue;
          if (now() - segment.occurredAtMs > MAX_FRAME_AGE_MS) { status(id, 'waiting'); continue; }
          await onObservation(id, { occurredAt: segment.occurredAt, predictions, timing: 'stream', frameKey: segment.frameKey });
          // Persistence may queue behind a settings change; it can discard this
          // observation, so do not commit its cursor/status to the new generation.
          if (!valid()) continue;
          state.frameKey = segment.frameKey;
          state.lastTime = segment.occurredAtMs;
          state.failures = 0;
          state.retryAt = 0;
          status(id, 'watching', { lastFrameAt: segment.occurredAt });
        } catch {
          if (controller.signal.aborted) break;
          // A missing/bad stream on one camera must not unload the model used by others.
          if (modelFailed && model) { await model.stop(); model = null; modelReady = false; }
          if (!valid()) continue;
          state.failures = Math.min(state.failures + 1, 5);
          state.retryAt = now() + Math.min(30_000, intervalMs * 2 ** state.failures);
          status(id, 'error', { message: 'Detection is retrying; check stream, decoder, and model availability' });
        }
      }
      if (!anyEnabled && model) { await model.stop(); model = null; modelReady = false; }
      await wait(intervalMs, controller.signal).catch(() => {});
    }
  }
  return {
    start() {
      if (loop || stopped) return;
      controller = new AbortController();
      loop = run();
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await model?.stop();
      await loop;
      model = null;
    },
  };
}
