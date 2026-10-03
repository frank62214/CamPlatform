import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Pin the COCO-SSD lite_mobilenet_v2 artifacts, including the graph's shard map.
// The server image includes these files; production inference never downloads a model.
const base = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const files = {
  'model.json': '3770b2528339b1e3340cb74360e1e40401816b009779aeb8d0cce3a4353ea3a9',
  'group1-shard1of5': '0e7af0f713e98521252321f7f84892c31cefccccec3ac64c84e5065b75ed5646',
  'group1-shard2of5': '74cc6cfc2c4510c9cd81b8ad4cebf6f6a8f305119bb365ce0eb96276da38519a',
  'group1-shard3of5': '50383033f893eae136392a403e8f70ade5efd90867df5695c4ca5ac640e14f38',
  'group1-shard4of5': 'd856dc534c780068bbf6c666ce1516df2c8433d87578aa31fcdf197de7058cc2',
  'group1-shard5of5': '3d356f1fb6dfca6af78c56db34d9326706d0196e303f9de6b04f236ca79ed309',
};
const directory = path.resolve(process.argv[2] ?? 'models/person');
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
await mkdir(directory, { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const target = path.join(directory, name);
  if (await readFile(target).then((data) => hash(data) === expected, () => false)) continue;
  const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Model download failed (${response.status}): ${name}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== expected) throw new Error(`Model checksum mismatch: ${name}`);
  const temporary = `${target}.${process.pid}.tmp`;
  try { await writeFile(temporary, data); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
console.log('Pinned person-detection model is ready.');
