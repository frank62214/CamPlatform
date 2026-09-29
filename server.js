import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './backend/app.js';
import { loadConfig } from './backend/config.js';

export { createApp };

// Imports are safe for tests; the only runnable server uses the authenticated
// backend. All live/history routes share the same JWT authorization middleware.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = loadConfig();
    const server = createApp(config).listen(config.port, '0.0.0.0', () => {
      console.log(`CamPlatform API listening on port ${config.port}`);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10_000).unref();
      });
    }
  } catch (error) {
    console.error(`Cannot start CamPlatform: ${error.message}`);
    process.exitCode = 1;
  }
}
