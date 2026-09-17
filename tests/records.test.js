import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";

function atom(type, content = Buffer.alloc(8)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, content]);
}
const completeMp4 = Buffer.concat([atom("ftyp"), atom("mdat"), atom("moov")]);
let root, base, server;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "camplatform-records-"));
  for (const folder of ["cam1/2026-09-17", "cam1/2026-08-01", "cam1/hls", "cam1/2026-02-30", "cam2"]) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  for (const name of ["2026-09-17_08.mp4", "09.mp4", "2026-09-17_10-15-30.mp4"]) {
    await writeFile(path.join(root, "cam1/2026-09-17", name), completeMp4);
  }
  await writeFile(path.join(root, "cam1/2026-08-01/00.mp4"), Buffer.concat([atom("ftyp"), atom("moov"), atom("mdat")]));
  await writeFile(path.join(root, "cam1/2026-09-17/11.mp4"), atom("mdat"));
  await writeFile(path.join(root, "cam1/2026-09-17/12.mp4"), atom("mdat"));
  await utimes(path.join(root, "cam1/2026-09-17/12.mp4"), new Date(0), new Date(0));
  await writeFile(path.join(root, "cam1/2026-09-17/secret.txt"), "private");
  await writeFile(path.join(root, "cam1/hls/stream.m3u8"), "#EXTM3U\n");
  server = createApp({ videoRoot: root }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "camplatform-records-")));
    await rm(root, { recursive: true, force: true });
  }
});

test("lists all dates, defaults to latest and returns descending times and usable URLs", async () => {
  const response = await fetch(`${base}/cam1/api/records`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.deepEqual(data.dates, ["2026-09-17", "2026-08-01"]);
  assert.equal(data.date, "2026-09-17");
  assert.equal(data.records.length, 5);
  assert.deepEqual(data.records.map(record => record.time), ["12:00:00", "11:00:00", "10:15:30", "09:00:00", "08:00:00"]);
  assert.deepEqual(data.records.map(record => record.status), ["unavailable", "recording", "ready", "ready", "ready"]);
  assert.equal(data.records[0].fileUrl, null);
  assert.equal(data.records[2].fileUrl, "/cam1/api/records/2026-09-17/2026-09-17_10-15-30.mp4");
});

test("can browse older than seven days and recognizes faststart MP4", async () => {
  const data = await (await fetch(`${base}/cam1/api/records?date=2026-08-01`)).json();
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].status, "ready");
});

test("separates empty cameras and dates from unavailable storage", async () => {
  const empty = await (await fetch(`${base}/cam2/api/records`)).json();
  assert.deepEqual(empty, { camera: "cam2", date: null, dates: [], records: [] });
  const absentDate = await (await fetch(`${base}/cam1/api/records?date=2025-01-01`)).json();
  assert.deepEqual(absentDate.records, []);
  await rmdir(path.join(root, "cam2"));
  try {
    const response = await fetch(`${base}/cam2/api/records`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /儲存空間/);
  } finally {
    await mkdir(path.join(root, "cam2"));
  }
});

test("rejects malformed, impossible, duplicate and traversal dates", async () => {
  for (const query of ["date=2026-02-30", "date=../cam2", "date=20260917", "date=", "date=2026-09-17&date=2026-08-01"]) {
    assert.equal((await fetch(`${base}/cam1/api/records?${query}`)).status, 400, query);
  }
  for (const url of ["/cam3/api/records", "/cam1/api/records/2026-09-17/secret.txt", "/cam1/api/records/2026-09-17/..%2Fsecret.mp4", "/cam1/api/records/2026-09-17/..%5Csecret.mp4"]) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
});

test("serves MP4 including HEAD, byte ranges, suffix ranges and unsatisfiable ranges", async () => {
  const url = `${base}/cam1/api/records/2026-09-17/09.mp4`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-type"), /video\/mp4/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), completeMp4);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), completeMp4.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const partial = await fetch(url, { headers: { Range: "bytes=8-15" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 8-15/${completeMp4.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), completeMp4.subarray(8, 16));
  const suffix = await fetch(url, { headers: { Range: "bytes=-8" } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), completeMp4.subarray(-8));
  assert.equal((await fetch(url, { headers: { Range: "bytes=999-" } })).status, 416);
});

test("blocks unfinished, truncated and removed recordings", async () => {
  for (const name of ["11.mp4", "12.mp4"]) {
    assert.equal((await fetch(`${base}/cam1/api/records/2026-09-17/${name}`)).status, 409);
  }
  await writeFile(path.join(root, "cam1/2026-09-17/truncated.mp4"), completeMp4.subarray(0, -2));
  assert.equal((await fetch(`${base}/cam1/api/records/2026-09-17/truncated.mp4`)).status, 409);
  await rm(path.join(root, "cam1/2026-09-17/truncated.mp4"));
  assert.equal((await fetch(`${base}/cam1/api/records/2026-09-17/missing.mp4`)).status, 404);
});

test("does not list or follow a linked date directory outside the camera", async () => {
  const external = path.join(root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "09.mp4"), completeMp4);
  await symlink(external, path.join(root, "cam1/2026-09-16"), process.platform === "win32" ? "junction" : "dir");
  const data = await (await fetch(`${base}/cam1/api/records`)).json();
  assert.ok(!data.dates.includes("2026-09-16"));
  assert.equal((await fetch(`${base}/cam1/api/records/2026-09-16/09.mp4`)).status, 404);
});

test("preserves live HLS route and disables playlist caching", async () => {
  const response = await fetch(`${base}/cam1/hls/stream.m3u8`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /mpegurl/);
  assert.match(await response.text(), /#EXTM3U/);
});
