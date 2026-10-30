/*
 * The asset index at the day's new pins (scripts/sync/update-asset-revisions.mjs): every path the
 * pinned asset repositories publish, and its sha256.
 *
 * A path the site published before and a repository no longer publishes is refused: a broken or
 * truncated manifest must never empty the site's art. A removal made on purpose is declared by the
 * repository itself, in retired-assets.json at its root, each path with the reason it went
 * (arkpedia-image-assets#32 and #33: CN banner art Global replaces, and a stand-in banner the
 * maintainer did not want). A retired path drops out of the index, so publishedArt
 * (lib/art/publishedArt.ts) answers null for it and the page shows no art; nothing else changes.
 */

const SAFE_PATH = /^(?![./])(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/;

/** retired-assets.json of one repository (null when it has none): path -> reason. */
export function readRetired(document, repo) {
  if (document === null) return new Map();
  if (!document || document.schemaVersion !== 1 || !document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw new Error(`${repo} retired-assets.json must be { schemaVersion: 1, paths: { "<path>": { reason } } }`);
  }
  const retired = new Map();
  for (const [path, entry] of Object.entries(document.paths)) {
    if (!SAFE_PATH.test(path)) throw new Error(`${repo} retired-assets.json: not a repository path: ${path}`);
    if (!entry || typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error(`${repo} retired-assets.json: ${path} gives no reason`);
    retired.set(path, entry.reason);
  }
  return retired;
}

/**
 * The next index from the current one, what the new pins publish (path -> { sha256 }) and what
 * their repositories retired (path -> reason). Throws on a published path gone without a
 * retirement, and on a path retired while still published (a contradiction worth a person).
 */
export function nextIndex(index, published, retired) {
  const contradictions = [...retired.keys()].filter(path => published[path]);
  if (contradictions.length) throw new Error(`Retired but still published: ${contradictions.slice(0, 20).join(', ')}`);
  const removed = index.files.filter(path => !published[path]);
  const unexplained = removed.filter(path => !retired.has(path));
  if (unexplained.length) throw new Error(`Refusing to remove published paths: ${unexplained.slice(0, 20).join(', ')}`);
  const hashes = {};
  for (const [path, hash] of Object.entries(index.hashes)) {
    if (!published[path]) continue; // retired
    hashes[path] = index.sha256[path] !== published[path].sha256 ? published[path].sha256.slice(0, 8) : hash;
  }
  const files = Object.keys(published).sort();
  return {
    next: { ...index, hashes, files, sha256: Object.fromEntries(files.map(path => [path, published[path].sha256])) },
    retiredNow: removed,
  };
}
