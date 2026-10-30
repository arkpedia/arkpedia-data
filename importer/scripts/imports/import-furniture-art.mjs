#!/usr/bin/env node
/** Import the official in-game furniture shop thumbnails from the client dump.
 * Nothing publishes here: .cache/furniture-art/staged.json is consumed by the
 * nightly staged-art publisher. Its second pass adopts the new asset index and
 * clears pending-art reports. CN and Global remain separate immutable files. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { furnitureThemeId } from '../../lib/events/furnitureArt.mjs';
import { assetFileNames } from '../lib/public-assets.mjs';
import { beginStaging } from '../lib/staged-art.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { pinnedRef } from '../content/pin-upstream.mjs';

const CLIENTS = {
  en: { repository: 'ArknightsAssets/ArknightsAssets2', directory: 'assets/dyn/arts/ui/furnithemes' },
  cn: { repository: 'ArknightsAssets/ArknightsAssets2', directory: 'assets/dyn/arts/ui/furnithemes' },
};

export function furnitureThemes(rewards) {
  const themes = new Map();
  for (const entry of Object.values(rewards.events ?? {})) {
    for (const group of entry.groups ?? []) {
      if (group.kind !== 'furniture-set') continue;
      const id = furnitureThemeId(group);
      if (id) themes.set(id, group.title);
    }
  }
  return themes;
}

async function request(url, json = false) {
  const headers = { 'User-Agent': 'Arkpedia-content/1.0' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return json ? await response.json() : Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

export async function clientFiles(region) {
  // Settle each region on one commit before listing or downloading anything.
  const { repository, directory } = CLIENTS[region];
  const ref = pinnedRef(repository, process.env, region);
  const commit = /^[0-9a-f]{40}$/.test(ref) ? ref : (await request(`https://api.github.com/repos/${repository}/commits/${ref}`, true)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`Invalid ${region} client art commit`);
  const rows = await request(`https://api.github.com/repos/${repository}/contents/${directory}?ref=${commit}`, true);
  if (!Array.isArray(rows)) throw new Error(`Invalid ${region} furniture art directory`);
  const names = new Map(rows.filter(row => row.type === 'file').map(row => [row.name.toLowerCase(), row.name]));
  return { commit, files: new Set(names.keys()), names };
}

export async function importFurnitureArt({ root = process.cwd(), readClient = clientFiles, download = request, log = console.log } = {}) {
  const rewards = JSON.parse(fs.readFileSync(path.join(root, 'data/event-rewards.json'), 'utf8'));
  const themes = furnitureThemes(rewards);
  const published = new Set(assetFileNames('content-art', root));
  const staging = beginStaging('furniture-art', root);
  const report = beginStage(root, 'furniture-art');
  for (const region of ['en', 'cn']) {
    const waiting = [...themes].filter(([id]) => !published.has(`${id}-${region}.webp`));
    if (!waiting.length) continue;
    let client;
    try { client = await readClient(region); }
    catch (error) {
      // A regional outage does not suppress the other region or unrelated rewards.
      log(`Furniture art ${region}: ${error.message}`);
      for (const [id, title] of waiting) report.add({ key: `furniture-art:${id}:${region}`, action: 'published-partial', reason: `The ${region} client artwork for ${title} could not be checked; the existing artwork is kept.` });
      continue;
    }
    for (const [id, title] of waiting) {
      const key = `${id}.png`.toLowerCase();
      // Some old themes have no thumbnail in a region. Retry on subsequent nights.
      if (!client.files.has(key)) continue;
      const file = client.names?.get(key) ?? key;
      const { repository, directory } = CLIENTS[region];
      const source = `https://raw.githubusercontent.com/${repository}/${client.commit}/${directory}/${file}`;
      try {
        const data = await download(source);
        staging.stage(`content-art/${id}-${region}.webp`, data, { source, mirror: { repository, commit: client.commit, path: `${directory}/${file}` } });
        report.add({ key: `furniture-art:${id}:${region}`, action: 'published-partial', sourceRef: source, reason: `The official ${region} shop artwork for ${title} is staged and awaits asset publication.` });
        log(`+ ${id}-${region}.webp`);
      } catch (error) {
        log(`Furniture art ${id} ${region}: ${error.message}`);
        report.add({ key: `furniture-art:${id}:${region}`, action: 'published-partial', sourceRef: source, reason: `The official ${region} shop artwork for ${title} could not be downloaded; the existing artwork is kept.` });
      }
    }
  }
  staging.commit();
  report.commit();
  return staging.files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await importFurnitureArt();
