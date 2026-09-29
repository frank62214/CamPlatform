import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rmdir, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { loadConfig } from '../backend/config.js';
import { hashPassword } from '../backend/password.js';

function atom(type, content = Buffer.alloc(8)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, content]);
}
const completeMp4 = Buffer.concat([atom('ftyp'), atom('mdat'), atom('moov')]);
let root, base, server, token;
const request = (pathname, options = {}) => fetch(`${base}${pathname}`, {
  ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
});
async function history(camera = 'cam1', requestedDate) {
  const { dates } = await (await request(`/api/cameras/${camera}/dates`)).json();
  const date = requestedDate ?? dates[0] ?? null;
  const page = await (await request(`/api/cameras/${camera}/records${date ? `?date=${date}` : ''}`)).json();
  return { camera, date, dates, ...page };
}
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'camplatform-records-'));
  for (const folder of ['cam1/2026-09-17', 'cam1/2026-08-01', 'cam1/2026-09-19', 'cam1/2026-09-20', 'cam1/hls', 'cam1/2026-02-30', 'cam2']) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  for (const name of ['2026-09-17_08.mp4', '09.mp4', '2026-09-17_10-15-30.mp4']) {
    await writeFile(path.join(root, 'cam1/2026-09-17', name), completeMp4);
  }
  await writeFile(path.join(root, 'cam1/2026-08-01/00.mp4'), Buffer.concat([atom('ftyp'), atom('moov'), atom('mdat')]));
  await writeFile(path.join(root, 'cam1/2026-09-17/11.mp4'), atom('mdat'));
  await writeFile(path.join(root, 'cam1/2026-09-17/12.mp4'), atom('mdat'));
  await utimes(path.join(root, 'cam1/2026-09-17/12.mp4'), new Date(0), new Date(0));
  await writeFile(path.join(root, 'cam1/2026-09-17/secret.txt'), 'private');
  await writeFile(path.join(root, 'cam1/2026-09-20/.keep'), '');
  await writeFile(path.join(root, 'cam1/hls/stream.m3u8'), '#EXTM3U\n');
  const config = loadConfig({ NODE_ENV: 'test', DATA_ROOT: root, CAMERA_IDS: 'cam1,cam2',
    JWT_SECRET: 'recording-regression-test-key-at-least-thirty-two-bytes', AUTH_USERNAME: 'tester',
    AUTH_PASSWORD_HASH: await hashPassword('test-password'), COOKIE_SECURE: 'false' });
  server = createApp(config).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-password' }) });
  assert.equal(session.status, 200);
  token = (await session.json()).accessToken;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camplatform-records-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('server entrypoint protects modern and legacy media routes before listing or serving files', async () => {
  for (const route of ['/api/cameras/cam1/dates', '/api/cameras/cam1/records', '/cam1/api/records',
    '/cam1/api/records/2026-09-17/09.mp4', '/cam1/hls/stream.m3u8']) {
    assert.equal((await fetch(`${base}${route}`)).status, 401);
    assert.equal((await fetch(`${base}${route}`, { method: 'HEAD' })).status, 401);
  }
});

test('lists nonempty dates, descending times and every readiness status with guarded playable URLs', async () => {
  const response = await request('/api/cameras/cam1/records?date=2026-09-17');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const data = await history();
  assert.deepEqual(data.dates, ['2026-09-17', '2026-08-01']);
  assert.equal(data.date, '2026-09-17');
  assert.equal(data.total, 5);
  assert.deepEqual(data.records.map(record => record.time), ['12:00:00', '11:00:00', '10:15:30', '09:00:00', '08:00:00']);
  assert.deepEqual(data.records.map(record => record.timePrecision), ['hour', 'hour', 'second', 'hour', 'hour']);
  assert.deepEqual(data.records.map(record => record.status), ['unavailable', 'recording', 'ready', 'ready', 'ready']);
  assert.equal(data.records[0].fileUrl, null);
  assert.equal(data.records[1].fileUrl, null);
  assert.equal(data.records[2].fileUrl, '/cam1/api/records/2026-09-17/2026-09-17_10-15-30.mp4');
  assert.ok(data.records.every(record => record.fileName === record.name && record.updatedAt));
});

