import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const MAX_FRAME_AGE_MS = 30_000;
const MAX_PLAYLIST_BYTES = 128 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const RGB_BYTES = 320 * 180 * 3;

export function parseDetectionPlaylist(text) {
  if (Buffer.byteLength(text) > MAX_PLAYLIST_BYTES || !text.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  const segments = [];
  let nextTime = null;
  let duration = null;
  let gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const stamp = line.slice(25);
      nextTime = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(stamp) ? Date.parse(stamp) : null;
      if (!Number.isFinite(nextTime)) nextTime = null;
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
      if (!gap && nextTime !== null) {
        const occurredAtMs = nextTime + duration * 500;
        segments.push({ name: line, offsetSeconds: duration / 2, occurredAtMs,
          occurredAt: new Date(occurredAtMs).toISOString(), frameKey: `${line}:${nextTime}:${duration}` });
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
    return data;
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
  const segment = parseDetectionPlaylist(playlist.toString('utf8')).at(-1);
  if (!segment || nowMs - segment.occurredAtMs > MAX_FRAME_AGE_MS || segment.occurredAtMs > nowMs + 5000) return null;
  const bytes = await boundedRead(path.join(directory, segment.name), MAX_SEGMENT_BYTES);
  return { ...segment, bytes };
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
