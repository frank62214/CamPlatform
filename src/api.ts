export interface Session {
  user: { username: string }
  expiresAt: string | number
}

export interface Camera {
  id: string
  name: string
  liveUrl: string
}

export interface HistoryRecord {
  id: string
  timeStamp: string
  fileUrl: string | null
  size: number
  date: string
  name: string
  fileName: string
  time: string | null
  timePrecision: 'hour' | 'minute' | 'second' | null
  updatedAt: string
  status: 'ready' | 'recording' | 'unavailable'
}

export interface RecordingPage {
  records: HistoryRecord[]
  total: number
  limit: number
  offset: number
}

export interface DetectionCameraStatus {
  cameraId: string
  enabled: boolean
  state: 'disabled' | 'starting' | 'watching' | 'waiting' | 'error'
  present: boolean
  count: number
  lastFrameAt: string | null
  lastEventAt: string | null
  message?: string
}

export interface DetectionStatus {
  enabled: boolean
  retentionDays: number
  cameras: DetectionCameraStatus[]
}

export interface PersonEvent {
  id: string
  cameraId: string
  cameraName: string
  occurredAt: string
  recordedAt?: string
  count: number
  score: number
  timing: 'stream' | 'estimated'
}

export interface PersonEventPage {
  events: PersonEvent[]
  total: number
  limit: number
  offset: number
  retentionDays: number
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler?: () => void) {
  onUnauthorized = handler
}

export function handleUnauthorized() {
  onUnauthorized?.()
}

export function sameOriginUrl(path: string) {
  const url = new URL(path, window.location.origin)
  if (url.origin !== window.location.origin) {
    throw new Error('媒體網址必須與監控中心位於相同來源。')
  }
  return url.pathname + url.search
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  notifyUnauthorized = true,
): Promise<T> {
  const response = await fetch(sameOriginUrl(path), {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })

  if (!response.ok) {
    if (response.status === 401 && notifyUnauthorized) handleUnauthorized()
    // Do not expose server diagnostics or credentials in user-facing errors.
    throw new ApiError(response.status, `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登入已失效，請重新登入。'
    if (error.status === 403) return '目前沒有存取權限。'
    if (error.status === 429) return '請求過於頻繁，請稍後再試。'
  }
  return fallback
}

export function isAborted(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