test('preserves UUID restarts, compact times and honest filename precision', async () => {
  const folder = path.join(root, 'cam1/2026-09-18');
  await mkdir(folder);
  const cases = [
    ['2026-09-18_10-03-19_11111111-1111-4111-8111-111111111111.mp4', '10:03:19', 'second'],
    ['2026-09-18_10-03-19_22222222-2222-4222-8222-222222222222.mp4', '10:03:19', 'second'],
    ['2026-09-18_10-46-46_33333333-3333-4333-8333-333333333333.mp4', '10:46:46', 'second'],
    ['2026-09-18_10-47.mp4', '10:47:00', 'minute'], ['104846.mp4', '10:48:46', 'second'],
    ['10_49_05.mp4', '10:49:05', 'second'], ['1050.mp4', '10:50:00', 'minute'],
    ['2026-09-18_25-61-61.mp4', null, null], ['2026-09-17_10-00-00.mp4', null, null],
  ];
  try {
    for (const [name] of cases) await writeFile(path.join(folder, name), completeMp4);
    const data = await history('cam1', '2026-09-18');
    assert.equal(data.records.length, cases.length);
    assert.equal(new Set(data.records.map(record => record.id)).size, cases.length);
    for (const [name, time, precision] of cases) {
      const record = data.records.find(record => record.fileName === name);
      assert.equal(record.timePrecision, precision);
      assert.equal(record.time, time);
      assert.equal(record.status, 'ready');
      assert.equal((await request(record.fileUrl, { method: 'HEAD' })).status, 200);
      assert.equal(record.startedAt, undefined);
      if (time) assert.equal(record.timeStamp, `2026-09-18T${time}+08:00`);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(root, 'cam1'));
    await rm(folder, { recursive: true });
  }
});

test('can browse older than seven days and recognizes faststart MP4', async () => {
  const data = await history('cam1', '2026-08-01');
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].status, 'ready');
});

test('ignores precreated empty days and discovers them once recording starts', async () => {
  const file = path.join(root, 'cam1/2026-09-19/00-00-02.mp4');
  const before = await history();
  assert.equal(before.date, '2026-09-17');
  assert.ok(!before.dates.includes('2026-09-19'));
  assert.ok(!before.dates.includes('2026-09-20'));
  try {
    await writeFile(file, atom('mdat'));
    const after = await history();
    assert.equal(after.date, '2026-09-19');
    assert.equal(after.records[0].status, 'recording');
  } finally {
    await rm(file);
  }
});

test('separates empty cameras and dates from unavailable storage', async () => {
  const empty = await history('cam2');
  assert.equal(empty.date, null);
  assert.deepEqual(empty.dates, []);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.total, 0);
  assert.deepEqual((await history('cam1', '2025-01-01')).records, []);
  await rmdir(path.join(root, 'cam2'));
  try {
    for (const endpoint of ['dates', 'records', 'records?date=2026-09-17']) {
      const response = await request(`/api/cameras/cam2/${endpoint}`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'STORAGE_UNAVAILABLE');
    }
  } finally {
    await mkdir(path.join(root, 'cam2'));
  }
});

test('rejects malformed, impossible, duplicate and traversal dates', async () => {
  for (const query of ['date=2026-02-30', 'date=../cam2', 'date=20260917', 'date=', 'date=2026-09-17&date=2026-08-01']) {
    assert.equal((await request(`/api/cameras/cam1/records?${query}`)).status, 400, query);
  }
  for (const url of ['/api/cameras/cam3/records', '/cam1/api/records/2026-09-17/secret.txt', '/cam1/api/records/2026-09-17/..%2Fsecret.mp4', '/cam1/api/records/2026-09-17/..%5Csecret.mp4']) {
    assert.equal((await request(url)).status, 404, url);
  }
});

test('serves authorized MP4 including HEAD and byte ranges', async () => {
  const url = '/cam1/api/records/2026-09-17/09.mp4';
  const full = await request(url);
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-type'), /video\/mp4/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), completeMp4);
  const head = await request(url, { method: 'HEAD' });
  assert.equal(Number(head.headers.get('content-length')), completeMp4.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const partial = await request(url, { headers: { Range: 'bytes=8-15' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 8-15/${completeMp4.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), completeMp4.subarray(8, 16));
  const suffix = await request(url, { headers: { Range: 'bytes=-8' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), completeMp4.subarray(-8));
  assert.equal((await request(url, { headers: { Range: 'bytes=999-' } })).status, 416);
});

test('blocks unfinished, truncated and removed recordings', async () => {
  for (const name of ['11.mp4', '12.mp4']) {
    assert.equal((await request(`/cam1/api/records/2026-09-17/${name}`)).status, 409);
  }
  await writeFile(path.join(root, 'cam1/2026-09-17/truncated.mp4'), completeMp4.subarray(0, -2));
  assert.equal((await request('/cam1/api/records/2026-09-17/truncated.mp4')).status, 409);
  await rm(path.join(root, 'cam1/2026-09-17/truncated.mp4'));
  assert.equal((await request('/cam1/api/records/2026-09-17/missing.mp4')).status, 404);
});

test('does not list or follow a linked date directory outside the camera', async () => {
  const external = path.join(root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, '09.mp4'), completeMp4);
  await symlink(external, path.join(root, 'cam1/2026-09-16'), process.platform === 'win32' ? 'junction' : 'dir');
  const data = await history();
  assert.ok(!data.dates.includes('2026-09-16'));
  assert.equal((await request('/cam1/api/records/2026-09-16/09.mp4')).status, 404);
});

test('preserves authorized live HLS route and disables playlist caching', async () => {
  const response = await request('/cam1/hls/stream.m3u8');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('content-type'), /mpegurl/);
  assert.match(await response.text(), /#EXTM3U/);
});
