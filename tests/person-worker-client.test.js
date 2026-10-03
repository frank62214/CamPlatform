import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPersonWorkerClient } from '../src/detection/person-worker-client.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const person = { class: 'person', score: 0.91, bbox: [1, 2, 3, 4] }
const frame = (value = 0) => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(value) })

class Clock {
  now = 0
  next = 0
  tasks = new Map()
  setTimeout = (callback, delay) => {
    const id = ++this.next
    this.tasks.set(id, { callback, at: this.now + delay })
    return id
  }
  clearTimeout = (id) => this.tasks.delete(id)
  async advance(milliseconds) {
    const target = this.now + milliseconds
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= target)
        .sort((first, second) => first[1].at - second[1].at)[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.now = task.at
      task.callback()
      await flush()
    }
    this.now = target
    await flush()
  }
}

class Worker {
  messages = []
  listeners = new Map()
  terminated = 0
  postError = null
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(callback)
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback) }
  postMessage(message, transfer = []) {
    if (this.postError) throw this.postError
    // Real transfer semantics expose accidental buffer reuse and cloning.
    this.messages.push(structuredClone(message, { transfer }))
  }
  terminate() { this.terminated++ }
  emit(name, event) {
    this[`on${name}`]?.(event)
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
  message(data) { this.emit('message', { data }) }
  ready() { this.message({ type: 'ready' }) }
  detects() { return this.messages.filter((message) => message.type === 'detect') }
  result(id, predictions = [person]) { this.message({ type: 'result', id, predictions }) }
}

