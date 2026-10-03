const MAX_FRAME_PIXELS = 640 * 640

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  // A stopped component may never reach its await; still settle its promise.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function aborted() {
  return new DOMException('Person detection was cancelled', 'AbortError')
}

/** Browser-independent transport; a worker factory and timers can be injected in tests. */
export function createPersonWorkerClient(createWorker, {
  loadTimeoutMs = 60_000,
  inferenceTimeoutMs = 10_000,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  let current = null
  let nextId = 0

  function settle(job, error, predictions = []) {
    if (job.settled) return
    job.settled = true
    if (error) job.result.reject(error)
    else job.result.resolve(predictions)
  }

  function stop(state, error) {
    if (state.status === 'closed') return
    state.status = 'closed'
    state.error = error
    if (current === state) current = null
    cancel(state.loadTimer)
    cancel(state.inferenceTimer)
    if (state.worker) {
      state.worker.removeEventListener('message', state.onMessage)
      state.worker.removeEventListener('error', state.onError)
      state.worker.removeEventListener('messageerror', state.onError)
      state.worker.terminate()
    }
    for (const lease of state.leases) lease.ready.reject(error)
    if (state.active) settle(state.active, error)
    for (const job of state.queue) settle(job, error)
    state.active = null
    state.queue = []
  }

  function isValid(job) {
    if (job.lease.released) return false
    try { return job.isCurrent() } catch (error) { settle(job, error); return false }
  }

  function pump(state) {
    if (state.status !== 'ready' || state.active || current !== state) return
    while (state.queue.length > 0) {
      const job = state.queue.shift()
      if (!isValid(job)) { settle(job, null); continue }
      state.active = job
      state.inferenceTimer = schedule(() => {
        stop(state, new Error('Person detection timed out; retry to restart the detector'))
      }, inferenceTimeoutMs)
      try {
        const { width, height, data } = job.frame
        // ImageData normally owns its entire buffer. Copy only unusual sliced views.
        const pixels = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
          ? data : new Uint8ClampedArray(data)
        state.worker.postMessage({ type: 'detect', id: job.id, width, height, buffer: pixels.buffer }, [pixels.buffer])
        job.frame = null
      } catch (error) {
        stop(state, error instanceof Error ? error : new Error('Unable to send a detection frame'))
      }
      return
    }
  }

  function createState() {
    const state = {
      status: 'loading', error: null, worker: null, leases: new Set(),
      queue: [], active: null, loadTimer: undefined, inferenceTimer: undefined,
      onMessage: null, onError: null,
    }
    current = state
    state.onMessage = (event) => {
      if (current !== state || state.status === 'closed') return
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'ready' && state.status === 'loading') {
        cancel(state.loadTimer)
        state.status = 'ready'
        for (const lease of state.leases) lease.ready.resolve()
        pump(state)
      } else if (message.type === 'result' && state.active?.id === message.id) {
        if (!Array.isArray(message.predictions)) {
          stop(state, new Error('Person detector returned an invalid result'))
          return
        }
        cancel(state.inferenceTimer)
        const job = state.active
        state.active = null
        settle(job, null, isValid(job) ? message.predictions : [])
        pump(state)
      } else if (message.type === 'error') {
        stop(state, new Error('Person detector could not process the image; retry to restart it'))
      }
    }
    state.onError = (event) => {
      if (current !== state) return
      event.preventDefault?.()
      stop(state, new Error('Person detector stopped unexpectedly; retry to restart it'))
    }
    try {
      state.worker = createWorker()
      state.worker.addEventListener('message', state.onMessage)
      state.worker.addEventListener('error', state.onError)
      state.worker.addEventListener('messageerror', state.onError)
      state.loadTimer = schedule(() => {
        stop(state, new Error('Person detector loading timed out; check the connection and retry'))
      }, loadTimeoutMs)
      state.worker.postMessage({ type: 'load' })
    } catch (error) {
      stop(state, error instanceof Error ? error : new Error('Unable to start the person detector'))
    }
    return state
  }

  return {
    acquire() {
      const state = current ?? createState()
      const lease = { released: false, ready: deferred() }
      state.leases.add(lease)
      if (state.status === 'ready') lease.ready.resolve()
      else if (state.status === 'closed') lease.ready.reject(state.error)

      return {
        ready: lease.ready.promise,
        detect(frame, isCurrent = () => true) {
          if (lease.released) return Promise.resolve([])
          if (state.status === 'closed') return Promise.reject(state.error)
          if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
            frame.width <= 0 || frame.height <= 0 || frame.width * frame.height > MAX_FRAME_PIXELS ||
            !(frame.data instanceof Uint8ClampedArray) || !(frame.data.buffer instanceof ArrayBuffer) ||
            frame.data.byteLength !== frame.width * frame.height * 4) {
            return Promise.reject(new TypeError('Person detection requires a bounded RGBA image'))
          }
          if (state.queue.some((job) => job.lease === lease)) {
            return Promise.reject(new Error('A detection is already queued for this camera'))
          }
          const job = { id: ++nextId, lease, frame, isCurrent, result: deferred(), settled: false }
          state.queue.push(job)
          pump(state)
          return job.result.promise
        },
        release() {
          if (lease.released) return
          lease.released = true
          lease.ready.reject(aborted())
          state.leases.delete(lease)
          for (const job of state.queue) if (job.lease === lease) settle(job, null)
          state.queue = state.queue.filter((job) => job.lease !== lease)
          if (state.active?.lease === lease) settle(state.active, null)
          if (state.leases.size === 0) stop(state, aborted())
          else pump(state)
        },
      }
    },
  }
}
