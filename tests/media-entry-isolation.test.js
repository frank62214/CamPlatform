import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createMedia } from '../backend/media.js';
import { createEventClips } from '../backend/event-clips.js';

function box(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + data.length);
  header.write(type, 4);
  return Buffer.concat([header, data]);
}

function completedMp4() {
  const movie = Buffer.alloc(20);
  movie.writeUInt32BE(1000, 12);
  movie.writeUInt32BE(60_000, 16);
  return Buffer.concat([box('ftyp'), box('mdat', Buffer.alloc(8)), box('moov', box('mvhd', movie))]);
}

function denied(code, filename, syscall = 'lstat') {
  return Object.assign(new Error('Synthetic NFS failure'), { code, path: filename, syscall });
}

describe('NFS recording entry isolation', () => {
  let dataRoot;
  let cameraRoot;
  let dayRoot;
  let completed;
  let active;
  let config;
  const day = '2026-09-30';
  const eventTime = '2026-09-30T12:00:30Z';

  before(async () => {
    dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'cam-nfs-entry-'));
    cameraRoot = path.join(dataRoot, 'cam1');
    dayRoot = path.join(cameraRoot, day);
    await fs.mkdir(dayRoot, { recursive: true });
    completed = path.join(dayRoot, `${day}_12-00-00.mp4`);
    active = path.join(dayRoot, `${day}_13-00-00.mp4`);
    await fs.writeFile(completed, completedMp4());
    await fs.writeFile(active, box('mdat'));
    await fs.writeFile(path.join(dayRoot, '.private.mp4'), 'ignored');
    await fs.mkdir(path.join(dayRoot, 'directory.mp4'));
    config = { dataRoot, cameraIds: ['cam1'], recordingUtcOffset: '+00:00' };
  });

  after(async () => {
    if (dataRoot) {
      assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(tmpdir()));
      assert.ok(path.basename(dataRoot).startsWith('cam-nfs-entry-'));
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  async function assertReadableHistory(media) {
    assert.deepEqual(await media.dates('cam1'), [day]);
    const records = await media.records('cam1', day);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, path.basename(completed));
    assert.equal(records[0].status, 'ready');
    const clip = await createEventClips(media, config)('cam1', eventTime);
    assert.equal(clip.status, 'ready');
    assert.deepEqual(clip.parts.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[20, 40]]);
  }

  it('keeps readable history and event clips when typed NFS reads and active-file metadata fail', async () => {
    const inspected = [];
    const media = createMedia(config, { ...fs,
      async readdir(directory, options) {
        // NFS may require lstat to construct Dirents; one denied file then
        // rejects the whole typed readdir before application filtering runs.
        if (options?.withFileTypes) throw denied('EPERM', active);
        return fs.readdir(directory, options);
      },
      async lstat(filename) {
        inspected.push(filename);
        if (filename === active) throw denied('EPERM', filename);
        return fs.lstat(filename);
      },
      async open(filename, flags) {
        assert.notEqual(filename, path.join(dayRoot, 'directory.mp4'), 'nonregular entries must not be opened');
        return fs.open(filename, flags);
      },
    });
    await assertReadableHistory(media);
    assert.ok(!inspected.includes(path.join(dayRoot, '.private.mp4')), 'invalid names are filtered before stat');
  });

  it('isolates denied or disappearing individual metadata entries without inventing records', async () => {
    for (const code of ['EACCES', 'ENOENT']) {
      const media = createMedia(config, { ...fs, async lstat(filename) {
        if (filename === active) throw denied(code, filename);
        return fs.lstat(filename);
      } });
      await assertReadableHistory(media);
    }
  });

  it('isolates an access failure when opening a file after its metadata was readable', async () => {
    for (const code of ['EPERM', 'EACCES', 'ENOENT']) {
      const media = createMedia(config, { ...fs, async open(filename, flags) {
        if (filename === active) throw denied(code, filename, 'open');
        return fs.open(filename, flags);
      } });
      await assertReadableHistory(media);
    }
  });

  it('isolates denied descriptor operations and closes their file handles', async () => {
    for (const operation of ['stat', 'read']) {
      let closed = 0;
      const media = createMedia(config, { ...fs, async open(filename, flags) {
        const handle = await fs.open(filename, flags);
        if (filename !== active) return handle;
        return {
          stat: () => operation === 'stat' ? Promise.reject(denied('EPERM', undefined, 'fstat')) : handle.stat(),
          read: (...args) => operation === 'read' ? Promise.reject(denied('EPERM', undefined, 'read')) : handle.read(...args),
          close: async () => { closed++; await handle.close(); },
        };
      } });
      await assertReadableHistory(media);
      assert.equal(closed, 2, 'records and event clips must each close their denied file handle');
    }
  });

  it('does not fabricate pending recording coverage for an inaccessible file', async () => {
    const media = createMedia(config, { ...fs, async lstat(filename) {
      if (filename === active) throw denied('EPERM', filename);
      return fs.lstat(filename);
    } });
    const at = '2026-09-30T13:00:30Z';
    const clip = createEventClips(media, config);
    const recent = await clip('cam1', at, Date.parse(at));
    assert.equal(recent.status, 'pending');
    assert.deepEqual(recent.parts, []);
    // Once the recent-event grace expires, retrying after permissions/finalization
    // recover is necessary; unknown metadata cannot establish active coverage.
    const older = await clip('cam1', at, Date.parse(at) + 61_000);
    assert.equal(older.status, 'unavailable');
    assert.deepEqual(older.parts, []);
  });

  it('surfaces camera-root and date-directory listing failures', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const rootFailure = createMedia(config, { ...fs, async readdir(directory, options) {
        if (directory === cameraRoot) throw denied(code, directory, 'scandir');
        return fs.readdir(directory, options);
      } });
      await assert.rejects(rootFailure.dates('cam1'), { code });
      await assert.rejects(rootFailure.records('cam1'), { code });
      const dayFailure = createMedia(config, { ...fs, async readdir(directory, options) {
        if (directory === dayRoot) throw denied(code, directory, 'scandir');
        return fs.readdir(directory, options);
      } });
      await assert.rejects(dayFailure.dates('cam1'), { code });
      await assert.rejects(dayFailure.records('cam1', day), { code });
      await assert.rejects(createEventClips(dayFailure, config)('cam1', eventTime), { code });
    }
  });

  it('surfaces ancestor access failures that occur after file enumeration', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      for (const ancestor of [dataRoot, cameraRoot, dayRoot]) {
        let enumerated = false;
        const media = createMedia(config, { ...fs,
          async lstat(filename) {
            if (filename === completed) enumerated = true;
            if (enumerated && filename === ancestor) throw denied(code, filename);
            return fs.lstat(filename);
          },
          async realpath(filename) {
            if (enumerated && filename === ancestor) throw denied(code, filename, 'realpath');
            return fs.realpath(filename);
          },
        });
        await assert.rejects(media.records('cam1', day), { code, path: ancestor });
      }
    }
  });

  it('does not hide other file I/O failures', async () => {
    const media = createMedia(config, { ...fs, async lstat(filename) {
      if (filename === active) throw denied('EIO', filename);
      return fs.lstat(filename);
    } });
    await assert.rejects(media.dates('cam1'), { code: 'EIO' });
    await assert.rejects(media.records('cam1', day), { code: 'EIO' });
  });
});
