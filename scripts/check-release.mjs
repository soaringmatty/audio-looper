import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist/audio-looper/browser');
const expectedBase = '/audio-looper/';
const forbiddenNames = /^(?:CNAME|\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12))$/i;
const privateAddress =
  /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
const localHome = /(?:[A-Z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[A-Za-z0-9_.-]+/;
async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symlinks are not allowed in the release');
    if (forbiddenNames.test(entry.name))
      throw Error('Unexpected sensitive configuration in release');
    if (entry.isDirectory()) files.push(...(await walk(file)));
    else files.push(file);
  }
  return files;
}
const files = await walk(output);
for (const file of files) {
  if (file.endsWith('.map')) throw Error('Source maps must not be published');
  if (/\.(?:html|js|css|json|txt)$/.test(file)) {
    const text = await fs.readFile(file, 'utf8');
    if (privateAddress.test(text) || localHome.test(text))
      throw Error('Private address or local home path in release');
  }
}
const index = await fs.readFile(path.join(output, 'index.html'), 'utf8');
if (
  !index.includes(`<base href="${expectedBase}">`) &&
  !index.includes(`<base href="${expectedBase}" />`)
)
  throw Error('Unexpected production base path');
for (const file of [
  'clock-worker.js',
  'audio/looper-processor.js',
  'audio/pcm-processor.js',
  'audio/SpessaSynth-LICENSE.txt',
  'audio/SpessaSynthCore-LICENSE.txt',
])
  await fs.access(path.join(output, file));
const manifest = JSON.parse(
  await fs.readFile(path.join(output, 'soundfonts/sources.json'), 'utf8'),
);
for (const asset of manifest) {
  const stat = await fs.stat(path.join(output, 'soundfonts', asset.name));
  if (stat.size !== asset.bytes) throw Error('Soundbank release size mismatch');
}
console.log(
  `Release check passed: ${files.length} files, expected base path, worklets, soundbanks and licenses.`,
);
