import express from 'express';
import { createAuth } from './auth.js';
import { createMedia, validDate } from './media.js';
import { HttpError } from './errors.js';
import { createEventClips } from './event-clips.js';
import { createDetectionService } from './detection-service.js';

function pagination(query) {
  const { date, limit = '50', offset = '0' } = query;
  if (date !== undefined && !validDate(date)) throw new HttpError(400, 'INVALID_DATE', 'Use a valid YYYY-MM-DD date');
  if (typeof limit !== 'string' || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      typeof offset !== 'string' || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
    throw new HttpError(400, 'INVALID_PAGINATION', 'limit must be 1-100 and offset must be a nonnegative integer');
  }
  return { date, limit: Number(limit), offset: Number(offset) };
}

export function createApp(config, { detection = createDetectionService(config) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const auth = createAuth(config);
  const media = createMedia(config);
  const eventClip = createEventClips(media, config);

  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer' });
    res.vary('Cookie');
    res.vary('Authorization');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try { await media.ready(); if (config.detectionEnabled) await detection.ready(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/api/auth/login', auth.checkOrigin, auth.rateLimit, express.json({ limit: '8kb' }), auth.login);

  // No unguarded express.static routes: authorization runs before all remaining routes,
  // including legacy paths, HEAD, Range, missing files and unknown cameras.
  app.use(auth.requireAuth);
  app.get('/api/auth/me', auth.me);
  app.post('/api/auth/logout', auth.checkOrigin, auth.logout);
  app.get('/api/detection', (_req, res) => res.json(detection.status()));
  app.get('/api/person-events', (req, res) => {
    if (Object.keys(req.query).some((key) => !['cameraId', 'date', 'limit', 'offset'].includes(key))) {
      throw new HttpError(400, 'INVALID_QUERY', 'Unknown event query parameter');
    }
    const query = pagination(req.query);
    if (req.query.cameraId !== undefined) {
      if (typeof req.query.cameraId !== 'string') throw new HttpError(400, 'INVALID_CAMERA', 'Use one cameraId');
      if (!config.cameraIds.includes(req.query.cameraId)) throw new HttpError(404, 'CAMERA_NOT_FOUND', 'Camera not found');
      query.cameraId = req.query.cameraId;
    }
    res.json(detection.events(query));
  });
  app.post('/api/cameras/:cameraId/detection', auth.checkOrigin, express.json({ limit: '1kb' }), async (req, res) => {
    if (!req.is('application/json')) throw new HttpError(415, 'INVALID_CONTENT_TYPE', 'Use application/json');
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') {
      throw new HttpError(400, 'INVALID_SETTING', 'Provide only enabled as a boolean');
    }
    res.json(await detection.setEnabled(req.params.cameraId, req.body.enabled));
  });
  app.get('/api/cameras', (_req, res) => res.json({ cameras: config.cameraIds.map((id) => ({
    id, name: ({ cam1: '客廳', cam2: '大門' })[id] ?? id, liveUrl: `/${id}/hls/stream.m3u8`,
  })) }));
  app.get('/api/cameras/:cameraId/dates', async (req, res) => res.json({ dates: await media.dates(req.params.cameraId) }));
  app.get('/api/cameras/:cameraId/event-clip', async (req, res) => res.json(await eventClip(req.params.cameraId, req.query.at)));
  app.get('/api/cameras/:cameraId/records', async (req, res) => {
    const { date, limit, offset } = pagination(req.query);
    const records = await media.records(req.params.cameraId, date);
    res.json({ records: records.slice(offset, offset + limit), total: records.length, limit, offset });
  });
  app.get('/:cameraId/api/records', async (req, res) => {
    const { date, limit, offset } = pagination(req.query);
    res.json((await media.records(req.params.cameraId, date)).slice(offset, offset + limit));
  });
  app.get('/:cameraId/hls/:filename', media.live);
  app.get('/:cameraId/api/records/:date/:filename', media.recording);
  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof HttpError ? error.status :
      error.type === 'entity.parse.failed' || error instanceof URIError ? 400 :
      error.type === 'entity.too.large' ? 413 : 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer');
    if (status >= 500) console.error('API request failed:', error.code ?? error.name);
    res.status(status).type('application/json').json({ error: {
      code: error instanceof HttpError ? error.code : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      message: error instanceof HttpError ? error.message : status < 500 ? 'Invalid request' : 'Unable to read camera storage',
    } });
  });
  return app;
}
