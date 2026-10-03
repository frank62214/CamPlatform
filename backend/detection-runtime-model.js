import { Worker } from 'node:worker_threads';

export function createDetectionModel({ modelPath, loadTimeoutMs = 60_000, inferenceTimeoutMs = 10_000, WorkerClass = Worker }) {
  const worker = new WorkerClass(new URL('./detection-worker.js', import.meta.url), { workerData: { modelPath } });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  let request = null;
  let nextId = 0;
  let closed = false;
  let closing;
  let timer = setTimeout(() => fail(new Error('Detector model loading timed out')), loadTimeoutMs);
  function fail(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    readyReject(error);
    request?.reject(error);
    request = null;
    closing = worker.terminate();
  }
  worker.on('message', (message) => {
    if (closed) return;
    if (message?.type === 'ready') { clearTimeout(timer); readyResolve(); }
    else if (message?.type === 'result' && message.id === request?.id && Array.isArray(message.predictions)) {
      clearTimeout(timer);
      const pending = request;
      request = null;
      pending.resolve(message.predictions);
    } else if (message?.type === 'error') fail(new Error('Detector model could not process the frame'));
  });
  worker.on('error', () => fail(new Error('Detector worker failed')));
  worker.on('exit', () => { if (!closed) fail(new Error('Detector worker stopped')); });
  return {
    ready,
    async detect(bytes) {
      await ready;
      if (closed) throw new Error('Detector is stopped');
      if (request) throw new Error('Detector already has a frame');
      return new Promise((resolve, reject) => {
        request = { id: ++nextId, resolve, reject };
        timer = setTimeout(() => fail(new Error('Detector inference timed out')), inferenceTimeoutMs);
        // Copy pooled Node Buffers to an exclusively owned, transferable ArrayBuffer.
        const buffer = Uint8Array.from(bytes).buffer;
        try { worker.postMessage({ type: 'detect', id: request.id, buffer }, [buffer]); }
        catch { fail(new Error('Detector could not receive the frame')); }
      });
    },
    async stop() { fail(new Error('Detection stopped')); await closing; },
  };
}
