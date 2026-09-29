const MIN_SCORE = 0.6
const POSITIVE_SAMPLES = 2
const NEGATIVE_SAMPLES = 3
const COOLDOWN_MS = 15_000

/**
 * Debounces person observations into presence episodes. Call once per fresh,
 * successfully analysed frame; stalled or skipped frames are not observations.
 * Count and score describe the latest frame, including while presence is retained
 * across one or two negative observations.
 */
export function createPersonPresence() {
  let present = false
  let positiveSamples = 0
  let negativeSamples = 0
  let lastNotificationAt = -Infinity

  return {
    /**
     * @param {Array<{class: string, score: number}>} predictions
     * @param {number} nowMs A finite monotonic timestamp in milliseconds.
     * @returns {{present: boolean, count: number, score: number, notify: boolean}}
     */
    update(predictions, nowMs) {
      if (!Number.isFinite(nowMs)) throw new TypeError('Observation timestamp must be finite')
      const people = predictions.filter((prediction) => prediction?.class === 'person' &&
        Number.isFinite(prediction.score) && prediction.score >= MIN_SCORE && prediction.score <= 1)
      const count = people.length
      const score = people.reduce((highest, person) => Math.max(highest, person.score), 0)
      let notify = false

      if (count > 0) {
        negativeSamples = 0
        positiveSamples = Math.min(positiveSamples + 1, POSITIVE_SAMPLES)
        if (!present && positiveSamples >= POSITIVE_SAMPLES) {
          present = true
          if (nowMs - lastNotificationAt >= COOLDOWN_MS) {
            notify = true
            lastNotificationAt = nowMs
          }
        }
      } else {
        positiveSamples = 0
        negativeSamples = Math.min(negativeSamples + 1, NEGATIVE_SAMPLES)
        if (negativeSamples >= NEGATIVE_SAMPLES) present = false
      }

      return { present, count, score, notify }
    },

    /** Clear interrupted observations without bypassing the alert cooldown. */
    reset() {
      present = false
      positiveSamples = 0
      negativeSamples = 0
    },
  }
}
