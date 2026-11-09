import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { directory } from './contract.mjs';
import { mediaGroup, mediaRevision, validateMediaDelivery } from './mediaDelivery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const directories = paths => [...new Set(paths.map(directory))].sort();
function groups(repository, dirs, shards) {
  const result = new Map();
  for (const dir of dirs) {
    const group = mediaGroup(repository, `${dir ? `${dir}/` : ''}file.webp`);
    assert.ok(shards[hash(dir)], 'Missing native directory identity');
    if (!result.has(group)) result.set(group, []);
    result.get(group).push([dir, shards[hash(dir)]]);
  }
  return new Map([...result].map(([group, entries]) => [group, hash(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))]));
}

/** Readiness hashes prove complete same-path groups, not merely equal file sizes.
 * Only completed physical copies are candidates; aliases are flattened, never chained. */
export function planMediaReuse(repository, revision, files, shards, receipts, existing) {
  const physical = new Map();
  const prefix = `arkpedia/${repository}/`;
  for (const key of existing.keys()) if (key.startsWith(prefix)) {
    const rest = key.slice(prefix.length), slash = rest.indexOf('/');
    const rev = rest.slice(0, slash), path = rest.slice(slash + 1);
    if (!physical.has(rev)) physical.set(rev, []);
    physical.get(rev).push(path);
  }
  const catalog = new Map();
  for (const saved of [...receipts.values()].filter(value => value.repository === repository && existing.has(`__ready/${repository}/${value.revision}`)).sort((a, b) => a.revision.localeCompare(b.revision))) {
    const maps = saved.native ? validateMediaDelivery({ [repository]: { [saved.revision]: saved.native } }) : {};
    const paths = [];
    for (const [rev, candidates] of physical) for (const path of candidates) {
      if (mediaRevision(maps, repository, saved.revision, path, true) === rev && saved.shards[hash(directory(path))]) paths.push(path);
    }
    const dirs = directories(paths);
    // A damaged completed view must never become a reuse authority.
    assert.equal(dirs.length, Object.keys(saved.shards).length, 'Incomplete native reuse directories');
    assert.equal(new Set(paths).size, saved.files, 'Incomplete native reuse files');
    const sample = new Map(paths.map(path => [mediaGroup(repository, path), path]));
    for (const [group, signature] of groups(repository, dirs, saved.shards)) {
      const path = sample.get(group);
      catalog.set(`${group}:${signature}`, mediaRevision(maps, repository, saved.revision, path, true));
    }
  }
  const targets = new Map();
  for (const [group, signature] of groups(repository, directories(files.map(file => file.path)), shards)) targets.set(group, catalog.get(`${group}:${signature}`) ?? revision);
  const counts = new Map();
  for (const target of targets.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
  const baseRevision = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const overrides = Object.fromEntries([...targets].filter(([, target]) => target !== baseRevision).sort(([a], [b]) => a.localeCompare(b)));
  // A directory deleted by the new source must not reappear from the baseline.
  for (const path of physical.get(baseRevision) ?? []) {
    const group = mediaGroup(repository, path);
    if (!targets.has(group)) overrides[group] = revision;
  }
  const native = { version: 1, baseRevision, overrides: Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  validateMediaDelivery({ [repository]: { [revision]: native } });
  return native;
}
