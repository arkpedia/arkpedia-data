#!/usr/bin/env node
/**
 * Writes data/mode-rotations.json: when the permanent modes change what they offer.
 *
 * Annihilation and Stationary Security Service are always open, but not always the
 * same. Annihilation rotates one map at a time on a schedule the game ships outright,
 * and SSS runs numbered seasons of two towers each. The Terminal's Regular Tasks
 * screen leads with both -- "Kazdel / Scorching Workshop", "#10 Freeze Security
 * Service, 8 Week(s)" -- and neither fact is anywhere in data/ until this runs.
 *
 * Two tables, joined to our own slugs:
 *
 *   campaign_table.campaignRotateStageOpenTimes   31 windows, each naming a stage id
 *                                                 (camp_r_31) with a start and an end.
 *   climb_tower_table.seasonInfos                 10 seasons, each with a number, a
 *                                                 name, a window and its towers.
 *
 * The stage ids and tower ids are gamedata's; the site knows slugs and content ids, so
 * both are resolved here against data/stages/ rather than guessed at in a component.
 *
 * Run after the stage build:  node scripts/build/build-mode-rotations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EN = process.env.ARKPEDIA_EN || path.join(ROOT, '.cache/upstream/en-gamedata/en/gamedata');

function excel(name) {
  const file = path.join(EN, 'excel', `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file}\n  run scripts/sync/refresh-stage-data.sh, which syncs the upstream cache first`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// gamedata stage id -> what the site calls it. One pass over the records, because the
// index carries slugs but not ids.
const byStageId = new Map();
const stagesDir = path.join(ROOT, 'data', 'stages');
for (const file of fs.readdirSync(stagesDir)) {
  if (!file.endsWith('.json')) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(stagesDir, file), 'utf8'));
  if (rec.id) byStageId.set(rec.id, { slug: rec.slug, contentId: rec.content?.id ?? null, name: rec.name });
}

const campaign = excel('campaign_table');
const rotations = (campaign.campaignRotateStageOpenTimes || [])
  .map((row) => {
    const ours = byStageId.get(row.stageId);
    return {
      stageId: row.stageId,
      slug: ours?.slug ?? null,
      contentId: ours?.contentId ?? null,
      // Unix seconds, as everything else in data/ uses.
      start: row.startTs,
      end: row.endTs,
    };
  })
  .filter((r) => r.slug)
  .sort((a, b) => a.start - b.start);

const towers = excel('climb_tower_table');
const seasons = Object.values(towers.seasonInfos || {})
  .map((s) => ({
    id: s.id,
    number: s.seasonNum,
    name: s.name,
    start: s.startTs,
    end: s.endTs,
    // A season runs two towers, one of them usually a re-run of an older one.
    contentIds: (s.towers || []).filter((t) => byStageId.size && t),
    replicated: s.replicatedTowers || [],
  }))
  .sort((a, b) => a.number - b.number);

const out = { annihilation: rotations, sss: seasons };
fs.writeFileSync(path.join(ROOT, 'data', 'mode-rotations.json'), JSON.stringify(out));

const now = Math.floor(Date.now() / 1000);
const live = rotations.find((r) => r.start <= now && r.end >= now);
const season = seasons.find((s) => s.start <= now && s.end >= now);
console.log(`${rotations.length} annihilation windows, ${seasons.length} SSS seasons`);
console.log(`  rotating now : ${live ? `${live.slug} (until ${new Date(live.end * 1000).toISOString().slice(0, 10)})` : 'nothing'}`);
console.log(`  season now   : ${season ? `#${season.number} ${season.name} (until ${new Date(season.end * 1000).toISOString().slice(0, 10)})` : 'none'}`);
