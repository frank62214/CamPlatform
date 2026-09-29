import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { loadConfig } from '../backend/config.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string', default: '.env' },
  output: { type: 'string', default: 'camplatform-auth.secret.json' },
} });
try {
  const env = parseEnv(await readFile(values['env-file'], 'utf8'));
  loadConfig(env);
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'camplatform-auth', namespace: 'ffmpeg' },
    type: 'Opaque', stringData: Object.fromEntries(['JWT_SECRET', 'AUTH_USERNAME', 'AUTH_PASSWORD_HASH'].map((key) => [key, env[key]])) };
  await writeFile(values.output, JSON.stringify(secret, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Created ${values.output}. Apply it to namespace ffmpeg using your normal secret management process, then remove the local Secret file.`);
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Output already exists; choose a new --output path.' : error.message);
  process.exitCode = 1;
}