function setup(context, createWorker) {
  const workers = []
  const leases = []
  const clock = new Clock()
  const client = createPersonWorkerClient(() => {
    const worker = createWorker ? createWorker() : new Worker()
    workers.push(worker)
    return worker
  }, { loadTimeoutMs: 100, inferenceTimeoutMs: 50, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  context.after(() => { for (const lease of leases) lease.release() })
  return {
    workers, clock,
    acquire() {
      const lease = client.acquire()
      leases.push(lease)
      // Tests deliberately cancel or break loading leases. Attach a handler at
      // acquisition so immediate rejection is observed before the next assertion.
      void lease.ready.catch(() => {})
      return lease
    },
  }
}

const check = (name, run) => it(name, { timeout: 2000 }, run)

describe('person worker lifecycle, cancellation and recovery', () => {
  check('loads one lazy worker for two cameras and terminates only after the last lease', async (context) => {
    const env = setup(context)
    assert.equal(env.workers.length, 0)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    assert.equal(env.workers.length, 1)
    assert.deepEqual(worker.messages, [{ type: 'load' }])
    worker.ready()
    await Promise.all([first.ready, second.ready])
    assert.equal(env.clock.tasks.size, 0)
    first.release()
    first.release()
    assert.equal(worker.terminated, 0, 'camera B still owns the shared model')
    second.release()
    second.release()
    assert.equal(worker.terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
  })

  check('cancels a loading camera promptly while a second camera continues loading', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const rejected = assert.rejects(first.ready, { name: 'AbortError' })
    first.release()
    await rejected
    assert.equal(env.workers[0].terminated, 0)
    env.workers[0].ready()
    await second.ready
    second.release()
    assert.equal(env.workers[0].terminated, 1)
  })

  check('last release cancels a never-ready load and ignores late ready messages on retry', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const rejected = assert.rejects(first.ready, { name: 'AbortError' })
    first.release()
    await rejected
    assert.equal(env.workers[0].terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    const second = env.acquire()
    let ready = false
    void second.ready.then(() => { ready = true })
    env.workers[0].ready()
    await flush()
    assert.equal(ready, false)
    env.workers[1].ready()
    await second.ready
    assert.equal(ready, true)
  })

  check('serializes cameras and transfers each frame only when its inference starts', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    const firstFrame = frame(11)
    const secondFrame = frame(22)
    const firstResult = first.detect(firstFrame)
    const secondResult = second.detect(secondFrame)
    await flush()
    assert.equal(worker.detects().length, 1)
    assert.equal(firstFrame.data.byteLength, 0)
    assert.equal(secondFrame.data.byteLength, 16)
    assert.equal(new Uint8Array(worker.detects()[0].buffer)[0], 11)
    worker.result(worker.detects()[0].id)
    assert.deepEqual(await firstResult, [person])
    await flush()
    assert.equal(worker.detects().length, 2)
    assert.equal(secondFrame.data.byteLength, 0)
    assert.equal(new Uint8Array(worker.detects()[1].buffer)[0], 22)
    worker.result(worker.detects()[1].id, [])
    assert.deepEqual(await secondResult, [])
    assert.equal(env.clock.tasks.size, 0)
  })

  check('drops stale queued frames without transferring or analyzing them', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    let current = true
    const running = first.detect(frame())
    const staleFrame = frame()
    const queued = second.detect(staleFrame, () => current)
    await flush()
    current = false
    worker.result(worker.detects()[0].id)
    await running
    assert.deepEqual(await queued, [])
    assert.equal(staleFrame.data.byteLength, 16)
    assert.equal(worker.detects().length, 1)
    assert.equal(env.clock.tasks.size, 0)
  })

  check('discarding an in-flight observation does not return stale person predictions', async (context) => {
    const env = setup(context)
    const lease = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await lease.ready
    let current = true
    const result = lease.detect(frame(), () => current)
    await flush()
    current = false
    worker.result(worker.detects()[0].id)
    assert.deepEqual(await result, [])
  })

  check('releases active camera A without killing camera B or accepting A results', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    const running = first.detect(frame())
    const waiting = second.detect(frame())
    await flush()
    first.release()
    assert.deepEqual(await running, [])
    assert.equal(worker.terminated, 0)
    assert.equal(worker.detects().length, 1, 'B must not overlap A CPU work still running in the worker')
    worker.result(worker.detects()[0].id)
    await flush()
    assert.equal(worker.detects().length, 2)
    worker.result(worker.detects()[1].id)
    assert.deepEqual(await waiting, [person])
    second.release()
    assert.equal(worker.terminated, 1)
  })

  check('bounds queued work per camera and cancels it on release', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    const running = first.detect(frame())
    await flush()
    const queuedFrame = frame()
    const queued = first.detect(queuedFrame)
    const overflowFrame = frame()
    await assert.rejects(first.detect(overflowFrame), /already queued/i)
    first.release()
    assert.deepEqual(await running, [])
    assert.deepEqual(await queued, [])
    assert.equal(worker.detects().length, 1)
    assert.equal(queuedFrame.data.byteLength, 16)
    assert.equal(overflowFrame.data.byteLength, 16)
    second.release()
    assert.equal(worker.terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
  })

  check('keeps the watchdog alive when canceled camera A is still blocking camera B', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    const running = first.detect(frame())
    const waiting = second.detect(frame())
    const failure = assert.rejects(waiting)
    await flush()
    first.release()
    assert.deepEqual(await running, [])
    assert.equal(worker.terminated, 0)
    await env.clock.advance(50)
    await failure
    assert.equal(worker.terminated, 1, 'A cannot leave B permanently waiting after A was disabled')
    assert.equal(env.clock.tasks.size, 0)
  })

  check('last release terminates unresponsive inference and leaves no watchdog or queue behind', async (context) => {
    const env = setup(context)
    const lease = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await lease.ready
    const running = lease.detect(frame())
    await flush()
    const queued = lease.detect(frame())
    lease.release()
    assert.deepEqual(await running, [])
    assert.deepEqual(await queued, [])
    assert.equal(worker.terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    worker.result(worker.detects()[0].id)
    await env.clock.advance(100)
    assert.equal(worker.terminated, 1)
  })

  check('times out a hung load for all cameras and allows a fresh generation to load', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const failures = [assert.rejects(first.ready), assert.rejects(second.ready)]
    await env.clock.advance(99)
    assert.equal(env.workers[0].terminated, 0)
    await env.clock.advance(1)
    await Promise.all(failures)
    assert.equal(env.workers[0].terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    const retry = env.acquire()
    first.release()
    second.release()
    assert.equal(env.workers[1].terminated, 0, 'old lease releases must not decrement the replacement generation')
    env.workers[1].ready()
    await retry.ready
  })

  check('times out hung inference, rejects queued cameras, and ignores old results after retry', async (context) => {
    const env = setup(context)
    const first = env.acquire()
    const second = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await Promise.all([first.ready, second.ready])
    const running = first.detect(frame())
    const waiting = second.detect(frame())
    const failures = [assert.rejects(running), assert.rejects(waiting)]
    await flush()
    const oldId = worker.detects()[0].id
    await env.clock.advance(49)
    assert.equal(worker.terminated, 0)
    await env.clock.advance(1)
    await Promise.all(failures)
    assert.equal(worker.terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    const retry = env.acquire()
    const replacement = env.workers[1]
    replacement.ready()
    await retry.ready
    const result = retry.detect(frame())
    let completed = false
    void result.then(() => { completed = true })
    await flush()
    assert.notEqual(replacement.detects()[0].id, oldId)
    worker.result(oldId)
    first.release()
    second.release()
    await flush()
    assert.equal(completed, false)
    assert.equal(replacement.terminated, 0)
    replacement.result(replacement.detects()[0].id)
    assert.deepEqual(await result, [person])
  })

  check('recovers from a worker-reported model load failure', async (context) => {
    const env = setup(context)
    const lease = env.acquire()
    const failure = assert.rejects(lease.ready)
    env.workers[0].message({ type: 'error', message: 'Model download failed' })
    await failure
    assert.equal(env.workers[0].terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    const retry = env.acquire()
    env.workers[1].ready()
    await retry.ready
  })

  check('settles active and queued work when the worker crashes or cannot deserialize a message', async (context) => {
    for (const eventName of ['error', 'messageerror']) {
      const env = setup(context)
      const first = env.acquire()
      const second = env.acquire()
      const worker = env.workers[0]
      worker.ready()
      await Promise.all([first.ready, second.ready])
      const failures = [assert.rejects(first.detect(frame())), assert.rejects(second.detect(frame()))]
      await flush()
      worker.emit(eventName, { message: 'Worker crashed', preventDefault() {} })
      await Promise.all(failures)
      assert.equal(worker.terminated, 1)
      assert.equal(env.clock.tasks.size, 0)
    }
  })

  check('reports worker construction failure through ready and permits retry', async (context) => {
    let attempts = 0
    const env = setup(context, () => {
      if (++attempts === 1) throw new Error('Worker creation unavailable')
      return new Worker()
    })
    const failed = env.acquire()
    await assert.rejects(failed.ready, /Worker creation unavailable/)
    assert.equal(env.clock.tasks.size, 0)
    const retry = env.acquire()
    env.workers[0].ready()
    await retry.ready
    failed.release()
    assert.equal(env.workers[0].terminated, 0)
  })

  check('cleans up when transferring an inference frame throws', async (context) => {
    const env = setup(context)
    const lease = env.acquire()
    const worker = env.workers[0]
    worker.ready()
    await lease.ready
    worker.postError = new Error('Frame transfer failed')
    await assert.rejects(lease.detect(frame()))
    assert.equal(worker.terminated, 1)
    assert.equal(env.clock.tasks.size, 0)
    const retry = env.acquire()
    env.workers[1].ready()
    await retry.ready
  })
})
