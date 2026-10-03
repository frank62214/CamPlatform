import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;
const cameraId = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const emptyCheckpoint = () => ({ present: false, frameKey: null, lastObservedAt: null, lastNotificationAt: null });
const corrupt = () => Object.assign(new Error('Person event store is corrupt or has an unsupported format'), { code: 'EVENT_STORE_CORRUPT' });

function validCheckpoint(value) {
  return object(value) && typeof value.present === 'boolean' &&
    (value.frameKey === null || typeof value.frameKey === 'string' && value.frameKey.length > 0 && value.frameKey.length <= 512) &&
    (value.lastObservedAt === null || instant(value.lastObservedAt)) &&
    (value.lastNotificationAt === null || instant(value.lastNotificationAt));
}

function validEvent(value) {
  return object(value) && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.id) && cameraId(value.cameraId) &&
    typeof value.cameraName === 'string' && value.cameraName.length > 0 && value.cameraName.length <= 200 &&
    instant(value.occurredAt) && instant(value.recordedAt) && value.timing === 'stream' &&
    Number.isInteger(value.count) && value.count > 0 && value.count <= 100 &&
    Number.isFinite(value.score) && value.score >= 0.6 && value.score <= 1;
}

function validate(snapshot) {
  if (!object(snapshot) || snapshot.version !== 1 || !object(snapshot.settings) || !object(snapshot.checkpoints) ||
    !Array.isArray(snapshot.events) || snapshot.events.length > 100_000 ||
    Object.keys(snapshot.settings).length > 128 || Object.keys(snapshot.checkpoints).length > 128) throw corrupt();
  if (Object.entries(snapshot.settings).some(([id, enabled]) => !cameraId(id) || typeof enabled !== 'boolean') ||
    Object.entries(snapshot.checkpoints).some(([id, checkpoint]) => !cameraId(id) || !validCheckpoint(checkpoint)) ||
    snapshot.events.some((event) => !validEvent(event)) ||
    new Set(snapshot.events.map((event) => event.id)).size !== snapshot.events.length) throw corrupt();
  return snapshot;
}

/** One process owns this store. The backend Deployment must retain one Recreate replica. */
export function createEventStore(config, { filesystem = fs, now = Date.now } = {}) {
  const root = path.resolve(config.eventsRoot);
  const filename = path.join(root, 'events.json');
  let snapshot = { version: 1, settings: {}, checkpoints: {}, events: [] };
  let initialized = false;
  let initialization;
  let queue = Promise.resolve();
  let failure = null;

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function retained(events) {
    const cutoff = now() - config.eventRetentionDays * DAY_MS;
    return events.filter((event) => Date.parse(event.occurredAt) >= cutoff)
      .sort((first, second) => second.occurredAt.localeCompare(first.occurredAt) || second.id.localeCompare(first.id))
      .slice(0, config.eventMaxCount);
  }

  async function write(next) {
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Person event store exceeds its size limit');
    const temporary = path.join(root, `.events-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await filesystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await filesystem.rename(temporary, filename);
      snapshot = next;
      failure = null;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await filesystem.unlink(temporary).catch(() => {});
    }
  }

  async function probe() {
    const temporary = path.join(root, `.writable-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await filesystem.open(temporary, 'wx', 0o600);
      await handle.writeFile('ok');
      await handle.sync();
      await handle.close();
      handle = null;
      await filesystem.unlink(temporary);
      failure = null;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await filesystem.unlink(temporary).catch(() => {});
    }
  }

  async function init() {
    initialization ??= serialize(async () => {
      try {
        await filesystem.mkdir(root, { recursive: true, mode: 0o700 });
        const rootStat = await filesystem.lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Person event storage must be a regular directory');
        let existing = false;
        let handle;
        try {
          const stat = await filesystem.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw corrupt();
          handle = await filesystem.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > MAX_BYTES) throw corrupt();
          let data;
          try { data = JSON.parse(await handle.readFile('utf8')); } catch { throw corrupt(); }
          snapshot = validate(data);
          existing = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        } finally { await handle?.close(); }
        const next = structuredClone(snapshot);
        for (const id of config.cameraIds) {
          if (!Object.hasOwn(next.settings, id)) next.settings[id] = Boolean(config.detectionEnabled);
          if (!Object.hasOwn(next.checkpoints, id)) next.checkpoints[id] = emptyCheckpoint();
        }
        next.events = retained(next.events);
        if (!existing || JSON.stringify(next) !== JSON.stringify(snapshot)) await write(next);
        else await probe();
        initialized = true;
      } catch (error) { failure = error; throw error; }
    });
    return initialization;
  }

  function checkReady() {
    if (!initialized) throw failure ?? new Error('Person event storage has not started');
  }

  async function commit(id, change) {
    checkReady();
    if (!config.cameraIds.includes(id)) throw new Error('Unknown detection camera');
    if (change.enabled !== undefined && typeof change.enabled !== 'boolean') throw new TypeError('Invalid detection setting');
    if (change.checkpoint !== undefined && !validCheckpoint(change.checkpoint)) throw new TypeError('Invalid detection checkpoint');
    if (change.event !== undefined && (!validEvent(change.event) || change.event.cameraId !== id)) throw new TypeError('Invalid person event');
    return serialize(async () => {
      const next = structuredClone(snapshot);
      if (change.enabled !== undefined) next.settings[id] = change.enabled;
      if (change.checkpoint !== undefined) next.checkpoints[id] = structuredClone(change.checkpoint);
      let added = false;
      if (change.event && !next.events.some((event) => event.id === change.event.id)) {
        next.events.push(structuredClone(change.event));
        added = true;
      }
      next.events = retained(next.events);
      if (JSON.stringify(next) !== JSON.stringify(snapshot)) await write(next);
      else if (failure) await probe();
      return { added, event: change.event ? structuredClone(snapshot.events.find((event) => event.id === change.event.id) ?? null) : null };
    });
  }

  return {
    init,
    ready: () => serialize(async () => { checkReady(); await probe(); }),
    close: async () => { await queue; },
    get failure() { return failure; },
    enabled(id) { checkReady(); return snapshot.settings[id] === true; },
    checkpoint(id) { checkReady(); return structuredClone(snapshot.checkpoints[id] ?? emptyCheckpoint()); },
    commit,
    async prune() {
      checkReady();
      return serialize(async () => {
        const events = retained(snapshot.events);
        if (events.length !== snapshot.events.length) await write({ ...snapshot, events });
      });
    },
    list({ cameraId: id, date, limit = 50, offset = 0 } = {}) {
      checkReady();
      const zone = config.recordingUtcOffset;
      const offsetMs = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000 * (zone[0] === '-' ? -1 : 1);
      const events = retained(snapshot.events).filter((event) => (!id || event.cameraId === id) &&
        (!date || new Date(Date.parse(event.occurredAt) + offsetMs).toISOString().slice(0, 10) === date));
      return { events: structuredClone(events.slice(offset, offset + limit)), total: events.length,
        limit, offset, retentionDays: config.eventRetentionDays };
    },
  };
}
