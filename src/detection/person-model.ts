import { createPersonWorkerClient, type PersonDetector } from './person-worker-client.js'

export type { DetectedObject } from '@tensorflow-models/coco-ssd'
export type { PersonDetector } from './person-worker-client.js'

const client = createPersonWorkerClient(() => new Worker(
  new URL('./person-worker.ts', import.meta.url), { type: 'module' },
))

/** Acquire synchronously so loading can be cancelled before the model is ready. */
export function acquirePersonDetector(): PersonDetector {
  return client.acquire()
}
