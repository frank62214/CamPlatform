import { createApp } from './backend/app.js';
import { loadConfig } from './backend/config.js';

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
