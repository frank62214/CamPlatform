import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { hashPassword } from '../backend/password.js';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: '.env' },
  username: { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
} });

try {
  let username = values.username;
  let password;
  if (values['password-stdin']) {
    if (!username) throw new Error('--username is required with --password-stdin');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  } else {
    if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or --username NAME --password-stdin');
    let hidden = false;
    const output = new Writable({ write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    try {
      username = username ?? await rl.question('Username: ');
      process.stdout.write('Password (12+ characters; hidden): ');
      hidden = true;
      password = await rl.question('');
      process.stdout.write('\nConfirm password (hidden): ');
      const confirmation = await rl.question('');
      process.stdout.write('\n');
      if (password !== confirmation) throw new Error('Passwords do not match');
    } finally { hidden = false; rl.close(); }
  }
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(username)) throw new Error('Invalid username');
  const passwordHash = await hashPassword(password);
  const contents = [
    '# Contains local secrets. Never commit this file.',
    'NODE_ENV=development', 'PORT=3000', 'DATA_ROOT=/data', 'CAMERA_IDS=cam1,cam2',
    'COOKIE_SECURE=false', 'TOKEN_TTL_SECONDS=3600', 'RECORDING_UTC_OFFSET=+08:00',
    `AUTH_USERNAME=${username}`, `AUTH_PASSWORD_HASH='${passwordHash}'`,
    `JWT_SECRET=${randomBytes(48).toString('base64url')}`, '',
  ].join('\n');
  await writeFile(values.output, contents, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${values.output}. Set DATA_ROOT to your recording directory before starting the API.`);
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Output already exists; choose a new --output path to avoid replacing secrets.' : error.message);
  process.exitCode = 1;
}
