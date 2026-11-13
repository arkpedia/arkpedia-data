import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function withEventMediaPin(pins, revision) {
  if (!Array.isArray(pins)) throw new Error('Expected immutable source pins');
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Expected a full animation repository commit');
  const repository = 'arkpedia-l2d-assets';
  return pins.some(pin => pin.repository === repository && pin.revision === revision)
    ? pins : [...pins, { repository, revision }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  const pins = withEventMediaPin(JSON.parse(await readFile(file, 'utf8')), process.env.ANIMATION_REVISION);
  await writeFile(file, JSON.stringify(pins, null, 2) + '\n');
}
