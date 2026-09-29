import { HttpError } from './errors.js';

const DAY_MS = 86_400_000;
const WINDOW_MS = 10_000;
const ACTIVE_WRITE_GRACE_MS = 120_000;
const MAX_BOXES = 10_000;

// Only box headers and the fixed-size mvhd prefix are read. In particular, mdat
// (which can be several GB) is always skipped with a file offset.
export async function readMp4Metadata(handle, size) {
  const empty = { complete: false, durationSeconds: null };
  if (!Number.isSafeInteger(size) || size < 8) return empty;
  let boxes = 0;
  async function boxAt(position, end) {
    if (++boxes > MAX_BOXES || end - position < 8) return null;
    const header = Buffer.alloc(16);
    if ((await handle.read(header, 0, 8, position)).bytesRead !== 8) return null;
    let length = header.readUInt32BE(0);
    let headerLength = 8;
    if (length === 1) {
      if (end - position < 16 || (await handle.read(header, 8, 8, position + 8)).bytesRead !== 8) return null;
      const extended = header.readBigUInt64BE(8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      length = Number(extended);
      headerLength = 16;
    } else if (length === 0) {
      length = end - position;
    }
    if (length < headerLength || length > end - position) return null;
    return { type: header.toString('ascii', 4, 8), start: position + headerLength, end: position + length };
  }
  async function movieDuration(start, end) {
    for (let position = start; position < end;) {
      const box = await boxAt(position, end);
      if (!box) return null;
      if (box.type === 'mvhd') {
        const length = Math.min(32, box.end - box.start);
        if (length < 20) return null;
        const data = Buffer.alloc(length);
        if ((await handle.read(data, 0, length, box.start)).bytesRead !== length) return null;
        const version = data[0];
        if (version !== 0 && version !== 1 || version === 1 && length < 32) return null;
        const timescale = data.readUInt32BE(version === 1 ? 20 : 12);
        const duration = version === 1 ? data.readBigUInt64BE(24) : BigInt(data.readUInt32BE(16));
        const unknown = version === 1 ? 0xffffffffffffffffn : 0xffffffffn;
        if (!timescale || duration === 0n || duration === unknown || duration > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        const seconds = Number(duration) / timescale;
        // Milliseconds must remain safe when added to a wall-clock timestamp.
        return Number.isFinite(seconds) && seconds * 1000 < Number.MAX_SAFE_INTEGER / 2 ? seconds : null;
      }
      position = box.end;
    }
    return null;
  }

  let position = 0;
  let moov = false;
  let mdat = false;
  let ftyp = false;
  let durationSeconds = null;
  while (position < size) {
    const box = await boxAt(position, size);
    if (!box) return empty;
    if (box.type === 'moov') {
      moov = true;
      durationSeconds = await movieDuration(box.start, box.end);
    }
    if (box.type === 'mdat') mdat = true;
    if (box.type === 'ftyp') ftyp = true;
    position = box.end;
  }
  return { complete: moov && mdat && ftyp, durationSeconds };
}

export function parseEventTime(value) {
  const fail = () => { throw new HttpError(400, 'INVALID_EVENT_TIME', 'Use an ISO timestamp with a timezone between 1970 and 2100'); };
  if (typeof value !== 'string' || value.length > 29) return fail();
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return fail();
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return fail();
  if (match[5] !== 'Z' && match[5].slice(1, 3) === '14' && match[5].slice(4) !== '00') return fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < Date.UTC(1970, 0, 1) || time >= Date.UTC(2101, 0, 1)) return fail();
  return time;
}

export function recordingTime(date, name, offset) {
  // Segment recorder restarts append a process UUID. Keep the original capture
  // time, supporting legacy hour/minute and compact HHMMSS names as well.
  const match = /^(?:(\d{4}-\d{2}-\d{2})_)?([01]\d|2[0-3])(?:[-_]?([0-5]\d)(?:[-_]?([0-5]\d))?)?(?:_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\.mp4$/i.exec(name);
  if (!match || match[1] && match[1] !== date) return null;
  const time = `${match[2]}:${match[3] ?? '00'}:${match[4] ?? '00'}`;
  const timeStamp = `${date}T${time}${offset}`;
  const startMs = Date.parse(timeStamp);
  const timePrecision = match[4] ? 'second' : match[3] ? 'minute' : 'hour';
  return Number.isFinite(startMs) ? { startMs, approximate: timePrecision !== 'second', time, timePrecision, timeStamp } : null;
}

export function isRecordingActive(modifiedMs, now = Date.now()) {
  return modifiedMs >= now - ACTIVE_WRITE_GRACE_MS && modifiedMs <= now + 60_000;
}

export function createEventClips(media, config) {
  const offset = config.recordingUtcOffset;
  const offsetMs = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000 * (offset[0] === '-' ? -1 : 1);
  return async function eventClip(cameraId, at, now = Date.now()) {
    const center = parseEventTime(at);
    const localDay = Math.floor((center + offsetMs) / DAY_MS) * DAY_MS;
    // The recorder rotates at least daily; include either side of midnight.
    const days = [-1, 0, 1].map((delta) => new Date(localDay + delta * DAY_MS).toISOString().slice(0, 10));
    const files = (await media.eventRecordings(cameraId, days)).sort((a, b) => a.startMs - b.startMs || Number(a.approximate) - Number(b.approximate));
    const available = files.filter((file) => file.complete && Number.isFinite(file.durationSeconds) && file.durationSeconds > 0)
      .map((file) => ({ ...file, endMs: file.startMs + file.durationSeconds * 1000 }));
    const containing = available.find((file) => file.startMs <= center && center < file.endMs);
    if (!containing) {
      // A matching abandoned/truncated file will never become playable. Only
      // report it as pending while its recent mtime still suggests active writes.
      const unfinished = files.some((file) => !file.complete && file.startMs <= center && center < file.startMs + 3_600_000 &&
        center <= file.modifiedMs + WINDOW_MS && isRecordingActive(file.modifiedMs, now));
      const recent = center >= now - 60_000 && center <= now + 60_000;
      return { status: unfinished || recent ? 'pending' : 'unavailable', parts: [], approximate: false,
        message: unfinished || recent ? 'Recording is not available yet' : 'No recording covers this event' };
    }

    const from = center - WINDOW_MS;
    const to = center + WINDOW_MS;
    const parts = [];
    let cursor = from;
    let partial = false;
    let approximate = false;
    for (const file of available) {
      const startMs = Math.max(from, file.startMs, cursor);
      const endMs = Math.min(to, file.endMs);
      if (endMs <= startMs) continue;
      if (startMs > cursor + 1) partial = true;
      parts.push({ record: file.record,
        startSeconds: Math.max(0, (startMs - file.startMs) / 1000),
        endSeconds: Math.min(file.durationSeconds, (endMs - file.startMs) / 1000) });
      approximate ||= file.approximate;
      cursor = endMs;
      if (cursor >= to) break;
    }
    partial ||= cursor < to - 1;
    return { status: 'ready', parts, approximate, partial };
  };
}
