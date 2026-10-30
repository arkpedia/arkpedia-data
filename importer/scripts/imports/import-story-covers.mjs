#!/usr/bin/env node
/** Mirror reader covers through the shared staged-art publisher; never hotlink them.
 * Missing images are staged under .cache/story-covers/ with source-byte provenance. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStaging } from '../lib/staged-art.mjs';
import { beginStage } from '../lib/quarantine.mjs';

export const COVER_SOURCE = 'https://arknights.timo.beer/json/covers.json';

export function coverPlan(manifest) {
  return Object.entries(manifest.groups ?? {}).flatMap(([id, value]) => {
    const version = value?.v?.cover;
    if (!/^[\w-]+$/.test(id) || !/^[\w-]+\.(?:jpg|png|webp)$/.test(value?.cover ?? '') || !/^[a-f0-9]{6,64}$/.test(version ?? '')) return [];
    return [{ id, target: `story-map/timo-${id}-${version}.webp`, source: `https://arknights.timo.beer/covers/${value.cover}?v=${version}` }];
  });
}

export async function importStoryCovers(manifest, { root = process.cwd(), fetcher = fetch, minimum = 80 } = {}) {
  const rows = coverPlan(manifest);
  if (rows.length < minimum) throw new Error('Incomplete story cover manifest; previous art stays.');
  const published = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/assets/external-asset-index.json'), 'utf8')).files);
  const output = path.join(root, 'data/story-library-art.json');
  const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')).images ?? {} : {};
  const staging = beginStaging('story-covers', root);
  const images = {}, alerts = [];
  // Bounded requests: a new catalogue can add many covers at once.
  for (let offset = 0; offset < rows.length; offset += 4) await Promise.all(rows.slice(offset, offset + 4).map(async row => {
    if (published.has(row.target)) { images[row.id] = `/${row.target}`; return; }
    const old = previous[row.id];
    if (typeof old === 'string' && old.startsWith('/story-map/') && published.has(old.slice(1))) images[row.id] = old;
    try {
      const response = await fetcher(row.source, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      staging.stage(row.target, Buffer.from(await response.arrayBuffer()), { source: row.source });
    } catch (error) { console.warn(`Story cover ${row.id} unavailable: ${error.message}`); }
    alerts.push({ key: `story-cover:${row.id}`, action: 'published-partial', sourceRef: row.source,
      reason: `The story cover is not published as ${row.target} yet; the chapter stays navigable without this cover.` });
  }));
  staging.commit();
  const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(output, `${JSON.stringify({ source: COVER_SOURCE, images: sorted }, null, 2)}\n`);
  const report = beginStage(root, 'story-covers');
  alerts.forEach(row => report.add(row));
  report.commit();
  return { published: Object.keys(images).length, staged: Object.keys(staging.files).length };
}

async function main() {
  try {
    const manifest = process.env.ARKPEDIA_STORY_COVERS ? JSON.parse(fs.readFileSync(process.env.ARKPEDIA_STORY_COVERS, 'utf8'))
      : await fetch(COVER_SOURCE, { signal: AbortSignal.timeout(30_000) }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    console.log(await importStoryCovers(manifest));
  } catch (error) {
    console.error(`Story covers unavailable; keeping previous art (${error.message}).`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
