import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../backend/app.js';
import { loadConfig } from '../backend/config.js';
import { createEventClips, parseEventTime, readMp4Metadata } from '../backend/event-clips.js';
import { createMedia } from '../backend/media.js';
import { hashPassword } from '../backend/password.js';

function box(type, data = Buffer.alloc(0), extended = false) {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + data.length);
  header.write(type, 4, 4, 'ascii');
  if (extended) header.writeBigUInt64BE(BigInt(header.length + data.length), 8);
  return Buffer.concat([header, data]);
}

function movieHeader(duration = 60_000n, version = 0, timescale = 1000) {
  const data = Buffer.alloc(version === 1 ? 32 : 20);
  data[0] = version;
  data.writeUInt32BE(timescale, version === 1 ? 20 : 12);
  if (version === 1) data.writeBigUInt64BE(duration, 24);
  else data.writeUInt32BE(Number(duration), 16);
  return box('mvhd', data);
}

function mp4(seconds = 60, options = {}) {
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', Buffer.alloc(8)),
    box('moov', movieHeader(BigInt(Math.round(seconds * 1000)), options.version ?? 0), options.extended)]);
}

function memoryFile(data) {
  const reads = [];
  return { reads, async read(target, offset, length, position) {
    reads.push({ length, position });
    const count = Math.min(length, Math.max(0, data.length - position));
    data.copy(target, offset, position, position + count);
    return { bytesRead: count };
  } };
}

describe('bounded MP4 movie-header inspection', () => {
  it('reads v0 and v1 duration, including extended moov boxes', async () => {
    for (const version of [0, 1]) {
      const data = mp4(32.25, { version, extended: true });
      const handle = memoryFile(data);
      assert.deepEqual(await readMp4Metadata(handle, data.length), { complete: true, durationSeconds: 32.25 });
      assert.ok(handle.reads.every(({ length }) => length <= 32));
    }
  });

  it('does not infer a duration from zero, unknown, oversized or unsupported mvhd values', async () => {
    const headers = [movieHeader(0n), movieHeader(0xffffffffn), movieHeader(5n, 0, 0),
      movieHeader(0xffffffffffffffffn, 1), movieHeader(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1),
      movieHeader(50n, 2), box('mvhd', Buffer.alloc(19)), box('free')];
    for (const header of headers) {
      const data = Buffer.concat([box('ftyp'), box('mdat'), box('moov', header)]);
      assert.deepEqual(await readMp4Metadata(memoryFile(data), data.length), { complete: true, durationSeconds: null });
    }
  });

  it('rejects truncated containers and unsafe extended sizes', async () => {
    const unsafe = Buffer.alloc(16);
    unsafe.writeUInt32BE(1);
    unsafe.write('mdat', 4);
    unsafe.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    for (const data of [mp4().subarray(0, -1), Buffer.concat([mp4(), Buffer.alloc(1)]), unsafe, Buffer.alloc(4)]) {
      assert.equal((await readMp4Metadata(memoryFile(data), data.length)).complete, false);
    }
  });

  it('skips a 5 GB mdat using offsets and reads fewer than 200 bytes', async () => {
    const ftyp = box('ftyp');
    const mdat = Buffer.alloc(16);
    const mdatSize = 5_000_000_000;
    mdat.writeUInt32BE(1);
    mdat.write('mdat', 4);
    mdat.writeBigUInt64BE(BigInt(mdatSize), 8);
    const moov = box('moov', movieHeader());
    const spans = [{ start: 0, data: ftyp }, { start: ftyp.length, data: mdat }, { start: ftyp.length + mdatSize, data: moov }];
    let bytes = 0;
    const handle = { async read(target, offset, length, position) {
      const span = spans.find((item) => position >= item.start && position + length <= item.start + item.data.length);
      assert.ok(span, 'must not read the media payload');
      bytes += length;
      span.data.copy(target, offset, position - span.start, position - span.start + length);
      return { bytesRead: length };
    } };
    assert.deepEqual(await readMp4Metadata(handle, ftyp.length + mdatSize + moov.length), { complete: true, durationSeconds: 60 });
    assert.ok(bytes < 200);
  });

  it('limits pathological box counts', async () => {
    const data = Buffer.concat(Array.from({ length: 10_001 }, () => box('free')));
    const handle = memoryFile(data);
    assert.equal((await readMp4Metadata(handle, data.length)).complete, false);
    assert.ok(handle.reads.length <= 10_000);
  });
});

