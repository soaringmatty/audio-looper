import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../public/soundfonts/', import.meta.url);
const manifestUrl = new URL('sources.json', root);
const assets = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
await fs.mkdir(root, { recursive: true });
for (const asset of assets) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(asset.name)) throw Error('Invalid asset name');
  const file = new URL(asset.name, root);
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Soundbank download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (
    bytes.length !== asset.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== asset.sha256
  )
    throw Error(`Soundbank checksum or size mismatch: ${asset.name}`);
  if (
    asset.name.endsWith('.sf2') &&
    (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'sfbk')
  )
    throw Error(`Invalid SoundFont: ${asset.name}`);
  await fs.writeFile(file, bytes);
  console.log(`Verified ${asset.name} (${bytes.length} bytes)`);
}
