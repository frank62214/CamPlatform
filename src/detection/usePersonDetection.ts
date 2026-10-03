import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { acquirePersonDetector } from './person-model'
import { createPersonPresence } from './person-presence.js'

export interface PersonObservation {
  occurredAt: string
  count: number
  score: number
  timing: 'stream' | 'estimated'
}

export function usePersonDetection(
  video: Ref<HTMLVideoElement | null>,
  source: () => string,
  isLive: () => boolean,
  frameTime: () => { time: number; timing: PersonObservation['timing'] },
  notify: (event: PersonObservation) => void,
) {
  const enabled = ref(false)
  const status = ref<'off' | 'loading' | 'waiting' | 'watching' | 'paused' | 'error'>('off')
  const present = ref(false)
  const count = ref(0)
  const latest = ref<PersonObservation | null>(null)
  const gate = createPersonPresence()
  let lease: ReturnType<typeof acquirePersonDetector> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let disposed = false
  let lastFrame = -1
  let mediaRevision = 0
  let canvas: HTMLCanvasElement | null = null

  const statusText = computed(() => ({
    off: '人物偵測已關閉', loading: '正在準備人物偵測…',
    waiting: '等待影像播放', watching: '人物偵測中', paused: '偵測已暫停',
    error: '人物偵測暫時無法使用，請重試。',
  })[status.value])

  function clearObservations(resetFrame = false) {
    mediaRevision++
    if (resetFrame) lastFrame = -1
    gate.reset()
    present.value = false
    count.value = 0
  }

  function stop() {
    revision++
    clearTimeout(timer)
    lease?.release()
    lease = null
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null }
    clearObservations(true)
    status.value = 'off'
  }

  function suspend() {
    clearObservations()
    if (enabled.value && status.value !== 'loading' && status.value !== 'error') {
      status.value = document.hidden || video.value?.paused ? 'paused' : 'waiting'
    }
  }

  async function start() {
    stop()
    if (!enabled.value || !isLive() || disposed) return
    const current = revision
    status.value = 'loading'
    try {
      const acquired = acquirePersonDetector()
      lease = acquired
      await acquired.ready
      if (current !== revision || disposed) return
      status.value = 'waiting'
      const tick = async () => {
        if (current !== revision || disposed) return
        const startedAt = performance.now()
        const element = video.value
        if (document.hidden || !element || element.paused || element.ended || element.seeking ||
          element.readyState < 2 || !element.videoWidth || !element.videoHeight || element.currentTime === lastFrame) {
          suspend()
        } else {
          lastFrame = element.currentTime
          const observedRevision = mediaRevision
          const valid = () => current === revision && observedRevision === mediaRevision && !disposed &&
            !document.hidden && !element.paused && !element.seeking && element.readyState >= 2
          try {
            canvas ??= document.createElement('canvas')
            // Keep the main-thread snapshot small; model loading and inference run in the worker.
            const scale = Math.min(1, 320 / Math.max(element.videoWidth, element.videoHeight))
            const width = Math.max(1, Math.round(element.videoWidth * scale))
            const height = Math.max(1, Math.round(element.videoHeight * scale))
            if (canvas.width !== width) canvas.width = width
            if (canvas.height !== height) canvas.height = height
            const context = canvas.getContext('2d', { willReadFrequently: true })
            if (!context) throw new Error('Canvas is unavailable')
            const clock = frameTime()
            context.drawImage(element, 0, 0, canvas.width, canvas.height)
            const frame = context.getImageData(0, 0, width, height)
            const predictions = await acquired.detect(frame, valid)
            if (valid()) {
              const state = gate.update(predictions, performance.now())
              status.value = 'watching'
              present.value = state.present
              count.value = state.present && state.count === 0 ? count.value : state.count
              if (state.notify) {
                const observation: PersonObservation = {
                  occurredAt: new Date(clock.time).toISOString(), timing: clock.timing,
                  count: state.count, score: state.score,
                }
                latest.value = observation
                notify(observation)
              }
            }
          } catch {
            if (current !== revision || disposed) return
            if (valid()) {
              stop()
              status.value = 'error'
              return
            }
          }
        }
        // Slower devices get a longer rest between frames instead of continuously consuming CPU.
        const delay = Math.max(1000, Math.min(5000, performance.now() - startedAt))
        if (current === revision && !disposed) timer = setTimeout(() => void tick(), delay)
      }
      void tick()
    } catch {
      if (current === revision && !disposed) {
        stop()
        status.value = 'error'
      }
    }
  }

  // Invalidate in-flight results on interruptions, even if playback resumes before inference finishes.
  const interruptions = ['pause', 'waiting', 'seeking', 'ended', 'emptied', 'error']
  let attached: HTMLVideoElement | null = null
  onMounted(() => {
    attached = video.value
    for (const name of interruptions) attached?.addEventListener(name, suspend)
    document.addEventListener('visibilitychange', suspend)
  })
  watch([enabled, source, isLive], () => { latest.value = null; void start() })
  onBeforeUnmount(() => {
    disposed = true
    stop()
    for (const name of interruptions) attached?.removeEventListener(name, suspend)
    document.removeEventListener('visibilitychange', suspend)
  })

  return { enabled, status, statusText, present, count, latest, retry: start, suspend }
}
