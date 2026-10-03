import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './backend/app.js';
import { loadConfig } from './backend/config.js';
import { createDetectionService } from './backend/detection-service.js';

export { createApp };

// Imports are safe for tests; the only runnable server uses the authenticated
// backend. All live/history routes share the same JWT authorization middleware.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = loadConfig();
    const detection = createDetectionService(config);
    await detection.start();
    const server = createApp(config, { detection }).listen(config.port, '0.0.0.0', () => {
      console.log(`CamPlatform API listening on port ${config.port}`);
    });
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        const closed = new Promise((resolve) => server.close(resolve));
        void Promise.all([closed, detection.stop()]).then(() => process.exit(0), () => process.exit(1));
        setTimeout(() => process.exit(0), 10_000).unref();
      });
    }
  } catch (error) {
    console.error(`Cannot start CamPlatform: ${error.message}`);
    process.exitCode = 1;
  }
}
