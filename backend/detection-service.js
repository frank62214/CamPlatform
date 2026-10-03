import { createHash } from 'node:crypto';
import { createPersonPresence } from '../src/detection/person-presence.js';
import { createEventStore } from './detection-store.js';
import { HttpError } from './errors.js';

const STORAGE_MESSAGE = 'Person event storage is unavailable; detection will retry';
const STATES = new Set(['starting', 'watching', 'waiting', 'error']);
const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Seed only committed episode/cooldown state, never publish these synthetic samples.
function restoredGate(checkpoint) {
  const gate = createPersonPresence();
  if (checkpoint.lastNotificationAt) {
    const time = Date.parse(checkpoint.lastNotificationAt);
    gate.update([{ class: 'person', score: 1 }], time - 1);
    gate.update([{ class: 'person', score: 1 }], time);
    if (!checkpoint.present) gate.reset();
  }
  return gate;
}

/** One service owns the store and runtime, independently of HTTP/browser clients. */
export function createDetectionService(config, { store = createEventStore(config), runtimeFactory, now = Date.now } = {}) {
  const cameras = new Map(config.cameraIds.map((cameraId) => [cameraId, {
    cameraId, revision: 0, state: config.detectionEnabled ? 'starting' : 'disabled',
    present: false, count: 0, lastFrameAt: null, lastEventAt: null,
    checkpoint: null, gate: null, candidate: null, pending: null,
    lastSeen: -Infinity, frameKey: null, message: undefined,
  }]));
  let runtime;
  let started = false;
  let stopping = false;
  let maintenance;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const enabled = (id) => Boolean(config.detectionEnabled && started && !stopping && store.enabled(id));
  const camera = (id) => {
    if (!cameras.has(id)) throw new HttpError(404, 'CAMERA_NOT_FOUND', 'Camera not found');
    return cameras.get(id);
  };
  const unavailable = () => new HttpError(503, 'EVENT_STORAGE_UNAVAILABLE', STORAGE_MESSAGE);

  function cameraStatus(id) {
    const value = camera(id);
    const configured = config.detectionEnabled && started ? store.enabled(id) : false;
    const storageFailed = configured && (store.failure || value.pending);
    return {
      cameraId: id, enabled: configured,
      state: !configured ? 'disabled' : storageFailed ? 'error' : value.state,
      present: configured && value.present, count: configured ? value.count : 0,
      lastFrameAt: value.lastFrameAt, lastEventAt: value.lastEventAt,
      ...(storageFailed ? { message: STORAGE_MESSAGE } : value.message && configured ? { message: value.message } : {}),
    };
  }

  async function flush(value) {
    if (!value.pending) return true;
    try {
      const { change, view } = value.pending;
      const result = await store.commit(value.cameraId, change);
      value.checkpoint = change.checkpoint;
      Object.assign(value, view);
      if (result.event) value.lastEventAt = result.event.occurredAt;
      value.pending = null;
      return true;
    } catch { return false; }
  }

  function onObservation(id, observation) {
    const revision = camera(id).revision;
    return serialize(async () => {
      const value = camera(id);
      if (!enabled(id) || revision !== value.revision) return;
      if (!await flush(value)) return;
      if (!observation || !instant(observation.occurredAt) || !['stream', 'estimated'].includes(observation.timing) ||
          typeof observation.frameKey !== 'string' || !observation.frameKey.length || observation.frameKey.length > 512 ||
          !Array.isArray(observation.predictions)) return;
      const time = Date.parse(observation.occurredAt);
      if (observation.frameKey === value.frameKey || time <= value.lastSeen) return;
      // A real gap interrupts tentative positives, but does not invent an exit from
      // a committed presence episode or bypass its persisted alert cooldown.
      if (time - value.lastSeen >= 30_000 && !value.present) {
        value.gate = restoredGate(value.checkpoint);
        value.candidate = null;
      }
      value.frameKey = observation.frameKey;
      value.lastSeen = time;
      const result = value.gate.update(observation.predictions, time);
      if (!value.present && result.count > 0 && !value.candidate) {
        value.candidate = { occurredAt: observation.occurredAt, frameKey: observation.frameKey, timing: observation.timing };
      } else if (!value.present && result.count === 0) value.candidate = null;
      const view = { present: result.present, count: result.count, lastFrameAt: observation.occurredAt };
      if (result.present !== value.present || result.notify) {
        const checkpoint = {
          present: result.present, frameKey: observation.frameKey, lastObservedAt: observation.occurredAt,
          lastNotificationAt: result.notify ? observation.occurredAt : value.checkpoint.lastNotificationAt,
        };
        const change = { checkpoint };
        if (result.notify) {
          const first = value.candidate ?? { occurredAt: observation.occurredAt, frameKey: observation.frameKey, timing: observation.timing };
          const digest = createHash('sha256').update(`${id}\0${first.frameKey}\0${first.occurredAt}`).digest('hex');
          change.event = {
            id: `person_${digest}`, cameraId: id, cameraName: ({ cam1: '客廳', cam2: '大門' })[id] ?? id,
            occurredAt: first.occurredAt, recordedAt: new Date(now()).toISOString(),
            count: Math.min(result.count, 100), score: result.score,
            timing: first.timing === 'estimated' || observation.timing === 'estimated' ? 'estimated' : 'stream',
          };
        }
        value.pending = { change, view };
        if (!await flush(value)) return;
      } else Object.assign(value, view);
      if (!result.present && !result.count) value.candidate = null;
    });
  }

  function onStatus(id, status) {
    const value = cameras.get(id);
    if (!value || !enabled(id) || !STATES.has(status.state)) return;
    value.state = status.state;
    value.message = typeof status.message === 'string' ? status.message.slice(0, 240) : undefined;
    if (instant(status.lastFrameAt)) value.lastFrameAt = status.lastFrameAt;
    if (status.state === 'error' && !value.present && !value.pending) {
      value.gate = restoredGate(value.checkpoint);
      value.candidate = null;
    }
  }

  return {
    async start() {
      if (started || stopping) return;
      if (!config.detectionEnabled) { started = true; return; }
      await store.init();
      for (const [id, value] of cameras) {
        value.checkpoint = store.checkpoint(id);
        value.gate = restoredGate(value.checkpoint);
        value.present = value.checkpoint.present;
        value.frameKey = value.checkpoint.frameKey;
        value.lastSeen = value.checkpoint.lastObservedAt ? Date.parse(value.checkpoint.lastObservedAt) : -Infinity;
        value.lastFrameAt = value.checkpoint.lastObservedAt;
        value.lastEventAt = store.list({ cameraId: id, limit: 1 }).events[0]?.occurredAt ?? null;
        value.state = store.enabled(id) ? 'starting' : 'disabled';
      }
      started = true;
      maintenance = setInterval(() => {
        void serialize(async () => {
          for (const value of cameras.values()) await flush(value);
          await store.prune();
        }).catch(() => {});
      }, 60_000);
      maintenance.unref?.();
      try {
        const factory = runtimeFactory ?? (await import('./detection-runtime.js')).createDetectionRuntime;
        runtime = factory({ dataRoot: config.dataRoot, cameraIds: config.cameraIds, intervalMs: config.detectionIntervalMs,
          isEnabled: enabled, getRevision: (id) => camera(id).revision, onObservation, onStatus });
        runtime.start();
      } catch {
        for (const id of cameras.keys()) onStatus(id, { state: 'error', message: 'Person detection could not start; check the local model and runtime' });
      }
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(maintenance);
      for (const value of cameras.values()) value.revision++;
      await runtime?.stop();
      await queue;
      for (const value of cameras.values()) await flush(value);
      await store.close();
    },
    async ready() {
      if (!config.detectionEnabled) return;
      if (!started) throw unavailable();
      await store.ready();
    },
    status: () => ({ enabled: Boolean(config.detectionEnabled), retentionDays: config.eventRetentionDays,
      cameras: config.cameraIds.map(cameraStatus) }),
    events(query = {}) {
      if (!config.detectionEnabled) return { events: [], total: 0, limit: query.limit ?? 50, offset: query.offset ?? 0, retentionDays: config.eventRetentionDays };
      if (!started) throw unavailable();
      return store.list(query);
    },
    setEnabled(id, value) {
      camera(id);
      if (!config.detectionEnabled || !started) throw new HttpError(409, 'DETECTION_DISABLED', 'Server person detection is disabled');
      if (typeof value !== 'boolean') throw new HttpError(400, 'INVALID_SETTING', 'enabled must be a boolean');
      return serialize(async () => {
        const current = camera(id);
        if (!await flush(current)) throw unavailable();
        if (store.enabled(id) === value) return cameraStatus(id);
        const checkpoint = { ...current.checkpoint, present: false };
        try { await store.commit(id, { enabled: value, checkpoint }); } catch { throw unavailable(); }
        current.revision++;
        current.checkpoint = checkpoint;
        current.gate = restoredGate(checkpoint);
        current.present = false;
        current.count = 0;
        current.candidate = null;
        current.state = value ? 'starting' : 'disabled';
        current.message = undefined;
        return cameraStatus(id);
      });
    },
  };
}
