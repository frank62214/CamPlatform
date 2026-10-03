import * as tf from '@tensorflow/tfjs-core'
import { ObjectDetection, type DetectedObject } from '@tensorflow-models/coco-ssd'
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import wasmUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url'
import simdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url'
import threadedSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url'

type Request = { type: 'load' } | {
  type: 'detect'; id: number; width: number; height: number; buffer: ArrayBuffer
}
type Reply = { type: 'ready' } | { type: 'error'; message: string } | {
  type: 'result'; id: number; predictions: DetectedObject[]
}
const worker = globalThis as unknown as {
  postMessage(message: Reply): void
  onmessage: ((event: MessageEvent<Request>) => void) | null
}

let model: ObjectDetection | null = null
let loading: Promise<void> | null = null
let busy = false

function load() {
  loading ??= (async () => {
    // Keep inference on one worker CPU thread, independent of the video/rendering GPU.
    // No cross-origin isolation or SharedArrayBuffer is required.
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false)
    setThreadsCount(1)
    // TFJS validates every binary path even though threading is disabled above.
    setWasmPaths({
      'tfjs-backend-wasm.wasm': wasmUrl,
      'tfjs-backend-wasm-simd.wasm': simdUrl,
      'tfjs-backend-wasm-threaded-simd.wasm': threadedSimdUrl,
    })
    if (!await tf.setBackend('wasm')) throw new Error('WebAssembly detector backend is unavailable')
    await tf.ready()
    model = new ObjectDetection('lite_mobilenet_v2')
    await model.load()
  })()
  return loading
}

function reportError() {
  // The main-thread client terminates this worker, releasing its model and any
  // tensors left by an interrupted third-party load or inference operation.
  worker.postMessage({ type: 'error', message: 'Person detector failed' })
}

async function detect(request: Extract<Request, { type: 'detect' }>) {
  if (!model || busy || !Number.isSafeInteger(request.id) ||
    !Number.isInteger(request.width) || !Number.isInteger(request.height) ||
    request.width <= 0 || request.height <= 0 || request.width * request.height > 640 * 640 ||
    !(request.buffer instanceof ArrayBuffer) || request.buffer.byteLength !== request.width * request.height * 4) {
    reportError()
    return
  }
  busy = true
  let input: tf.Tensor3D | undefined
  try {
    input = tf.browser.fromPixels({
      data: new Uint8Array(request.buffer), width: request.width, height: request.height,
    })
    const predictions = await model.detect(input, 20, 0.5)
    worker.postMessage({ type: 'result', id: request.id, predictions })
  } catch {
    reportError()
  } finally {
    input?.dispose()
    busy = false
  }
}

worker.onmessage = (event) => {
  if (event.data.type === 'load') {
    void load().then(() => worker.postMessage({ type: 'ready' }), reportError)
  } else if (event.data.type === 'detect') {
    void detect(event.data)
  }
}
