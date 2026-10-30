import fs from 'node:fs';
import path from 'node:path';

/** Importers need an availability index, not a downloaded copy of the asset repo. */
export function assetFileNames(folder, root = process.cwd()) {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'data/assets/external-asset-index.json'), 'utf8'));
  const prefix = `${folder}/`;
  const published = index.files.filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
    .map(file => file.slice(prefix.length));
  const local = path.join(root, 'public', folder);
  return [...new Set([...published, ...(fs.existsSync(local) ? fs.readdirSync(local) : [])])].sort();
}
