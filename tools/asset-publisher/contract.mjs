export const PREFIX = 'github-v1';
export const MAX_BYTES = 64_000_000;
export const REPOSITORIES = new Set([
  'arkpedia-image-assets', 'arkpedia-skin-assets', 'arkpedia-color-palette',
  'arkpedia-voice-japanese', 'arkpedia-voice-english', 'arkpedia-voice-mandarin',
  'arkpedia-voice-korean', 'arkpedia-voice-regional', 'arkpedia-sd-assets', 'arkpedia-l2d-assets', 'arkpedia-data',
]);
export const COMMIT = /^[a-f0-9]{40}$/;
export function validPath(path) {
  return typeof path === 'string' && path.length <= 1024 && !/[\\\u0000-\u001f\u007f]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function publicFile(repository, path) {
  if (!REPOSITORIES.has(repository) || !validPath(path)) return false;
  if (repository === 'arkpedia-data') return /^release\/.+\.json$/.test(path);
  if (repository.startsWith('arkpedia-voice-')) return /^(?:current|legacy)\/.+\.(?:mp3|ogg|wav)$/.test(path);
  return /\.(?:webp|png|jpe?g|gif|avif|svg|ico|json|atlas|skel|mp3|ogg|wav)$/.test(path);
}
// Compiled metadata can pin animation repositories independently of the main manifest.
export function assetReferences(text) {
  const references = new Map();
  for (const match of text.matchAll(/https:\/\/raw\.githubusercontent\.com\/arkpedia\/([a-z0-9-]+)\/([a-f0-9]{40})\//g)) {
    const [, repository, revision] = match;
    if (REPOSITORIES.has(repository) && repository !== 'arkpedia-data') references.set(`${repository}/${revision}`, { repository, revision });
  }
  return [...references.values()];
}
export const directory = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const readyKey = (repository, revision) => `${PREFIX}/ready/${repository}/${revision}.json`;
export const objectKey = hash => `${PREFIX}/objects/${hash}`;
export const indexKey = (repository, revision, shard) => `${PREFIX}/indexes/${repository}/${revision}/${shard}.json`;
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export const shardFor = path => sha256(new TextEncoder().encode(directory(path)));
export function descriptor(value) {
  return value && COMMIT.test(value.sha) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_BYTES;
}
