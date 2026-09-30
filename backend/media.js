import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';
import { isRecordingActive, readMp4Metadata, recordingTime } from './event-clips.js';

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Media not found');
const isMissing = (error) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
const isPermissionDenied = (error) => ['EACCES', 'EPERM'].includes(error.code);
const isUnavailableEntry = (error, filename, opened = false) => isMissing(error) || error.status === 404 ||
  (isPermissionDenied(error) && (error.path ? path.resolve(error.path) === filename : opened));
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,199}$/.test(name) && !name.includes('..');
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function createMedia(config, filesystem = fs) {
  const { lstat, open, readdir, realpath } = filesystem;
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
    const directory = await cameraDirectory(id);
    const result = [];
    for (const day of await readdir(directory)) {
      if (!validDate(day)) continue;
      try {
        // Tomorrow's precreated folder must not hide today's recordings.
        if ((await recordingEntries(id, day)).length) result.push(day);
      } catch (error) {
        if (!isMissing(error) && error.status !== 404) throw error;
      }
    }
    return result.sort().reverse();
  }

  async function recordingEntries(id, day) {
    const directory = await safePath([id, day]);
    // On NFS, withFileTypes can internally lstat every entry and fail the entire
    // listing if one actively written file denies metadata access. Filter names
    // first, then isolate individual files; directory access errors still surface.
    const names = await readdir(directory);
    const recordings = [];
    for (const name of names) {
      if (!validName(name) || !/\.mp4$/i.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        // Do not follow symlinks or open nonregular files such as named pipes.
        if ((await lstat(filename)).isFile()) recordings.push({ name, filename });
      } catch (error) {
        if (!isUnavailableEntry(error, filename)) throw error;
      }
    }
    return recordings;
  }

  async function cameraDirectory(id) {
    camera(id);
    try {
      const directory = await safePath([id]);
      if (!(await lstat(directory)).isDirectory()) throw notFound();
      return directory;
    } catch (error) {
      if (isMissing(error) || error.status === 404) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Recording storage is unavailable');
      throw error;
    }
  }

  async function openFile(parts) {
    let handle;
    let filename;
    try {
      filename = await safePath(parts);
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile()) throw notFound();
      return { handle, stat, filename };
    } catch (error) {
      await handle?.close();
      if (isMissing(error)) throw notFound();
      // Descriptor errors lack a path. Tag them only after safePath succeeds so
      // callers can distinguish a file failure from denied ancestor access.
      if (filename && !error.path && isPermissionDenied(error)) error.path = filename;
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

  async function listRecordings(id, days, includeDetails = false) {
    await cameraDirectory(id);
    const result = [];
    for (const day of days) {
      let entries;
      try { entries = await recordingEntries(id, day); }
      catch (error) { if (isMissing(error) || error.status === 404) continue; throw error; }
      for (const { name, filename } of entries) {
        let file;
        try {
          file = await openFile([id, day, name]);
          const details = await metadata(file);
          const time = recordingTime(day, name, config.recordingUtcOffset);
          const status = details.complete ? 'ready' : isRecordingActive(file.stat.mtimeMs) ? 'recording' : 'unavailable';
          const record = {
            id: `${id}/${day}/${name}`, name, fileName: name, date: day,
            timeStamp: time?.timeStamp ?? file.stat.mtime.toISOString(), size: file.stat.size,
            time: time?.time ?? null, timePrecision: time?.timePrecision ?? null,
            updatedAt: file.stat.mtime.toISOString(), status,
            fileUrl: details.complete ? `/${id}/api/records/${day}/${encodeURIComponent(name)}` : null,
          };
          if (includeDetails) {
            // mtime is useful for history ordering, but is not a recording start.
            if (time) result.push({ record, ...details, ...time, modifiedMs: file.stat.mtimeMs });
          } else result.push(record);
        } catch (error) {
          if (!isUnavailableEntry(error, filename, Boolean(file))) throw error;
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
