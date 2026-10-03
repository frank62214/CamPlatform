import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const MAX_FRAME_AGE_MS = 30_000;
const MAX_PLAYLIST_BYTES = 128 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const RGB_BYTES = 320 * 180 * 3;

function parseProgramDateTime(value) {
  // FFmpeg writes offsets such as +0800; ISO producers also use +08:00 or Z.
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):?(\d{2}))$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59 ||
    (parts[6] !== 'Z' && (Number(parts[7]) > 23 || Number(parts[8]) > 59))) return null;
  const day = Date.parse(`${parts[1]}T00:00:00Z`);
  // Date.parse can normalize impossible dates such as February 30; reject those.
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parts[1]) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
}

export function parseDetectionPlaylist(text) {
  if (Buffer.byteLength(text) > MAX_PLAYLIST_BYTES || !text.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  const segments = [];
  let nextTime = null;
  let duration = null;
  let gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      nextTime = parseProgramDateTime(line.slice(25));
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('Invalid HLS duration');
    } else if (line === '#EXT-X-DISCONTINUITY') {
      nextTime = null;
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (/^#EXT-X-(KEY|MAP|BYTERANGE):/.test(line)) {
      throw new Error('Unsupported HLS media format');
    } else if (line && !line.startsWith('#')) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}\.ts$/.test(line) || duration === null) throw new Error('Invalid HLS segment');
      if (!gap) {
        const occurredAtMs = nextTime === null ? null : nextTime + duration * 500;
        segments.push({ name: line, durationSeconds: duration, offsetSeconds: duration / 2, occurredAtMs,
          occurredAt: occurredAtMs === null ? null : new Date(occurredAtMs).toISOString(), frameKey: `${line}:${nextTime}:${duration}` });
      }
      if (nextTime !== null) nextTime += duration * 1000;
      duration = null;
      gap = false;
    }
  }
  return segments;
}

async function boundedRead(file, maxBytes) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) throw new Error('Invalid media file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('Media file changed');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('Incomplete media file');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Media file changed');
    return { bytes: data, mtimeMs: after.mtimeMs };
  } finally { await handle.close(); }
}

export async function readLatestDetectionSegment(dataRoot, cameraId, nowMs = Date.now()) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(cameraId)) throw new Error('Invalid camera');
  const root = path.resolve(dataRoot);
  let directory = root;
  for (const part of ['', cameraId, 'hls']) {
    directory = part ? path.join(directory, part) : directory;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid media directory');
  }
  const actual = await realpath(directory);
  const relative = path.relative(await realpath(root), actual);
  if (relative !== path.join(cameraId, 'hls')) throw new Error('Media escaped storage root');
  const playlist = await boundedRead(path.join(directory, 'stream.m3u8'), MAX_PLAYLIST_BYTES);
  const segment = parseDetectionPlaylist(playlist.bytes.toString('utf8')).at(-1);
  if (!segment) return null;
  const { bytes, mtimeMs } = await boundedRead(path.join(directory, segment.name), MAX_SEGMENT_BYTES);
  const fresh = (stamp) => Number.isFinite(stamp) && nowMs - stamp <= MAX_FRAME_AGE_MS && stamp <= nowMs + 5000;
  // A producer timestamp must never make an old local file look live. Conversely,
  // some live producers drift their PDT clock; label the file-time estimate honestly.
  if (!fresh(mtimeMs)) return null;
  const timing = fresh(segment.occurredAtMs) ? 'stream' : 'estimated';
  const occurredAtMs = timing === 'stream' ? segment.occurredAtMs
    : mtimeMs - (segment.durationSeconds - segment.offsetSeconds) * 1000;
  if (!fresh(occurredAtMs)) return null;
  return { ...segment, bytes, mtimeMs, timing, occurredAtMs, occurredAt: new Date(occurredAtMs).toISOString(),
    // Clock selection can change while a file stays unchanged. The physical
    // sample identity must stay stable so that transition cannot confirm presence.
    frameKey: `${segment.name}:${mtimeMs}:${bytes.length}:${segment.offsetSeconds}` };
}

export function decodeDetectionFrame(segment, { signal, timeoutMs = 10_000, spawnProcess = spawn, ffmpegPath = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Detection stopped')); return; }
    const child = spawnProcess(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'pipe', '-f', 'mpegts', '-i', 'pipe:0', '-ss', String(segment.offsetSeconds),
      '-an', '-sn', '-dn', '-frames:v', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let length = 0;
    const chunks = [];
    let settled = false;
    let failure = null;
    let killTimer;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(bytes);
    };
    const kill = (message) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
      killTimer ??= setTimeout(() => finish(failure), 1000);
    };
    const abort = () => kill('Detection stopped');
    const timer = setTimeout(() => kill('Frame decoding timed out'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('Frame decoder is unavailable')));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > RGB_BYTES) { kill('Invalid decoded frame'); return; }
      chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (failure || code !== 0 || length !== RGB_BYTES) finish(failure ?? new Error('Frame could not be decoded'));
      else finish(null, Buffer.concat(chunks));
    });
    child.stdin.end(segment.bytes);
  });
}
