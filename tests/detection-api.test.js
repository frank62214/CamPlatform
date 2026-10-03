import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../backend/app.js';
import { loadConfig } from '../backend/config.js';
import { hashPassword } from '../backend/password.js';
import { createEventStore } from '../backend/detection-store.js';
import { createDetectionService } from '../backend/detection-service.js';

describe('authenticated durable person detection API', () => {
  let temporary, config, service, store, server, baseUrl, token, cookie, callbacks;
  let storageUnavailable = false;
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const request = (route, options = {}) => fetch(`${baseUrl}${route}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  const toggle = (body, headers = {}) => request('/api/cameras/cam1/detection', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  before(async () => {
    temporary = await fs.mkdtemp(path.join(tmpdir(), 'cam-detection-api-'));
    config = loadConfig({ NODE_ENV: 'test', DATA_ROOT: path.join(temporary, 'data'), EVENTS_ROOT: path.join(temporary, 'events'),
      DETECTION_ENABLED: 'true', JWT_SECRET: 'test-only-long-secret-of-at-least-thirty-two-bytes',
      AUTH_USERNAME: 'tester', AUTH_PASSWORD_HASH: await hashPassword('test-password'), PUBLIC_ORIGIN: 'http://localhost' });
    for (const id of config.cameraIds) await fs.mkdir(path.join(config.dataRoot, id), { recursive: true });
    store = createEventStore(config, { now: () => now, filesystem: { ...fs, open: async (...args) => {
      if (storageUnavailable && args[1] === 'wx') throw Object.assign(new Error('hidden-private-volume'), { code: 'EROFS' });
      return fs.open(...args);
    } } });
    service = createDetectionService(config, { store, now: () => now, runtimeFactory: (value) => {
      callbacks = value; return { start() {}, async stop() {} };
    } });
    await service.start();
    for (const [cameraId, occurredAt] of [['cam1', '2026-10-03T16:00:00.000Z'], ['cam2', '2026-10-03T15:59:59.000Z']]) {
      await store.commit(cameraId, { event: { id: `event_${cameraId}`, cameraId, cameraName: cameraId,
        occurredAt, recordedAt: new Date(now).toISOString(), count: 1, score: 0.9, timing: 'stream' } });
    }
    server = createApp(config, { detection: service }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'test-password' }) });
    token = (await login.json()).accessToken;
    cookie = login.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await service?.stop();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  });

  it('requires authentication before status/events/settings and before parsing mutation bodies', async () => {
    for (const [route, method] of [['/api/detection', 'GET'], ['/api/person-events', 'GET'],
      ['/api/cameras/cam1/detection', 'POST'], ['/api/cameras/unknown/detection', 'POST']]) {
      const response = await fetch(`${baseUrl}${route}`, { method,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{invalid' } : {}) });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
  });

  it('returns shared status/events for cookie and bearer sessions without exposing checkpoints', async () => {
    const response = await request('/api/detection');
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.enabled, true);
    assert.equal(status.retentionDays, 7);
    assert.deepEqual(status.cameras.map((camera) => camera.cameraId), ['cam1', 'cam2']);
    assert.equal(status.cameras[0].enabled, true);
    assert.ok(!JSON.stringify(status).includes('frameKey'));
    const events = await fetch(`${baseUrl}/api/person-events`, { headers: { Cookie: cookie } });
    assert.equal(events.status, 200);
    assert.equal((await events.json()).total, 2);
    assert.match(events.headers.get('cache-control'), /no-store/);
  });

  it('filters events by configured local recording date and camera with correct pagination totals', async () => {
    const localDate = await request('/api/person-events?date=2026-10-04');
    assert.deepEqual((await localDate.json()).events.map((item) => item.cameraId), ['cam1']);
    const previous = await request('/api/person-events?date=2026-10-03&cameraId=cam2');
    assert.deepEqual((await previous.json()).events.map((item) => item.cameraId), ['cam2']);
    const page = await (await request('/api/person-events?limit=1&offset=1')).json();
    assert.equal(page.total, 2);
    assert.equal(page.limit, 1);
    assert.equal(page.offset, 1);
    assert.equal(page.events.length, 1);
  });

  it('rejects invalid, repeated, unknown and unbounded event query parameters', async () => {
    for (const query of ['date=2026-02-30', 'date=2026-10-04&date=2026-10-03', 'limit=0', 'limit=101',
      'limit=2.5', 'limit=2&limit=3', 'offset=-1', 'offset=9007199254740992',
      'cameraId=cam1&cameraId=cam2', 'extra=1']) {
      assert.equal((await request(`/api/person-events?${query}`)).status, 400, query);
    }
    assert.equal((await request('/api/person-events?cameraId=unknown')).status, 404);
  });

  it('rejects cross-origin setting writes and malformed or additional body fields', async () => {
    assert.equal((await toggle({ enabled: false }, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await toggle({ enabled: false }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: false, cameraId: 'cam2' }, []]) {
      assert.equal((await toggle(body)).status, 400);
    }
    assert.equal((await toggle({ enabled: false }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request('/api/cameras/cam1/detection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
    })).status, 400);
    assert.equal((await toggle({ enabled: true, padding: 'x'.repeat(2000) })).status, 413);
    assert.equal(store.enabled('cam1'), true);
  });

  it('saves a setting before acknowledging and returns the acknowledged camera status', async () => {
    const result = await toggle({ enabled: false }, { Origin: 'http://localhost' });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).state, 'disabled');
    const disk = JSON.parse(await fs.readFile(path.join(config.eventsRoot, 'events.json'), 'utf8'));
    assert.equal(disk.settings.cam1, false);
    assert.equal(callbacks.isEnabled('cam1'), false);
    assert.equal((await toggle({ enabled: true })).status, 200);
    assert.equal((await request('/api/cameras/unknown/detection', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status, 404);
  });

  it('model errors leave readiness healthy; storage failure returns 503 without changing settings or leaking paths', async () => {
    callbacks.onStatus('cam1', { state: 'error', message: 'Model is unavailable' });
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal((await request('/api/detection')).status, 200);
    storageUnavailable = true;
    try {
      const response = await toggle({ enabled: false });
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes('hidden-private-volume'));
      assert.equal(store.enabled('cam1'), true);
      assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
      assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
      assert.equal((await request('/api/person-events')).status, 200);
      const status = await (await request('/api/detection')).json();
      assert.equal(status.cameras[0].state, 'error');
    } finally { storageUnavailable = false; }
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
  });

  it('validates detection configuration bounds and keeps event storage separate from video storage', () => {
    const env = { JWT_SECRET: config.jwtSecret, AUTH_USERNAME: config.username, AUTH_PASSWORD_HASH: config.passwordHash,
      DATA_ROOT: config.dataRoot, EVENTS_ROOT: config.eventsRoot };
    assert.equal(loadConfig(env).detectionEnabled, false);
    assert.equal(loadConfig(env).detectionIntervalMs, 2000);
    assert.equal(loadConfig(env).eventRetentionDays, 7);
    assert.equal(loadConfig(env).eventMaxCount, 20_000);
    for (const invalid of [{ DETECTION_ENABLED: '1' }, { DETECTION_INTERVAL_MS: '499' }, { DETECTION_INTERVAL_MS: '60001' },
      { EVENT_RETENTION_DAYS: '0' }, { EVENT_RETENTION_DAYS: '91' }, { EVENT_MAX_COUNT: '99' }, { EVENT_MAX_COUNT: '100001' },
      { EVENTS_ROOT: config.dataRoot }, { EVENTS_ROOT: path.join(config.dataRoot, 'events') },
      { EVENTS_ROOT: path.dirname(config.dataRoot) }]) assert.throws(() => loadConfig({ ...env, ...invalid }));
  });
});
