import type { DetectedObject, ObjectDetection } from '@tensorflow-models/coco-ssd'

export type { DetectedObject } from '@tensorflow-models/coco-ssd'

export interface PersonDetector {
  /** Queued calls read the frame only when their lease and caller are current. */
  detect(image: HTMLVideoElement | HTMLCanvasElement, isCurrent?: () => boolean): Promise<DetectedObject[]>
  release(): void
}

let model: ObjectDetection | null = null
let loading: Promise<ObjectDetection> | null = null
let leases = 0
let pendingInferences = 0
let inferenceQueue: Promise<void> = Promise.resolve()

function disposeIfIdle() {
  if (leases !== 0 || pendingInferences !== 0 || loading || !model) return
  const previous = model
  model = null
  previous.dispose()
}

async function loadModel() {
  const [tf, coco] = await Promise.all([
    import('@tensorflow/tfjs-core'),
    import('@tensorflow-models/coco-ssd'),
    import('@tensorflow/tfjs-backend-cpu'),
    import('@tensorflow/tfjs-backend-webgl'),
  ])
  // Both backends are required: COCO-SSD runs its WebGL postprocessing on CPU.
  let webglReady = false
  try { webglReady = await tf.setBackend('webgl') } catch { /* Fall back on CPU. */ }
  if (!webglReady && !await tf.setBackend('cpu')) throw new Error('Person detector backend is unavailable')
  await tf.ready()

  const detector = new coco.ObjectDetection('lite_mobilenet_v2')
  try {
    await detector.load()
    return detector
  } catch (error) {
    detector.dispose()
    throw error
  }
}

function getModel() {
  if (model) return Promise.resolve(model)
  if (!loading) {
    loading = loadModel().then((loaded) => {
      model = loaded
      return loaded
    }).finally(() => {
      loading = null
      disposeIfIdle()
    })
  }
  return loading
}

/** Share one lazy model across cameras, with serialized inference and safe disposal. */
export async function acquirePersonDetector(): Promise<PersonDetector> {
  leases++
  let detector: ObjectDetection
  try {
    detector = await getModel()
  } catch (error) {
    leases--
    disposeIfIdle()
    throw error
  }

  let released = false
  return {
    detect(image, isCurrent = () => true) {
      if (released) return Promise.resolve([])
      pendingInferences++
      const operation = inferenceQueue.then(async () => {
        if (released || !isCurrent()) return []
        const predictions = await detector.detect(image, 20, 0.5)
        return released || !isCurrent() ? [] : predictions
      }).finally(() => {
        pendingInferences--
        disposeIfIdle()
      })
      // Recover the queue after errors so one failed camera cannot block others.
      inferenceQueue = operation.then(() => undefined, () => undefined)
      return operation
    },
    release() {
      if (released) return
      released = true
      leases--
      disposeIfIdle()
    },
  }
}
