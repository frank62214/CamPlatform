import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { verifyPassword } from './password.js';
import { HttpError } from './errors.js';

export function createAuth(config) {
  const key = new TextEncoder().encode(config.jwtSecret);
  // One replica by design. Restart drops sessions; logout revokes every copy of this token.
  const sessions = new Map();
  const attempts = new Map();
  let passwordChecks = 0;
  const cookieOptions = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' };

  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.exp * 1000 <= now) sessions.delete(id);
    for (const [id, window] of attempts) if (window.until <= now) attempts.delete(id);
  }

  function checkOrigin(req, _res, next) {
    const allowed = config.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
    if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== allowed)) {
      throw new HttpError(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    next();
  }

  function rateLimit(req, res, next) {
    prune();
    // Deliberately use the socket peer; never trust client-supplied X-Forwarded-For.
    const id = req.ip;
    let window = attempts.get(id);
    if (!window) {
      if (attempts.size >= 10_000) throw new HttpError(429, 'RATE_LIMITED', 'Please try again later');
      window = { count: 0, until: Date.now() + config.loginRateLimitWindowSeconds * 1000 };
      attempts.set(id, window);
    }
    window.count++;
    if (window.count > config.loginRateLimitMax || passwordChecks >= 4) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((window.until - Date.now()) / 1000))));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts. Please try again later');
    }
    next();
  }

  async function login(req, res) {
    if (!req.is('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Send application/json');
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 128 || typeof password !== 'string' || password.length > 1024) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
    }
    let valid;
    passwordChecks++;
    try { valid = await verifyPassword(password, config.passwordHash); }
    finally { passwordChecks--; }
    if (!valid || username !== config.username) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
    }
    prune();
    if (sessions.size >= config.maxSessions) throw new HttpError(429, 'SESSION_LIMIT', 'Too many active sessions');
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.tokenTtlSeconds;
    const accessToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(config.username).setJti(jti).setIssuedAt(now).setExpirationTime(exp)
      .setIssuer(config.jwtIssuer).setAudience(config.jwtAudience).sign(key);
    sessions.set(jti, { exp });
    res.cookie(config.cookieName, accessToken, { ...cookieOptions, maxAge: config.tokenTtlSeconds * 1000 });
    res.json({ accessToken, tokenType: 'Bearer', expiresIn: config.tokenTtlSeconds,
      expiresAt: new Date(exp * 1000).toISOString(), user: { username: config.username } });
  }

  async function requireAuth(req, _res, next) {
    const header = req.get('authorization');
    let token;
    if (header !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(header);
      token = match?.[1];
    } else {
      const cookies = (req.get('cookie') ?? '').split(';').map((part) => part.trim());
      const matches = cookies.filter((part) => part.startsWith(`${config.cookieName}=`));
      if (matches.length === 1) token = matches[0].slice(config.cookieName.length + 1);
    }
    try {
      if (!token || token.length > 4096) throw new Error('Missing token');
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'], typ: 'JWT', issuer: config.jwtIssuer, audience: config.jwtAudience,
        requiredClaims: ['sub', 'exp', 'iat', 'jti'],
      });
      const session = sessions.get(payload.jti);
      if (payload.sub !== config.username || !session || session.exp !== payload.exp) throw new Error('Invalid session');
      req.auth = payload;
      next();
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'Please sign in again');
    }
  }

  function me(req, res) {
    res.json({ user: { username: req.auth.sub }, expiresAt: new Date(req.auth.exp * 1000).toISOString() });
  }

  function logout(req, res) {
    sessions.delete(req.auth.jti);
    res.clearCookie(config.cookieName, cookieOptions);
    res.status(204).end();
  }

  return { checkOrigin, rateLimit, login, requireAuth, me, logout };
}