describe('event time validation and coverage', () => {
  it('accepts strict timezone-aware timestamps and rejects normalized invalid dates or unbounded values', () => {
    assert.equal(parseEventTime('2026-09-28T08:00:00.123+08:00'), Date.parse('2026-09-28T00:00:00.123Z'));
    for (const value of [undefined, [], ['2026-09-28T00:00:00Z'], '2026-02-30T00:00:00Z',
      '2026-09-28', '2026-09-28T24:00:00Z', '2026-09-28T00:00:60Z', '2026-09-28T00:00:00',
      '2026-09-28T00:00:00+14:01', '1969-12-31T23:59:59Z', '2101-01-01T00:00:00Z', '2026-09-28T00:00:00.1234Z']) {
      assert.throws(() => parseEventTime(value), { code: 'INVALID_EVENT_TIME', status: 400 });
    }
  });

  function fixture(name, start, seconds, extra = {}) {
    return { record: { id: name, name }, startMs: Date.parse(start), durationSeconds: seconds,
      complete: true, approximate: false, modifiedMs: Date.parse(start) + seconds * 1000, ...extra };
  }

  function resolver(files, offset = '+08:00', inspectDays = () => {}) {
    return createEventClips({ async eventRecordings(_id, days) { inspectDays(days); return files; } }, { recordingUtcOffset: offset });
  }

  it('returns precisely 20 seconds with bounded seek offsets', async () => {
    const result = await resolver([fixture('one', '2026-09-28T00:00:00Z', 60)])('cam1', '2026-09-28T00:00:30Z');
    assert.deepEqual(result, { status: 'ready', parts: [{ record: { id: 'one', name: 'one' }, startSeconds: 20, endSeconds: 40 }], approximate: false, partial: false });
  });

  it('joins midnight recordings in the recording timezone and sorts parts', async () => {
    const before = fixture('before', '2026-09-27T15:59:00Z', 60);
    const after = fixture('after', '2026-09-27T16:00:00Z', 60);
    const clip = resolver([after, before], '+08:00', (days) => assert.deepEqual(days, ['2026-09-27', '2026-09-28', '2026-09-29']));
    const result = await clip('cam1', '2026-09-28T00:00:02+08:00');
    assert.equal(result.status, 'ready');
    assert.equal(result.partial, false);
    assert.deepEqual(result.parts.map(({ record, startSeconds, endSeconds }) => [record.name, startSeconds, endSeconds]), [['before', 52, 60], ['after', 0, 12]]);
    await resolver([], '-07:00', (days) => assert.deepEqual(days, ['2026-09-26', '2026-09-27', '2026-09-28']))('cam1', '2026-09-28T01:00:00Z');
  });

  it('marks clipped edges, internal gaps, and legacy times honestly', async () => {
    const short = fixture('short', '2026-09-01T00:00:00Z', 8, { approximate: true });
    const clip = await resolver([short])('cam1', '2026-09-01T00:00:03Z');
    assert.equal(clip.partial, true);
    assert.equal(clip.approximate, true);
    assert.deepEqual(clip.parts.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[0, 8]]);
    const withGap = await resolver([fixture('first', '2026-09-01T00:00:00Z', 15), fixture('second', '2026-09-01T00:00:18Z', 30)])('cam1', '2026-09-01T00:00:12Z');
    assert.equal(withGap.partial, true);
    assert.equal(withGap.parts.length, 2);
  });

  it('never selects neighboring clips when the event itself lies in a recording gap', async () => {
    const clip = resolver([fixture('before', '2026-09-01T00:00:00Z', 10), fixture('after', '2026-09-01T00:00:20Z', 60)]);
    for (const seconds of ['10', '15', '19']) {
      const result = await clip('cam1', `2026-09-01T00:00:${seconds}Z`);
      assert.equal(result.status, 'unavailable');
      assert.deepEqual(result.parts, []);
    }
  });

  it('avoids replaying overlaps twice', async () => {
    const result = await resolver([fixture('one', '2026-09-01T00:00:00Z', 20), fixture('two', '2026-09-01T00:00:15Z', 20)])('cam1', '2026-09-01T00:00:18Z');
    assert.deepEqual(result.parts.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[8, 20], [5, 13]]);
    assert.equal(result.partial, false);
  });

  it('keeps matching unfinished recordings and recent events pending without claiming coverage', async () => {
    const unfinished = fixture('active', '2026-09-01T00:00:00Z', 30, { complete: false, durationSeconds: null });
    const activeNow = Date.parse('2026-09-01T00:02:30Z');
    assert.equal((await resolver([unfinished])('cam1', '2026-09-01T00:00:20Z', activeNow)).status, 'pending');
    assert.equal((await resolver([unfinished])('cam1', '2026-09-01T00:00:20Z', activeNow + 1000)).status, 'unavailable');
    const now = Date.parse('2026-09-28T10:00:00Z');
    assert.equal((await resolver([unfinished])('cam1', '2026-09-01T00:00:20Z', now)).status, 'unavailable', 'stale incomplete recordings must stop polling');
    assert.equal((await resolver([unfinished])('cam1', '2026-09-01T00:30:20Z', now)).status, 'unavailable');
    const updated = { ...unfinished, modifiedMs: Date.parse('2026-09-01T00:29:50Z') };
    assert.equal((await resolver([updated])('cam1', '2026-09-01T00:00:20Z', Date.parse('2026-09-01T00:30:00Z'))).status, 'pending', 'ongoing writes can keep an earlier event pending');
    assert.equal((await resolver([])('cam1', '2026-09-28T10:00:00Z', now)).status, 'pending');
    assert.equal((await resolver([])('cam1', '2026-09-28T11:00:00Z', now)).status, 'unavailable');
  });
});

