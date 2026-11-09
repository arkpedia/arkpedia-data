// Small immutable source-to-storage maps. Files stay byte-for-byte unchanged;
// complete model bundles always share one physical revision and relative base.
const COMMIT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^arkpedia-(?:(?:image|skin|sd|l2d)-assets|color-palette|voice-(?:english|japanese|mandarin|korean|regional))$/;
export const MAX_MEDIA_DELIVERY_BYTES = 64_000;
export function mediaGroup(repository, path) {
  const parts = path.split('/');
  if (/^arkpedia-(?:sd|l2d)-assets$/.test(repository) && parts[0] === 'models') {
    const bundle = parts.findIndex((part, i) => i > 0 && /^(?:[a-f0-9]{12}|[a-f0-9]{40})$/.test(part));
    return bundle < 0 ? 'models' : parts.slice(0, bundle + 1).join('/');
  }
  return parts.slice(0, -1).join('/');
}
export function validateMediaDelivery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || new TextEncoder().encode(JSON.stringify(value)).length > MAX_MEDIA_DELIVERY_BYTES) throw Error('Invalid media delivery size');
  for (const [repository, revisions] of Object.entries(value)) {
    if (!REPOSITORY.test(repository) || !revisions || typeof revisions !== 'object' || Array.isArray(revisions)) throw Error('Invalid media delivery repository');
    for (const [revision, map] of Object.entries(revisions)) {
      if (!COMMIT.test(revision) || !map || map.version !== 1 || !COMMIT.test(map.baseRevision) || !map.overrides || typeof map.overrides !== 'object' || Array.isArray(map.overrides)
        || Object.keys(map).some(key => !['version', 'baseRevision', 'overrides'].includes(key))) throw Error('Invalid media delivery revision');
      for (const [group, target] of Object.entries(map.overrides)) {
        if (!COMMIT.test(target) || group.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(group)
          || group && group.split('/').some(part => !part || part === '.' || part === '..')
          || mediaGroup(repository, `${group ? `${group}/` : ''}file.webp`) !== group) throw Error('Invalid media delivery group');
      }
    }
  }
  return value;
}
export function mediaRevision(maps, repository, revision, encodedPath, rawPath = false) {
  const map = maps?.[repository]?.[revision];
  if (!map) return revision;
  // Decode only for directory matching; the caller's URL/template stays intact.
  const path = rawPath ? encodedPath : encodedPath.split(/[?#]/, 1)[0].split('/').map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  }).join('/');
  const group = mediaGroup(repository, path);
  return Object.hasOwn(map.overrides, group) ? map.overrides[group] : map.baseRevision;
}
