import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';
import { readMp4Metadata, recordingTime } from './event-clips.js';

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Media not found');
const isMissing = (error) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,199}$/.test(name) && !name.includes('..');
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function createMedia(config) {
  const completeCache = new Map();

  function camera(id) {
    if (!config.cameraIds.includes(id)) throw notFound();
  }

  async function safePath(parts) {
    if (parts.some((part) => !validName(part))) throw notFound();
    const root = await realpath(config.dataRoot);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw notFound();
    }
    const resolved = await realpath(current);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw notFound();
    return resolved;
  }

  async function dates(id) {
    camera(id);
    try {
      const directory = await safePath([id]);
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && validDate(entry.name))
        .map((entry) => entry.name).sort().reverse();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async function openFile(parts) {
    let handle;
    try {
      const filename = await safePath(parts);
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile()) throw notFound();
      return { handle, stat, filename };
    } catch (error) {
      await handle?.close();
      if (isMissing(error)) throw notFound();
      throw error;
    }
  }

  async function metadata(file) {
    const version = `${file.stat.size}:${file.stat.mtimeMs}:${file.stat.ctimeMs}`;
    const cached = completeCache.get(file.filename);
    if (cached?.version === version) return cached.metadata;
    const result = await readMp4Metadata(file.handle, file.stat.size);
    if (completeCache.size >= 10_000) completeCache.delete(completeCache.keys().next().value);
    completeCache.set(file.filename, { version, metadata: result });
    return result;
  }

  async function isComplete(file) { return (await metadata(file)).complete; }

  function timestamp(date, name, stat) {
    const match = /^(?:\d{4}-\d{2}-\d{2}_)?([01]\d|2[0-3])(?:[-_]([0-5]\d)[-_]([0-5]\d))?\.mp4$/i.exec(name);
    return match ? `${date}T${match[1]}:${match[2] ?? '00'}:${match[3] ?? '00'}${config.recordingUtcOffset}` : stat.mtime.toISOString();
  }

  async function listRecordings(id, days, includeDetails = false) {
    camera(id);
    const result = [];
    for (const day of days) {
      let entries;
      try { entries = await readdir(await safePath([id, day]), { withFileTypes: true }); }
      catch (error) { if (isMissing(error) || error.status === 404) continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !validName(entry.name) || !/\.mp4$/i.test(entry.name)) continue;
        let file;
        try {
          file = await openFile([id, day, entry.name]);
          const details = await metadata(file);
          if (!includeDetails && !details.complete) continue;
          const record = {
            id: `${id}/${day}/${entry.name}`, name: entry.name, date: day,
            timeStamp: timestamp(day, entry.name, file.stat), size: file.stat.size,
            fileUrl: `/${id}/api/records/${day}/${encodeURIComponent(entry.name)}`,
          };
          if (includeDetails) {
            const time = recordingTime(day, entry.name, config.recordingUtcOffset);
            // mtime is useful for history ordering, but is not a recording start.
            if (time) result.push({ record, ...details, ...time, modifiedMs: file.stat.mtimeMs });
          } else result.push(record);
        } catch (error) {
          if (!isMissing(error) && error.status !== 404) throw error;
        } finally { await file?.handle.close(); }
      }
    }
    return result;
  }

  async function records(id, date) {
    return (await listRecordings(id, date ? [date] : await dates(id)))
      .sort((a, b) => b.date.localeCompare(a.date) || Date.parse(b.timeStamp) - Date.parse(a.timeStamp) || b.name.localeCompare(a.name));
  }

  async function eventRecordings(id, days) { return listRecordings(id, days, true); }

  async function stream(req, res, parts, contentType, checkMp4 = false) {
    const file = await openFile(parts);
    let transferred = false;
    try {
      if (checkMp4 && !(await isComplete(file))) {
        throw new HttpError(409, 'RECORDING_IN_PROGRESS', 'Recording is still being finalized or is incomplete');
      }
      const size = file.stat.size;
      res.set({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
      let start = 0;
      let end = size - 1;
      if (req.get('range')) {
        const ranges = req.range(size, { combine: true });
        if (!Array.isArray(ranges) || ranges.type !== 'bytes' || ranges.length !== 1) {
          res.set('Content-Range', `bytes */${size}`);
          throw new HttpError(416, 'INVALID_RANGE', 'Requested byte range is not available');
        }
        ({ start, end } = ranges[0]);
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.set('Content-Length', String(Math.max(0, end - start + 1)));
      if (req.method === 'HEAD' || size === 0) { res.end(); return; }
      const source = file.handle.createReadStream({ start, end, autoClose: true });
      transferred = true;
      res.once('close', () => source.destroy());
      source.once('error', () => res.destroy());
      source.pipe(res);
    } finally {
      if (!transferred) await file.handle.close();
    }
  }

  async function live(req, res) {
    const { cameraId, filename } = req.params;
    camera(cameraId);
    if (!validName(filename)) throw notFound();
    const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
      '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.aac': 'audio/aac' }[path.extname(filename).toLowerCase()];
    if (!mime) throw notFound();
    await stream(req, res, [cameraId, 'hls', filename], mime);
  }

  async function recording(req, res) {
    const { cameraId, date, filename } = req.params;
    camera(cameraId);
    if (!validDate(date) || !validName(filename) || !/\.mp4$/i.test(filename)) throw notFound();
    await stream(req, res, [cameraId, date, filename], 'video/mp4', true);
  }

  async function ready() {
    // Check every configured camera directory; do not mistake an empty mount for healthy storage.
    for (const id of config.cameraIds) {
      const directory = await safePath([id]);
      if (!(await lstat(directory)).isDirectory()) throw new Error('Missing camera directory');
      await readdir(directory);
    }
  }

  return { dates, records, eventRecordings, live, recording, ready };
}
