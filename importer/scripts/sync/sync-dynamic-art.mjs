#!/usr/bin/env node
/**
 * data/dynamic-art.json: which artwork has an animated version (the game's dynamic
 * illustrations), and where its Spine model is.
 *
 * The models are published by arkpedia/arkpedia-l2d-assets, one immutable folder per source
 * bundle, listed in its manifest.json. This reads that manifest at the repository's current
 * main commit -- the commit from the GitHub API, then the file from the raw host at that
 * commit, GET only -- and writes every model's model.json as a URL pinned to the same commit:
 *
 *   { "schemaVersion": 1, "repository": "arkpedia/arkpedia-l2d-assets", "commit": "<sha>",
 *     "models": { "<skinId>": "https://raw.githubusercontent.com/arkpedia/arkpedia-l2d-assets/<sha>/models/.../model.json" } }
 *
 * Fully pinned, so a new model reaches the site with the next content release: no asset
 * folder list, no deploy (lib/skins/dynamicArt.ts reads the file in getStaticProps).
 *
 * A repository with no commit yet, or no manifest at its commit, has no models: the file says
 * so (commit null) and the run succeeds. An entry that is not a skin id and a model folder is
 * skipped with a warning. Anything else that goes wrong -- the API or the raw host down, a
 * manifest that is not one -- fails the run, and the stage keeps yesterday's file
 * (scripts/content/run-stage.mjs).
 *
 *   node scripts/sync/sync-dynamic-art.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAsset } from '../../lib/assets/githubRetry.mjs';

export const REPOSITORY = 'arkpedia/arkpedia-l2d-assets';
export const BRANCH = 'main';
export const OUT = 'data/dynamic-art.json';
const SHA = /^[a-f0-9]{40}$/;
/** char_1044_hsgma2#2, char_113_cqbw@epoque#7: the game's skin ids. */
const SKIN_ID = /^char_[a-z0-9_]+(?:@[a-z0-9_]+)?#\d+(?:\^sp_dyn)?$/i;
/** models/<slug>/<first 12 hex of the bundle's md5>/model.json */
const MODEL_PATH = /^models\/[A-Za-z0-9_]+\/[a-f0-9]{12}\/model\.json$/;

/** The file for a repository with nothing published yet. */
export function emptyDynamicArt() {
  return { schemaVersion: 1, repository: REPOSITORY, commit: null, models: {} };
}

/**
 * data/dynamic-art.json from a manifest read at `commit`. A manifest that is not one throws;
 * an entry that is not a skin id and a model path is left out and reported in `skipped`.
 */
export function dynamicArtFromManifest(manifest, commit) {
  if (!SHA.test(commit ?? '')) throw new Error(`Not a commit: ${JSON.stringify(commit)}`);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The manifest is not an object');
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported manifest schemaVersion: ${JSON.stringify(manifest.schemaVersion)}`);
  if (!manifest.models || typeof manifest.models !== 'object' || Array.isArray(manifest.models)) throw new Error('The manifest has no models');
  const models = {};
  const skipped = [];
  for (const skinId of Object.keys(manifest.models).sort()) {
    const file = manifest.models[skinId];
    if (!SKIN_ID.test(skinId)) { skipped.push(`${skinId}: not a skin id`); continue; }
    if (typeof file !== 'string' || !MODEL_PATH.test(file)) { skipped.push(`${skinId}: not a model path (${JSON.stringify(file)})`); continue; }
    models[skinId] = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`;
  }
  return { data: { schemaVersion: 1, repository: REPOSITORY, commit, models }, skipped };
}

/** A raw 404 counts only once every encoding of the address has said it (lib/assets/githubRetry.mjs):
 *  a false one used to read as "no manifest" and publish no animated art at all. */
async function get(fetcher, url, headers = {}) {
  return fetchAsset(url, { headers: { 'User-Agent': 'ArkpediaBot/1.0 (+https://www.arkpedia.net)', ...headers }, signal: AbortSignal.timeout(60_000) }, { fetcher });
}

/**
 * Reads the manifest at the branch's commit and returns the data file. `fetch` is injected so
 * the tests run offline; `token` (GH_TOKEN) only lifts the API's anonymous rate limit.
 */
export async function readDynamicArt({ fetch: fetcher = globalThis.fetch, token } = {}) {
  const api = `https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`;
  const head = await get(fetcher, api, { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  // 409 is GitHub's answer for a repository with no commit at all.
  if (head.status === 409) return { data: emptyDynamicArt(), skipped: [], note: `${REPOSITORY} has no commits yet` };
  if (!head.ok) throw new Error(`${api}: HTTP ${head.status}`);
  const commit = (await head.json())?.sha;
  if (!SHA.test(commit ?? '')) throw new Error(`${api}: the response names no commit`);
  const raw = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/manifest.json`;
  const response = await get(fetcher, raw);
  if (response.status === 404) return { data: emptyDynamicArt(), skipped: [], note: `${REPOSITORY} has no manifest.json at ${commit.slice(0, 12)}` };
  if (!response.ok) throw new Error(`${raw}: HTTP ${response.status}`);
  let manifest;
  try { manifest = JSON.parse(await response.text()); } catch (error) { throw new Error(`${raw}: not JSON (${error.message})`); }
  return dynamicArtFromManifest(manifest, commit);
}

/** Writes the file when it changed; returns whether it did. */
export function writeDynamicArt(root, data) {
  const file = path.join(root, OUT);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

async function main() {
  const { data, skipped, note } = await readDynamicArt({ token: process.env.GH_TOKEN });
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const line of skipped) console.log(actions ? `::warning title=Dynamic art entry skipped::${line}` : `warning: skipped ${line}`);
  const changed = writeDynamicArt(process.cwd(), data);
  const count = Object.keys(data.models).length;
  console.log(`${changed ? 'Wrote' : 'Unchanged'} ${OUT}: ${count} animated artwork${count === 1 ? '' : 's'}${data.commit ? ` at ${data.commit.slice(0, 12)}` : ''}${note ? ` (${note})` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`sync-dynamic-art: ${error instanceof Error ? error.message : error}; yesterday's ${OUT} stays.`);
    process.exitCode = 1;
  });
}
