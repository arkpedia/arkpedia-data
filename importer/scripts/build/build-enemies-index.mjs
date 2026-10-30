#!/usr/bin/env node
/**
 * Writes public/enemies-index.json: one summary row per enemy, for the browse grid.
 *
 * Under public/ rather than embedded in the pages, for the reason the stages rail
 * has its own index: the grid sits beside every enemy detail page, and 661KB of
 * summaries multiplied by 1,585 pages is not a filter. Each page embeds only the
 * slice it can show immediately and fetches this once for the rest.
 *
 *   node scripts/build/build-enemies-index.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ARKPEDIA_ROOT || process.cwd();
const BUNDLES = path.join(ROOT, 'data/enemies');
const OUT = path.join(ROOT, 'public/enemies-index.json');

/**
 * enemy slug -> every content id that fields it. The source index is stored
 * content-first because that is how it is derived from stage rosters; the grid's
 * "Appears in" filter wants it enemy-first, so it is flipped once here. This mirrors
 * getAppearancesBySlug() in lib/enemies/enemies.ts, which does the same flip for the
 * server-rendered seed rows -- both have to agree or the filter would change answers
 * the moment the fetched index replaced the seed.
 */
const appearsIn = {};
for (const content of JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data/enemy_appearances.json'), 'utf8')
)) {
  for (const slug of content.enemies || []) {
    (appearsIn[slug] ||= []).push(content.id);
  }
}

const rows = [];
for (const file of fs.readdirSync(BUNDLES).sort()) {
  if (!file.endsWith('.json')) continue;
  const bundle = JSON.parse(fs.readFileSync(path.join(BUNDLES, file), 'utf8'));
  for (const e of bundle.enemies || []) {
    // Level 0 is always present and is always the default combat row -- the same
    // basis lib/enemies/enemies.ts uses, so the grid and the sort agree.
    const base = e.levels?.[0]?.stats || {};
    rows.push({
      slug: e.slug,
      name: e.name,
      index: e.index ?? null,
      rank: e.rank,
      sort: e.sort,
      hidden: e.hidden,
      icon: e.icon ?? null,
      race: e.race ?? null,
      movement: e.movement ?? null,
      attack_position: e.attack_position ?? null,
      damage_type: e.damage_type || [],
      introduced_by: bundle.content.id,
      appears_in: appearsIn[e.slug] || [],
      hp: base.hp ?? null,
      atk: base.atk ?? null,
      def: base.def ?? null,
      res: base.res ?? null,
      weight: base.weight ?? null,
    });
  }
}
rows.sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
fs.writeFileSync(OUT, JSON.stringify(rows));
console.log(`${rows.length} enemies -> ${path.relative(ROOT, OUT)}`
  + ` (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
