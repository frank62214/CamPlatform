import path from 'node:path';
import { isPasswordHash } from './password.js';

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

export function loadConfig(env = process.env) {
  if (!env.JWT_SECRET || Buffer.byteLength(env.JWT_SECRET) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  }
  if (!env.AUTH_USERNAME || !/^[A-Za-z0-9_.@-]{1,128}$/.test(env.AUTH_USERNAME)) {
    throw new Error('AUTH_USERNAME is required (1-128 letters, numbers, _, ., @ or -)');
  }
  if (!isPasswordHash(env.AUTH_PASSWORD_HASH)) {
    throw new Error('AUTH_PASSWORD_HASH must be generated with npm run auth:setup');
  }
  const production = env.NODE_ENV === 'production';
  const secureValue = env.COOKIE_SECURE ?? (production ? 'true' : 'false');
  if (!['true', 'false'].includes(secureValue)) throw new Error('COOKIE_SECURE must be true or false');
  const cookieSecure = secureValue === 'true';
  if (production && !cookieSecure) throw new Error('Production requires COOKIE_SECURE=true');
  let publicOrigin;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== env.PUBLIC_ORIGIN) {
      throw new Error('PUBLIC_ORIGIN must be an http(s) origin without path or trailing slash');
    }
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin?.startsWith('https://')) {
    throw new Error('Production requires an https PUBLIC_ORIGIN');
  }
  const cameraIds = (env.CAMERA_IDS ?? 'cam1,cam2').split(',').map((id) => id.trim());
  if (!cameraIds.length || cameraIds.length > 16 || new Set(cameraIds).size !== cameraIds.length ||
      cameraIds.some((id) => !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ['api', 'healthz', 'readyz'].includes(id))) {
    throw new Error('CAMERA_IDS must be a unique comma-separated list of camera identifiers');
  }
  const recordingUtcOffset = env.RECORDING_UTC_OFFSET ?? '+08:00';
  if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(recordingUtcOffset)) {
    throw new Error('RECORDING_UTC_OFFSET must be an offset such as +08:00');
  }
  return Object.freeze({
    port: integer(env, 'PORT', 3000, 0, 65535),
    dataRoot: path.resolve(env.DATA_ROOT ?? '/data'),
    cameraIds, recordingUtcOffset,
    username: env.AUTH_USERNAME,
    passwordHash: env.AUTH_PASSWORD_HASH,
    jwtSecret: env.JWT_SECRET,
    jwtIssuer: 'cam-platform',
    jwtAudience: 'cam-platform-web',
    tokenTtlSeconds: integer(env, 'TOKEN_TTL_SECONDS', 3600, 1, 86400),
    cookieSecure, publicOrigin,
    cookieName: 'camplatform_session',
    loginRateLimitMax: integer(env, 'LOGIN_RATE_LIMIT_MAX', 20, 1, 1000),
    loginRateLimitWindowSeconds: integer(env, 'LOGIN_RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3600),
    maxSessions: 1000,
  });
}
