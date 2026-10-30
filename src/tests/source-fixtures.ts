import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function midiTemplates(): string {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), '../app/features/midi');
  return readdirSync(folder)
    .filter((file) => file.endsWith('.html'))
    .map((file) => readFileSync(resolve(folder, file), 'utf8'))
    .join('\n');
}
