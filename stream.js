import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Producer only: set RTSP_URL and DATA_ROOT, then run `npm run stream -- 0`.
// The index selects ipCamConfig.json; only the JWT backend serves generated HLS.
async function main() {
  const index = process.argv[2];
  if (process.argv.length !== 3 || !/^(?:0|[1-9]\d*)$/.test(index ?? '')) {
    throw new Error('Usage: npm run stream -- <camera-index> (for example: 0). Set RTSP_URL and DATA_ROOT in the environment.');
  }
  const cameras = JSON.parse(await readFile(new URL('./ipCamConfig.json', import.meta.url), 'utf8'));
  const camera = Array.isArray(cameras) ? cameras[Number(index)] : undefined;
  if (!camera || !/^[a-z][a-z0-9_-]{0,31}$/.test(camera.folderName ?? '')) {
    throw new Error('Camera index does not select a valid configured camera folder. Check ipCamConfig.json.');
  }

  const rtspUrl = process.env.RTSP_URL?.trim();
  if (!rtspUrl) throw new Error('RTSP_URL is required; supply the camera address and credentials through the environment.');
  let source;
  try { source = new URL(rtspUrl); } catch { throw new Error('RTSP_URL must be a valid rtsp:// or rtsps:// URL.'); }
  if (!['rtsp:', 'rtsps:'].includes(source.protocol) || !source.hostname) {
    throw new Error('RTSP_URL must be a valid rtsp:// or rtsps:// URL.');
  }

  const hlsFolder = path.join(path.resolve(process.env.DATA_ROOT ?? '/data'), camera.folderName, 'hls');
  await mkdir(hlsFolder, { recursive: true });
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-y',
    '-rtsp_transport', 'tcp',
    '-analyzeduration', '10000000', '-probesize', '10000000',
    '-i', rtspUrl,
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+omit_endlist+temp_file+program_date_time',
    '-hls_segment_filename', path.join(hlsFolder, 'stream_%03d.ts'),
    path.join(hlsFolder, 'stream.m3u8'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stopping = false;
  let failedToStart = false;
  let shutdownTimer;
  let diagnostics = '';
  const report = (line) => {
    // FFmpeg sometimes includes the input URL in its diagnostics. Never log credentials.
    const redacted = line.replaceAll(rtspUrl, '[RTSP source]').replace(/rtsps?:\/\/\S+/gi, '[RTSP source]');
    if (redacted.trim()) console.error(`[ffmpeg:${camera.folderName}] ${redacted}`);
  };
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk) => {
    diagnostics += chunk;
    const lines = diagnostics.split(/\r?\n|\r/);
    diagnostics = lines.pop();
    for (const line of lines) report(line);
    // Do not let an unterminated diagnostic line grow memory indefinitely.
    if (diagnostics.length > 65536) diagnostics = '';
  });
  ffmpeg.once('spawn', () => console.log(`Producing HLS for ${camera.folderName} in ${hlsFolder}. Playback requires the JWT backend.`));
  ffmpeg.once('error', (error) => {
    failedToStart = true;
    console.error(`Unable to run ffmpeg (${error.code ?? 'PROCESS_ERROR'}). Verify ffmpeg is installed and available on PATH.`);
    process.exitCode = 1;
  });

  function stop(signal) {
    if (stopping || failedToStart) return;
    stopping = true;
    console.log(`Stopping ${camera.folderName} producer (${signal}).`);
    ffmpeg.kill('SIGTERM');
    shutdownTimer = setTimeout(() => ffmpeg.kill('SIGKILL'), 10000);
    shutdownTimer.unref();
  }
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  ffmpeg.once('close', (code, signal) => {
    clearTimeout(shutdownTimer);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    if (diagnostics) report(diagnostics);
    if (!stopping && !failedToStart) {
      console.error(`ffmpeg stopped unexpectedly (exit ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
      process.exitCode = typeof code === 'number' && code > 0 ? code : 1;
    }
  });
}

main().catch((error) => {
  console.error(`Unable to start HLS producer: ${error.message}`);
  process.exitCode = 1;
});
