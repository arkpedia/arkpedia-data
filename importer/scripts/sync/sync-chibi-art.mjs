import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAsset } from '../../lib/assets/githubRetry.mjs';
import { assertSdChibiIndex, chibiIndex } from '../build/build-chibi-index.mjs';

export const REPOSITORY = 'arkpedia/arkpedia-sd-assets';
export const OUT = 'data/chibi-art.json';

/** Preserve every published skin/facing on a failed or incomplete import. */
export function assertChibiCoverage(previous, next) {
  for (const [skin, facings] of Object.entries(previous)) {
    for (const facing of Object.keys(facings)) if (!next[skin]?.[facing]) throw Error(`SD catalogue would remove ${skin}/${facing}`);
  }
}

export async function readChibiArt({ fetch: fetcher = globalThis.fetch, token } = {}) {
  const head = await fetcher(`https://api.github.com/repos/${REPOSITORY}/commits/main`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!head.ok) throw Error(`SD commit: HTTP ${head.status}`);
  const revision = (await head.json()).sha;
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('SD repository returned no pinned commit');
  // A 404 only once every encoding of the address has said it (lib/assets/githubRetry.mjs).
  const response = await fetchAsset(`https://raw.githubusercontent.com/${REPOSITORY}/${revision}/manifest.json`, { signal: AbortSignal.timeout(60_000) }, { fetcher });
  if (!response.ok) throw Error(`SD manifest: HTTP ${response.status}`);
  return chibiIndex(await response.json(), revision);
}

export function writeChibiArt(root, next) {
  assertSdChibiIndex(next);
  const file = path.join(root, OUT);
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertChibiCoverage(previous, next);
  const text = JSON.stringify(next) + '\n';
  if (fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const next = await readChibiArt({ token: process.env.GH_TOKEN });
    console.log(`${writeChibiArt(process.cwd(), next) ? 'Updated' : 'Unchanged'} ${OUT}: ${Object.keys(next).length} skin lookups from SD assets`);
  } catch (error) {
    console.error(`sync-chibi-art: ${error.message}; previous chibi catalogue retained.`);
    process.exitCode = 1;
  }
}
