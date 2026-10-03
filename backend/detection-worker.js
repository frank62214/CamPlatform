import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tf = require('@tensorflow/tfjs-core');
const { ObjectDetection } = require('@tensorflow-models/coco-ssd');
const { setWasmPaths, setThreadsCount } = require('@tensorflow/tfjs-backend-wasm');
let model;
let busy = false;

async function localModel(modelPath) {
  const manifestStat = await lstat(modelPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4 * 1024 * 1024) {
    throw new Error('Invalid model manifest');
  }
  const manifest = JSON.parse(await readFile(modelPath, 'utf8'));
  if (!manifest.modelTopology || !Array.isArray(manifest.weightsManifest)) throw new Error('Invalid model manifest');
  const chunks = [];
  const weightSpecs = [];
  let bytes = 0;
  for (const group of manifest.weightsManifest) {
    if (!Array.isArray(group.paths) || !Array.isArray(group.weights)) throw new Error('Invalid model weights');
    weightSpecs.push(...group.weights);
    for (const name of group.paths) {
      if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(name)) throw new Error('Invalid model shard');
      const file = path.join(path.dirname(modelPath), name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid model shard');
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) throw new Error('Model is too large');
      chunks.push(await readFile(file));
    }
  }
  const weights = Buffer.concat(chunks);
  return { load: async () => ({
    modelTopology: manifest.modelTopology, weightSpecs,
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
    format: manifest.format, generatedBy: manifest.generatedBy, convertedBy: manifest.convertedBy,
  }) };
}

async function initialize() {
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  setThreadsCount(1);
  setWasmPaths(`${path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'))}${path.sep}`);
  if (!await tf.setBackend('wasm')) throw new Error('WASM unavailable');
  await tf.ready();
  // Supply an IOHandler so deployment never fetches model weights over the network.
  model = new ObjectDetection('lite_mobilenet_v2', await localModel(workerData.modelPath));
  await model.load();
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async (message) => {
  if (message?.type !== 'detect') return;
  if (!model || busy || !(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== 320 * 180 * 3) {
    parentPort.postMessage({ type: 'error' });
    return;
  }
  busy = true;
  let image;
  try {
    image = tf.tensor3d(new Uint8Array(message.buffer), [180, 320, 3], 'int32');
    const predictions = await model.detect(image, 20, 0.5);
    parentPort.postMessage({ type: 'result', id: message.id, predictions });
  } catch {
    parentPort.postMessage({ type: 'error' });
  } finally {
    image?.dispose();
    busy = false;
  }
});

void initialize().catch(() => parentPort.postMessage({ type: 'error' }));
