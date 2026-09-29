import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../stream.js', import.meta.url));
function run(args, rtspUrl = '') {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, RTSP_URL: rtspUrl }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
}

describe('standalone HLS producer input validation', () => {
  it('rejects missing, malformed and out-of-range camera indexes before launching ffmpeg', () => {
    for (const args of [[], ['-1'], ['cam1'], ['0.5'], ['999'], ['0', 'extra']]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Usage:|Camera index/);
      assert.ok(!result.stdout.includes('Producing HLS'));
    }
  });

  it('requires a camera URL in the environment', () => {
    const result = run(['0']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RTSP_URL is required/);
  });

  it('rejects invalid or non-RTSP sources without logging supplied credentials', () => {
    for (const url of ['invalid-input', 'https://test-user:private-password@example.test/video']) {
      const result = run(['0'], url);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /RTSP_URL must be a valid/);
      assert.ok(!result.stderr.includes('private-password'));
      assert.ok(!result.stderr.includes(url));
    }
  });
});
