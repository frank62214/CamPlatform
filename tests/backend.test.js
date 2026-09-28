import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../backend/app.js'
import { loadConfig } from '../backend/config.js'
import { hashPassword } from '../backend/password.js'

const secret = 'long-random-test-key-at-least-32-bytes'
const password = 'test-password'
const username = 'tester'

function atom(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length + 8)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, data])
}

// The server checks MP4 container finalization, not codecs. A moov box makes
// these tiny fixtures complete containers for that check; no ffmpeg is needed.
const mp4 = Buffer.concat([
  atom('ftyp', Buffer.from('isom\0\0\0\0isomiso2')),
  atom('mdat', Buffer.from('recording-frame-data-for-http-byte-range-tests')),
  atom('moov', atom('free')),
])
const incompleteMp4 = Buffer.concat([atom('ftyp', Buffer.from('isom\0\0\0\0isom')), atom('mdat', Buffer.alloc(24))])
const outsideMarker = 'outside-recording-root-must-never-be-returned'

function signedToken(payload, header = { alg: 'HS256', typ: 'JWT' }, signingSecret = secret) {
  const encoded = [header, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
  return `${encoded}.${createHmac('sha256', signingSecret).update(encoded).digest('base64url')}`
}

describe('authenticated camera backend', () => {
  let temporaryDirectory
  let dataRoot
  let baseUrl
  let server
  let configuration
  let session
  let canCreateFileSymlinks = false
  let canCreateDirectorySymlinks = false

  const request = (pathname, options) => fetch(`${baseUrl}${pathname}`, options)
  const bearer = (token = session.accessToken) => ({ Authorization: `Bearer ${token}` })
  const cookieHeader = () => ({ Cookie: session.cookie })
  const login = async (options = {}) => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify({ username, password, ...options.credentials }),
    })
    const result = await response.json()
    return { response, ...result, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const expectRejected = async (response, expectedStatus) => {
    assert.ok(response.status >= 400 && response.status < 500, `expected 4xx, got ${response.status}`)
    if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus)
    assert.ok(!(await response.text()).includes(outsideMarker), 'outside bytes were disclosed')
  }

  before(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cam-platform-api-'))
    dataRoot = path.join(temporaryDirectory, 'data')
    const files = {
      'cam1/2026-09-06/2026-09-06_03.mp4': mp4,
      'cam1/2026-09-06/12.mp4': mp4,
      'cam1/2026-09-07/2026-09-07_23.mp4': mp4,
      'cam1/2026-09-07/08.mp4': incompleteMp4,
      'cam1/2026-09-07/07.mp4': 'not an mp4',
      'cam1/2026-09-07/06.mp4': Buffer.concat([mp4, Buffer.alloc(4)]),
      'cam1/2026-09-07/notes.txt': 'not a recording',
      'cam1/2026-09-08/01.mp4': incompleteMp4,
      'cam1/invalid-date/12.mp4': mp4,
      'cam1/2026-02-30/12.mp4': mp4,
      'cam1/hls/stream.m3u8': '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment000.ts\n',
      'cam1/hls/segment000.ts': Buffer.from('test-transport-stream-segment'),
      'cam1/hls/.private': outsideMarker,
      'cam1/private.txt': outsideMarker,
      'cam2/2026-09-07/01.mp4': mp4,
    }
    for (const [filename, data] of Object.entries(files)) {
      const fullPath = path.join(dataRoot, filename)
      await mkdir(path.dirname(fullPath), { recursive: true })
      await writeFile(fullPath, data)
    }
    await mkdir(path.join(dataRoot, 'cam1/2026-09-04'), { recursive: true })
    const outsideDirectory = path.join(temporaryDirectory, 'outside')
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, '04.mp4'), Buffer.concat([mp4, atom('free', Buffer.from(outsideMarker))]))
    await writeFile(path.join(outsideDirectory, 'segment.ts'), outsideMarker)
    await writeFile(path.join(outsideDirectory, 'stream.m3u8'), outsideMarker)
    try {
      await symlink(path.join(outsideDirectory, '04.mp4'), path.join(dataRoot, 'cam1/2026-09-07/04.mp4'), 'file')
      await symlink(path.join(outsideDirectory, 'segment.ts'), path.join(dataRoot, 'cam1/hls/escape.ts'), 'file')
      canCreateFileSymlinks = true
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    }
    try {
      await symlink(outsideDirectory, path.join(dataRoot, 'cam1/2026-09-05'), process.platform === 'win32' ? 'junction' : 'dir')
      await symlink(outsideDirectory, path.join(dataRoot, 'cam2/hls'), process.platform === 'win32' ? 'junction' : 'dir')
      canCreateDirectorySymlinks = true
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    }
    configuration = loadConfig({
      NODE_ENV: 'test',
      DATA_ROOT: dataRoot,
      JWT_SECRET: secret,
      AUTH_USERNAME: username,
      AUTH_PASSWORD_HASH: await hashPassword(password),
      COOKIE_SECURE: 'false',
      CAMERA_IDS: 'cam1,cam2',
      TOKEN_TTL_SECONDS: '3600',
      PUBLIC_ORIGIN: 'http://localhost',
    })
    server = createApp(configuration).listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
    session = await login()
    assert.equal(session.response.status, 200, 'fixture login must succeed')
  })

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (temporaryDirectory) {
      assert.equal(path.dirname(path.resolve(temporaryDirectory)), path.resolve(tmpdir()))
      assert.ok(path.basename(temporaryDirectory).startsWith('cam-platform-api-'))
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('issues a signed JWT and an HttpOnly same-site cookie on successful login', async () => {
    assert.equal(session.tokenType, 'Bearer')
    assert.equal(session.expiresIn, 3600)
    assert.deepEqual(session.user, { username })
    assert.ok(session.expiresAt)
    assert.match(session.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/)
    const setCookie = session.response.headers.get('set-cookie')
    assert.match(setCookie, /;\s*HttpOnly/i)
    assert.match(setCookie, /;\s*SameSite=(?:Lax|Strict)/i)
    assert.match(setCookie, /;\s*Path=\//i)
    assert.match(session.response.headers.get('cache-control'), /no-store/i)
    assert.doesNotMatch(setCookie, /;\s*Secure(?:;|$)/i)
    assert.ok(!JSON.stringify(session.user).includes(password))
  })

  it('rejects wrong credentials without issuing a token', async () => {
    for (const credentials of [{ password: 'incorrect' }, { username: 'unknown-user' }]) {
      const result = await login({ credentials })
      assert.equal(result.response.status, 401)
      assert.equal(result.accessToken, undefined)
      assert.equal(result.response.headers.get('set-cookie'), null)
    }
  })

  it('rejects invalid login bodies', async () => {
    for (const body of [{}, { username: 17, password }, { username, password: [] }]) {
      await expectRejected(await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
    }
  })

  it('accepts cookie and bearer authentication for current-user API', async () => {
    for (const headers of [bearer(), cookieHeader()]) {
      const response = await request('/api/auth/me', { headers })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body.user, { username })
      assert.ok(body.expiresAt)
    }
  })

  it('rejects unauthenticated API, live media, historical media and legacy requests', async () => {
    const paths = [
      '/api/auth/me', '/api/cameras', '/api/cameras/cam1/records', '/api/cameras/cam1/dates',
      '/cam1/hls/stream.m3u8', '/cam1/hls/segment000.ts', '/cam1/api/records',
      '/cam1/api/records/2026-09-06/12.mp4',
    ]
    for (const pathname of paths) {
      await expectRejected(await request(pathname), 401)
      await expectRejected(await request(pathname, { method: 'HEAD' }), 401)
      await expectRejected(await request(pathname, { headers: { Range: 'bytes=0-7' } }), 401)
    }
  })

  it('rejects malformed, expired, forged, unsigned and wrong-algorithm JWTs', async () => {
    const payload = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString('utf8'))
    const invalidTokens = [
      'invalid',
      `${session.accessToken.slice(0, -6)}abcdef`,
      signedToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }),
      signedToken(payload, undefined, 'attacker-controlled-key'),
      signedToken(payload, { alg: 'none', typ: 'JWT' }).replace(/\.[^.]*$/, '.'),
      signedToken(payload, { alg: 'HS512', typ: 'JWT' }),
      signedToken({ ...payload, jti: 'unregistered-attacker-session' }),
      signedToken({ ...payload, iss: 'untrusted-issuer' }),
      signedToken({ ...payload, aud: 'another-application' }),
      signedToken({ ...payload, sub: 'another-user' }),
    ]
    for (const token of invalidTokens) {
      await expectRejected(await request('/api/auth/me', { headers: bearer(token) }), 401)
      await expectRejected(await request('/cam1/hls/stream.m3u8', { headers: bearer(token) }), 401)
    }
  })

  it('does not accept JWTs through query strings', async () => {
    await expectRejected(await request(`/cam1/hls/stream.m3u8?token=${session.accessToken}`), 401)
    await expectRejected(await request(`/cam1/api/records/2026-09-06/12.mp4?access_token=${session.accessToken}`), 401)
  })

  it('does not fall back to cookie authentication after an invalid Authorization header', async () => {
    await expectRejected(await request('/api/auth/me', { headers: { ...cookieHeader(), Authorization: 'Bearer invalid' } }), 401)
  })

  it('rejects cross-origin login and logout without revoking the current session', async () => {
    const crossOriginLogin = await login({ headers: { Origin: 'https://attacker.example.test' } })
    assert.equal(crossOriginLogin.response.status, 403)
    await expectRejected(await request('/api/auth/logout', {
      method: 'POST', headers: { ...cookieHeader(), Origin: 'https://attacker.example.test' },
    }), 403)
    await expectRejected(await request('/api/auth/logout', {
      method: 'POST', headers: { ...cookieHeader(), 'Sec-Fetch-Site': 'cross-site' },
    }), 403)
    assert.equal((await request('/api/auth/me', { headers: bearer() })).status, 200)
  })

  it('lists configured cameras and same-origin guarded live URLs', async () => {
    const response = await request('/api/cameras', { headers: bearer() })
    assert.equal(response.status, 200)
    const { cameras } = await response.json()
    assert.deepEqual(cameras.map((camera) => camera.id), ['cam1', 'cam2'])
    for (const camera of cameras) {
      assert.equal(camera.liveUrl, `/${camera.id}/hls/stream.m3u8`)
      assert.equal(typeof camera.name, 'string')
    }
  })

  it('lists finalized recordings from both supported filename formats in descending order', async () => {
    const response = await request('/api/cameras/cam1/records', { headers: bearer() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.total, 3)
    assert.equal(body.limit, 50)
    assert.equal(body.offset, 0)
    assert.deepEqual(body.records.map((record) => record.name), ['2026-09-07_23.mp4', '12.mp4', '2026-09-06_03.mp4'])
    for (const record of body.records) {
      assert.ok(record.id)
      assert.ok(record.timeStamp)
      assert.equal(record.size, mp4.length)
      assert.match(record.date, /^2026-09-0[67]$/)
      assert.equal(record.fileUrl, `/cam1/api/records/${record.date}/${record.name}`)
      assert.ok(!JSON.stringify(record).includes(dataRoot), 'response must not expose filesystem paths')
    }
  })

  it('filters by date and paginates without changing the filtered total', async () => {
    const response = await request('/api/cameras/cam1/records?date=2026-09-06&limit=1&offset=1', { headers: bearer() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.total, 2)
    assert.equal(body.limit, 1)
    assert.equal(body.offset, 1)
    assert.deepEqual(body.records.map((record) => record.name), ['2026-09-06_03.mp4'])
    const emptyResponse = await request('/api/cameras/cam1/records?date=2026-09-03', { headers: bearer() })
    assert.equal(emptyResponse.status, 200)
    assert.deepEqual((await emptyResponse.json()).records, [])
    const pastEnd = await request('/api/cameras/cam1/records?offset=500', { headers: bearer() })
    assert.equal(pastEnd.status, 200)
    const pastEndBody = await pastEnd.json()
    assert.equal(pastEndBody.total, 3)
    assert.deepEqual(pastEndBody.records, [])
  })

  it('lists valid date directories including empty/current dates without following symlinks', async () => {
    const response = await request('/api/cameras/cam1/dates', { headers: bearer() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).dates, ['2026-09-08', '2026-09-07', '2026-09-06', '2026-09-04'])
  })

  it('keeps camera histories separate and preserves the protected legacy array API', async () => {
    const secondCamera = await request('/api/cameras/cam2/records', { headers: bearer() })
    assert.equal(secondCamera.status, 200)
    const secondBody = await secondCamera.json()
    assert.equal(secondBody.total, 1)
    assert.equal(secondBody.records[0].fileUrl, '/cam2/api/records/2026-09-07/01.mp4')
    const legacy = await request('/cam1/api/records', { headers: cookieHeader() })
    assert.equal(legacy.status, 200)
    const legacyBody = await legacy.json()
    assert.ok(Array.isArray(legacyBody))
    assert.equal(legacyBody.length, 3)
  })

  it('rejects invalid date and pagination parameters', async () => {
    const queries = [
      'date=2026-02-30', 'date=2026-2-03', 'date=..%2F..', 'limit=0', 'limit=-1',
      'limit=abc', 'limit=1.5', 'offset=-1', 'offset=abc', 'offset=1.5',
    ]
    for (const query of queries) {
      await expectRejected(await request(`/api/cameras/cam1/records?${query}`, { headers: bearer() }), 400)
    }
  })

  it('rejects unknown camera IDs on modern and legacy media APIs', async () => {
    for (const pathname of ['/api/cameras/cam99/records', '/api/cameras/cam99/dates', '/cam99/hls/stream.m3u8', '/cam99/api/records']) {
      await expectRejected(await request(pathname, { headers: bearer() }), 404)
    }
  })

  it('serves authenticated HLS playlists and segments using the session cookie', async () => {
    const manifest = await request('/cam1/hls/stream.m3u8', { headers: cookieHeader() })
    assert.equal(manifest.status, 200)
    assert.match(await manifest.text(), /#EXTM3U/)
    assert.match(manifest.headers.get('cache-control'), /no-store/i)
    const segment = await request('/cam1/hls/segment000.ts', { headers: cookieHeader() })
    assert.equal(segment.status, 200)
    assert.equal(await segment.text(), 'test-transport-stream-segment')
  })

  it('returns historical MP4 data and metadata for GET and HEAD', async () => {
    const pathname = '/cam1/api/records/2026-09-06/12.mp4'
    const response = await request(pathname, { headers: cookieHeader() })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^video\/mp4(?:;|$)/)
    assert.equal(Number(response.headers.get('content-length')), mp4.length)
    assert.match(response.headers.get('cache-control'), /no-store/i)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4)
    const head = await request(pathname, { method: 'HEAD', headers: bearer() })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), mp4.length)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  })

  it('supports bounded, open-ended and suffix byte ranges for playback seeking', async () => {
    for (const [range, first, last] of [['bytes=0-7', 0, 7], ['bytes=8-', 8, mp4.length - 1], ['bytes=-8', mp4.length - 8, mp4.length - 1]]) {
      const response = await request('/cam1/api/records/2026-09-06/12.mp4', { headers: { ...bearer(), Range: range } })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), `bytes ${first}-${last}/${mp4.length}`)
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4.subarray(first, last + 1))
    }
  })

  it('returns 416 for an unsatisfiable range', async () => {
    const response = await request('/cam1/api/records/2026-09-06/12.mp4', { headers: { ...bearer(), Range: 'bytes=99999-' } })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), `bytes */${mp4.length}`)
    assert.match(response.headers.get('content-type'), /^application\/json(?:;|$)/)
  })

  it('does not expose incomplete MP4s, non-recording files or hidden HLS files', async () => {
    for (const pathname of [
      '/cam1/api/records/2026-09-07/08.mp4', '/cam1/api/records/2026-09-07/07.mp4',
      '/cam1/api/records/2026-09-07/06.mp4',
      '/cam1/api/records/2026-09-07/notes.txt', '/cam1/hls/.private',
    ]) await expectRejected(await request(pathname, { headers: bearer() }))
  })

  it('blocks encoded traversal and unsupported direct filesystem URLs', async () => {
    for (const pathname of [
      '/cam1/api/records/2026-09-07/..%2F..%2Fprivate.txt',
      '/cam1/api/records/%2e%2e%2fhls/segment000.ts',
      '/cam1/api/records/2026-09-07/..%5C..%5Cprivate.txt',
      '/cam1/hls/..%2Fprivate.txt', '/cam1/hls/..%5Cprivate.txt',
      '/cam1/hls/%00stream.m3u8', '/cam1/2026-09-06/12.mp4',
      '/data/cam1/2026-09-06/12.mp4', '/video/cam1/2026-09-06/12.mp4',
    ]) await expectRejected(await request(pathname, { headers: bearer() }))
  })

  it('blocks symlinked recording files and HLS segments escaping the camera root', async (context) => {
    if (!canCreateFileSymlinks) return context.skip('OS does not permit creation of file symlinks')
    await expectRejected(await request('/cam1/api/records/2026-09-07/04.mp4', { headers: bearer() }))
    await expectRejected(await request('/cam1/hls/escape.ts', { headers: bearer() }))
  })

  it('blocks symlinked date directories escaping the camera root', async (context) => {
    if (!canCreateDirectorySymlinks) return context.skip('OS does not permit creation of directory symlinks')
    await expectRejected(await request('/cam1/api/records/2026-09-05/04.mp4', { headers: bearer() }))
    const listing = await request('/api/cameras/cam1/records?date=2026-09-05', { headers: bearer() })
    if (listing.status === 200) assert.deepEqual((await listing.json()).records, [])
    else await expectRejected(listing)
  })

  it('blocks a symlinked HLS directory escaping the camera root', async (context) => {
    if (!canCreateDirectorySymlinks) return context.skip('OS does not permit creation of directory symlinks')
    await expectRejected(await request('/cam2/hls/stream.m3u8', { headers: bearer() }))
  })

  it('revokes a logged-out token for both cookie and bearer media requests', async () => {
    const ownSession = await login()
    assert.equal(ownSession.response.status, 200)
    const response = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: ownSession.cookie } })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('set-cookie'), /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i)
    for (const headers of [{ Cookie: ownSession.cookie }, bearer(ownSession.accessToken)]) {
      await expectRejected(await request('/api/auth/me', { headers }), 401)
      await expectRejected(await request('/cam1/hls/stream.m3u8', { headers }), 401)
      await expectRejected(await request('/cam1/api/records/2026-09-06/12.mp4', { headers }), 401)
    }
    assert.equal((await request('/api/auth/me', { headers: bearer() })).status, 200, 'logging out another session should not revoke this one')
  })

  it('sets Secure cookies when configured for production HTTPS', async () => {
    const secureConfig = loadConfig({
      NODE_ENV: 'production', DATA_ROOT: dataRoot, JWT_SECRET: secret,
      AUTH_USERNAME: username, AUTH_PASSWORD_HASH: await hashPassword(password),
      COOKIE_SECURE: 'true', CAMERA_IDS: 'cam1,cam2', TOKEN_TTL_SECONDS: '3600',
      PUBLIC_ORIGIN: 'https://nightwatch.example.test',
    })
    const secureServer = createApp(secureConfig).listen(0, '127.0.0.1')
    await once(secureServer, 'listening')
    try {
      const response = await fetch(`http://127.0.0.1:${secureServer.address().port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('set-cookie'), /;\s*Secure(?:;|$)/i)
      assert.match(response.headers.get('set-cookie'), /;\s*HttpOnly/i)
    } finally {
      await new Promise((resolve, reject) => secureServer.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('expires legitimately issued sessions and invalidates sessions after a backend restart', async () => {
    const shortLivedConfig = { ...configuration, tokenTtlSeconds: 1 }
    const otherServer = createApp(shortLivedConfig).listen(0, '127.0.0.1')
    await once(otherServer, 'listening')
    const otherUrl = `http://127.0.0.1:${otherServer.address().port}`
    try {
      await expectRejected(await fetch(`${otherUrl}/api/auth/me`, { headers: bearer() }), 401)
      const response = await fetch(`${otherUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      })
      assert.equal(response.status, 200)
      const shortLived = await response.json()
      await delay(Math.max(0, Date.parse(shortLived.expiresAt) - Date.now()) + 30)
      for (const pathname of ['/api/auth/me', '/cam1/hls/stream.m3u8', '/cam1/api/records/2026-09-06/12.mp4']) {
        await expectRejected(await fetch(`${otherUrl}${pathname}`, { headers: bearer(shortLived.accessToken) }), 401)
      }
    } finally {
      await new Promise((resolve, reject) => otherServer.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('orders custom historical filenames by actual time when using filesystem timestamp fallback', async () => {
    const filename = path.join(dataRoot, 'cam1/2026-09-06/custom-recording.mp4')
    await writeFile(filename, mp4)
    // 05:00 UTC is 13:00 Taipei, later than the named 12:00 recording.
    const modified = new Date('2026-09-06T05:00:00Z')
    await utimes(filename, modified, modified)
    try {
      const response = await request('/api/cameras/cam1/records?date=2026-09-06', { headers: bearer() })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body.records.map((record) => record.name), ['custom-recording.mp4', '12.mp4', '2026-09-06_03.mp4'])
    } finally {
      await rm(filename)
    }
  })

  it('limits repeated login attempts and does not trust spoofed client IP headers', async () => {
    const limitedServer = createApp({ ...configuration, loginRateLimitMax: 2 }).listen(0, '127.0.0.1')
    await once(limitedServer, 'listening')
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`http://127.0.0.1:${limitedServer.address().port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${attempt + 1}` },
          body: JSON.stringify({ username, password: 'incorrect-password' }),
        })
        assert.equal(response.status, attempt < 2 ? 401 : 429)
        if (attempt === 2) assert.ok(Number(response.headers.get('retry-after')) > 0)
        await response.arrayBuffer()
      }
    } finally {
      await new Promise((resolve, reject) => limitedServer.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('backend configuration and password handling', () => {
  it('produces a salted password hash instead of storing the password', async () => {
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    assert.equal(typeof first, 'string')
    assert.ok(first.length > password.length)
    assert.notEqual(first, second)
    assert.ok(!first.includes(password))
  })

  it('refuses to start with a missing or weak JWT key', async () => {
    const env = {
      NODE_ENV: 'test', AUTH_USERNAME: username, AUTH_PASSWORD_HASH: await hashPassword(password),
      COOKIE_SECURE: 'false', CAMERA_IDS: 'cam1', DATA_ROOT: tmpdir(),
    }
    assert.throws(() => loadConfig(env), /JWT_SECRET/)
    assert.throws(() => loadConfig({ ...env, JWT_SECRET: 'short-secret' }), /JWT_SECRET/)
  })
})