describe('authenticated event-clip API and safe media integration', () => {
  let dataRoot;
  let config;
  let server;
  let baseUrl;
  let token;
  const request = (suffix, authenticated = true) => fetch(`${baseUrl}${suffix}`, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'cam-event-clips-'));
    const fixtures = {
      'cam1/2026-09-27/2026-09-27_23-59-00.mp4': mp4(60),
      'cam1/2026-09-28/2026-09-28_00-00-00.mp4': mp4(60, { version: 1 }),
      'cam1/2026-09-28/01.mp4': mp4(60),
      'cam1/2026-09-28/03.mp4': Buffer.concat([box('ftyp'), box('mdat'), box('moov', box('free'))]),
      'cam1/2026-09-28/2026-09-27_04-00-00.mp4': mp4(60),
      'cam1/2026-09-28/custom.mp4': mp4(60),
    };
    for (const [filename, data] of Object.entries(fixtures)) {
      const target = path.join(dataRoot, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    config = loadConfig({ NODE_ENV: 'test', DATA_ROOT: dataRoot, CAMERA_IDS: 'cam1', RECORDING_UTC_OFFSET: '+08:00',
      JWT_SECRET: 'event-clip-test-key-more-than-thirty-two-bytes', AUTH_USERNAME: 'tester',
      AUTH_PASSWORD_HASH: await hashPassword('test-password'), COOKIE_SECURE: 'false' });
    server = createApp(config).listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'test-password' }) });
    assert.equal(response.status, 200);
    token = (await response.json()).accessToken;
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (dataRoot) {
      assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(tmpdir()));
      assert.ok(path.basename(dataRoot).startsWith('cam-event-clips-'));
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('requires existing authorization before validating query or exposing records', async () => {
    assert.equal((await request('/api/cameras/cam1/event-clip?at=invalid', false)).status, 401);
    assert.equal((await request('/api/cameras/cam1/event-clip?at=invalid')).status, 400);
    assert.equal((await request('/api/cameras/cam1/event-clip?at=2026-09-28T00:00:00Z&at=2026-09-28T00:00:01Z')).status, 400);
    assert.equal((await request('/api/cameras/unknown/event-clip?at=2026-09-28T00:00:00Z')).status, 404);
  });

  it('returns protected HistoryRecord URLs and crosses a real date directory boundary', async () => {
    const response = await request('/api/cameras/cam1/event-clip?at=2026-09-27T16:00:02Z');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = await response.json();
    assert.equal(result.status, 'ready');
    assert.equal(result.partial, false);
    assert.equal(result.approximate, false);
    assert.equal(result.parts.length, 2);
    assert.deepEqual(result.parts.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[52, 60], [0, 12]]);
    for (const { record } of result.parts) {
      assert.equal(record.fileUrl, `/cam1/api/records/${record.date}/${record.name}`);
      assert.equal((await request(record.fileUrl, false)).status, 401);
      assert.equal((await request(record.fileUrl)).status, 200);
    }
    assert.ok(!JSON.stringify(result).includes(dataRoot));
  });

  it('marks legacy hour names approximate and never uses custom/mismatched names or missing durations', async () => {
    const legacy = await (await request('/api/cameras/cam1/event-clip?at=2026-09-27T17:00:20Z')).json();
    assert.equal(legacy.status, 'ready');
    assert.equal(legacy.approximate, true);
    const media = createMedia(config);
    const events = await media.eventRecordings('cam1', ['2026-09-28']);
    assert.deepEqual(events.map(({ record }) => record.name).sort(), ['01.mp4', '03.mp4', '2026-09-28_00-00-00.mp4']);
    const unknownDuration = await createEventClips(media, config)('cam1', '2026-09-28T03:00:20+08:00', Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(unknownDuration.status, 'unavailable');
    assert.equal((await media.records('cam1')).length, 6, 'normal history continues to include finalized legacy files');
  });
});
