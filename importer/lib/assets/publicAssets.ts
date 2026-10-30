import index from '@/data/assets/public-asset-index.json';
import assetFolders from '@/config/asset-folders.json';

// Generated from this checkout by next.config.js before build/dev compilation.
// Keep URL resolution independent of artwork being present in a server function.
const files = new Set<string>(index.files);
const hashes = index.hashes as Record<string, string>;
const folders = new Map<string, string[]>();
for (const file of files) {
  const split = file.lastIndexOf('/');
  const folder = split < 0 ? '' : file.slice(0, split);
  const names = folders.get(folder) ?? [];
  names.push(file.slice(split + 1));
  folders.set(folder, names);
}
const relative = (value: string) => value.replace(/^\/+|\/+$/g, '');
export function publicFiles(folder: string): string[] { return [...(folders.get(relative(folder)) ?? [])]; }
export function publicFileExists(file: string): boolean { return files.has(relative(file)); }
export function publicFileVersion(file: string): string | undefined { return hashes[relative(file)]; }

/* The top-level folders the site routes to an asset repository (config/asset-folders.json).
   A file the index lists in a folder the site does not map yet is published but not served:
   lib/content/urls.ts hands back its bare path, which 404s. */
const servedFolders = new Set(Object.entries(assetFolders).flatMap(([key, value]) => (key !== 'about' && Array.isArray(value) ? value : [])));
/** Published by the pinned asset repositories AND in a folder the site serves: safe to draw. */
export function servedAssetExists(file: string): boolean {
  const path = relative(file);
  return files.has(path) && servedFolders.has(path.split('/')[0]);
}
