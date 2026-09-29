import type { PersonObservation } from './usePersonDetection'

export interface PersonEvent extends PersonObservation {
  id: string
  cameraId: string
  cameraName: string
}

export const EVENT_LIMIT = 200
export const eventStorageKey = (account: string) => `camplatform:person-events:v1:${encodeURIComponent(account)}`

export function readPersonEvents(account: string): PersonEvent[] {
  const input: unknown = JSON.parse(localStorage.getItem(eventStorageKey(account)) ?? '[]')
  if (!Array.isArray(input)) return []
  return input.filter((event): event is PersonEvent => event && typeof event === 'object' &&
    typeof event.id === 'string' && event.id.length < 100 &&
    typeof event.cameraId === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(event.cameraId) &&
    typeof event.cameraName === 'string' && event.cameraName.length < 200 &&
    typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) &&
    Number.isInteger(event.count) && event.count > 0 && event.count <= 100 &&
    Number.isFinite(event.score) && event.score >= 0 && event.score <= 1 &&
    ['stream', 'estimated'].includes(event.timing)).slice(0, EVENT_LIMIT)
}

export function savePersonEvents(account: string, events: PersonEvent[]) {
  localStorage.setItem(eventStorageKey(account), JSON.stringify(events.slice(0, EVENT_LIMIT)))
}
