import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { folderDriftByKind, folderMode, folderVerdict } from '../lib/asset-folders.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { fetchAsset } from '../../lib/assets/githubRetry.mjs';

/*
 *   node scripts/audits/check-published-assets.mjs               Check: any folder drift fails
 *   node scripts/audits/check-published-assets.mjs --quarantine  the release job's Validate
 *     step: a folder a repository publishes that config/asset-folders.json does not map is held
 *     as a published-partial entry (stage published-assets) instead, since no page links to it;
 *     test-asset-folders.ts accepts it only with that entry.
 *   node scripts/audits/check-published-assets.mjs --adopting    update-asset-revisions.mjs,
 *     which every stage that moves the pins runs: an unmapped folder is let through with a
 *     warning and no entry. Which mode does what is folderVerdict's (scripts/lib/asset-folders.mjs).
 * A missing folder -- one the config maps that a pinned repository does not publish -- fails
 * every mode.
 */
const mode = folderMode(process.argv.slice(2));

const read = async file => JSON.parse(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
const revisions = await read('data/assets/revisions.json');
const index = await read('data/assets/external-asset-index.json');
// Source validation precedes publication: a newly imported pin is not in R2 yet.
// The publisher and deployment readiness gate verify the later delivery stage.
const url = (repo, path) => `https://raw.githubusercontent.com/arkpedia/${repo}/${revisions[repo]}/${path.split('/').map(encodeURIComponent).join('/')}`;
async function download(address) {
  // A 404 counts only once GitHub has said it at every encoding (lib/assets/githubRetry.mjs).
  const response = await fetchAsset(address, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${address}`);
  return Buffer.from(await response.arrayBuffer());
}
for (const [repo, sha] of Object.entries(revisions)) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Unpinned repository: ${repo}`);
}
const manifests = await Promise.all(['arkpedia-image-assets', 'arkpedia-skin-assets'].map(async repo => ({
  repo, manifest: JSON.parse(await download(url(repo, 'asset-manifest.json'))),
})));
// Every folder each pinned repository publishes is one the site maps to it, and the reverse.
const drift = folderDriftByKind(await read('config/asset-folders.json'), Object.fromEntries(manifests.map(({ repo, manifest }) => [repo, manifest])));
const { fail, hold, allow } = folderVerdict(drift, mode);
if (fail.length) throw new Error(`Asset folders and the pinned repositories disagree:\n  ${fail.map(row => row.problem).join('\n  ')}`);
if (mode === 'quarantine') {
  // Committed with nothing held too, so a folder the app has mapped since drops off.
  const stage = beginStage(process.cwd(), 'published-assets');
  for (const { repository, folder, problem } of hold) {
    stage.add({ key: `asset-folder:${repository}/${folder}`, action: 'published-partial',
      reason: `${problem}: no page links to it until the app maps it (most likely a mapping that is on dev and not yet on main)` });
  }
  stage.commit();
  if (hold.length) console.warn(`::warning::${hold.length} published folder(s) the app does not map, held in data/quarantine.json: ${hold.map(row => row.folder).join(', ')}`);
}
if (allow.length) {
  console.warn(`${allow.length} published folder(s) config/asset-folders.json does not map yet, adopted anyway since no page links to them: ${allow.map(row => `${row.repository}/${row.folder}`).join(', ')}. `
    + 'Check fails until they are mapped; the release job holds them in data/quarantine.json meanwhile.');
}
const files = new Map(manifests.flatMap(({ repo, manifest }) => Object.entries(manifest.files).map(([path, row]) => [path, { repo, ...row }])));
const missing = index.files.filter(path => !files.has(path));
if (missing.length) throw new Error(`Published revision is missing ${missing.length} files: ${missing.slice(0, 15).join(', ')}`);
// Download one deterministic sample from EVERY category, plus each responsive format.
// Public asset CI verifies the complete manifest; app CI verifies the delivery path.
const samples = new Map();
for (const path of [...index.files].sort()) {
  const category = path.split('/')[0];
  if (!samples.has(category)) samples.set(category, { path, ...files.get(path) });
}
const skin = manifests[1];
const artwork = Object.values(skin.manifest.files).find(row => row.original && row.variants);
if (!artwork) throw new Error('No responsive artwork in published manifest');
for (const row of [artwork.original, ...Object.values(artwork.variants).map(widths => Object.values(widths)[0])]) {
  samples.set(row.path, { ...row, repo: skin.repo });
}
// Small batches avoid rate spikes against the public host.
const rows = [...samples.values()];
for (let offset = 0; offset < rows.length; offset += 4) {
  await Promise.all(rows.slice(offset, offset + 4).map(async row => {
    const bytes = await download(url(row.repo, row.path));
    if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new Error(`Published file differs from manifest: ${row.repo}/${row.path}`);
    }
  }));
}
const palette = JSON.parse(await download(url('arkpedia-color-palette', 'palettes/community-overrides.json')));
if (!palette || typeof palette !== 'object') throw new Error('Invalid palette JSON');
for (const repo of Object.keys(revisions).filter(repo => repo.startsWith('arkpedia-voice-'))) {
  const source = JSON.parse(await download(url(repo, 'source.json')));
  if (!source.sourceCommit) throw new Error(`Missing voice provenance: ${repo}`);
}
console.log(`Verified the asset folder map, ${index.files.length} published image paths, ${rows.length} file hashes, palette JSON and all five voice revision records.`);
