import type { DetectedObject } from '@tensorflow-models/coco-ssd'

export interface PersonDetector {
  ready: Promise<void>
  /** Transfers frame.data.buffer; the caller must not reuse that pixel buffer. */
  detect(frame: ImageData, isCurrent?: () => boolean): Promise<DetectedObject[]>
  release(): void
}

export interface PersonWorkerOptions {
  loadTimeoutMs?: number
  inferenceTimeoutMs?: number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export declare function createPersonWorkerClient(
  createWorker: () => Worker,
  options?: PersonWorkerOptions,
): { acquire(): PersonDetector }
