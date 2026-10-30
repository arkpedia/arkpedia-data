import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { nextIndex, readRetired } from '../lib/published-asset-index.mjs';
import { fetchAsset } from '../../lib/assets/githubRetry.mjs';
import { branchHead } from '../lib/branch-head.mjs';

// Resolve and validate the whole set before adopting it. Restore all three files
// on failure, so a failed validation does not leave a mixed manifest and lock.
const root = new URL('../../', import.meta.url);
const paths = ['data/assets/revisions.json', 'data/assets/external-asset-index.json', 'data/assets/public-asset-index.json'];
const previous = await Promise.all(paths.map(path => fs.readFile(new URL(path, root), 'utf8')));
const oldRevisions = JSON.parse(previous[0]);
const index = JSON.parse(previous[1]);
const next = {};
// Each head from git itself, then GitHub's API, asked again while none answers
// (scripts/lib/branch-head.mjs): the commits API alone answered 409 for the image repository
// all through the content run of 2026-10-15, and the day's pins stayed behind.
// All at once, so a GitHub that hangs costs one repository's wait, not eight in a row.
const repos = Object.keys(oldRevisions);
const heads = await Promise.all(repos.map(repo => branchHead(`arkpedia/${repo}`, 'main')));
repos.forEach((repo, i) => { next[repo] = heads[i]; });
const published = {};
const retired = new Map();
for (const repo of ['arkpedia-image-assets', 'arkpedia-skin-assets']) {
  // A 404 counts only once every encoding of the address has said it (lib/assets/githubRetry.mjs):
  // a false one on retired-assets.json read as "nothing retired".
  const response = await fetchAsset(`https://raw.githubusercontent.com/arkpedia/${repo}/${next[repo]}/asset-manifest.json`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Cannot load ${repo} manifest: ${response.status}`);
  const manifest = await response.json();
  // Removals the repository made on purpose (scripts/lib/published-asset-index.mjs); none when it has no list.
  const list = await fetchAsset(`https://raw.githubusercontent.com/arkpedia/${repo}/${next[repo]}/retired-assets.json`, { signal: AbortSignal.timeout(30000) });
  if (!list.ok && list.status !== 404) throw new Error(`Cannot load ${repo} retired-assets.json: ${list.status}`);
  for (const [path, reason] of readRetired(list.ok ? await list.json() : null, repo)) retired.set(path, reason);
  for (const [path, row] of Object.entries(manifest.files)) {
    if (path.startsWith('originals/') || path.startsWith('variants/')) continue;
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || row.bytes <= 0) throw new Error(`Invalid asset record: ${path}`);
    published[path] = row;
  }
}
const { next: adopted, retiredNow } = nextIndex(index, published, retired);
for (const path of retiredNow) console.log(`Retired by its repository: ${path} (${retired.get(path)})`);
try {
  await fs.writeFile(new URL(paths[0], root), JSON.stringify(next, null, 2) + '\n');
  await fs.writeFile(new URL(paths[1], root), JSON.stringify(adopted) + '\n');
  execFileSync(process.execPath, ['scripts/build/build-public-asset-index.cjs'], { stdio: 'inherit' });
  // The asset files at the new pins. Not the voice lines: the voices stage, which runs after
  // this one, rebuilds them against these pins; the Validate step's check:published-assets
  // checks the result. --adopting, always: a folder a repository publishes that this code does
  // not map yet only warns here (scripts/lib/asset-folders.mjs, folderVerdict), since adopting a
  // pin needs no mapping. The strict check threw the day's pins away over one, in each of the
  // three stages that move them. Check's check:published-assets still fails on it, and the
  // Validate step holds it in data/quarantine.json.
  execFileSync(process.execPath, ['scripts/audits/check-published-assets.mjs', '--adopting'], { stdio: 'inherit' });
} catch (error) {
  await Promise.all(paths.map((path, i) => fs.writeFile(new URL(path, root), previous[i])));
  throw error;
}
console.log('Asset revisions and availability indexes updated and checked. Review the diff before merging; revert these files together to roll back.');
