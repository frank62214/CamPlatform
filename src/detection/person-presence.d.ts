export interface PresencePrediction {
  class: string
  score: number
  bbox?: [number, number, number, number]
}

export interface PersonPresenceState {
  present: boolean
  /** Number of qualifying people in the latest observation. */
  count: number
  /** Highest qualifying person confidence in the latest observation, or zero. */
  score: number
  /** True only on a confirmed entry outside the cooldown. */
  notify: boolean
}

export declare function createPersonPresence(): {
  /** Call only for a fresh analysed frame, using a finite monotonic timestamp. */
  update(predictions: PresencePrediction[], nowMs: number): PersonPresenceState
  /** Clears observations and presence, retaining the last notification time. */
  reset(): void
}
