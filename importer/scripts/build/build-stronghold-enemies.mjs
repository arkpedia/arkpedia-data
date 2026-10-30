#!/usr/bin/env node
/**
 * Writes data/stronghold_enemies.json: every enemy the running Stronghold Protocol
 * event fields, with its stats and where it turns up.
 *
 *   node scripts/build/build-stronghold-enemies.mjs [contentId]
 *
 * WHY THIS IS NOT data/enemies/<Name>.json. Those files, written by
 * scripts/build/build-enemy-records.mjs, hold the enemies a content INTRODUCES -- five for
 * the original Stronghold Protocol, twenty-three for Alliance #1. Alliance #2
 * introduces none: all nine of its enemies came from the mainline, from Phantom &
 * Crimson Solitaire, or from Alliance #1. So by that convention it correctly has no
 * file, and "which enemies am I about to fight" has no answer anywhere. That is the
 * question this answers.
 *
 * WHERE IT ALL COMES FROM, all of it already committed -- this reaches no network and
 * needs no upstream cache:
 *
 *   data/stages-content.json     which contents exist, and their names
 *   data/content-windows.json    when each runs, so "the running one" is a fact
 *   data/stages/*.json           the stages of that content, and the enemies in each,
 *                                counted, and kept apart from the conditional ones
 *   public/enemies-index.json    the stat line: hp, atk, def, res, weight, movement
 *   data/enemies/*.json          the rich entry -- flavour text, abilities, per-level
 *                                stats -- which lives under whichever content
 *                                introduced the enemy, not this one
 *
 * WHY IT GROUPS BY THE GAME'S NAME AND NOT BY ACTIVITY ID. The first version of this
 * took the one activity that was running -- act2autochess -- and reported its four
 * stages as the event. That was wrong, and the shape of the data says why:
 * act1autochess ships h07_01, h07_02, h07_03, h07_04, h07_06 and h07_07, with no
 * h07_05, and act2autochess is exactly h07_05 plus its _s variant plus two m stages.
 * The game called both activities "Stronghold Protocol: Alliance"; our own pipeline
 * appended the #1 and #2 to tell them apart (see contents.mjs, which does that whenever
 * two contents share a name). So the second id is an ADDITION to the same event, not a
 * sequel with its own roster, and reading it alone reported one hard stage as if it were
 * everything -- which is how a borrowed boss ended up looking like the event's boss.
 *
 * So: find the activity that is running, take the game's name for it by stripping the
 * suffix we added, and cover every activity that shares that name.
 *
 * The content is chosen by the clock, so pass an id to pin it: a run in November should
 * be able to rebuild August's file.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const contents = read('data/stages-content.json');
const windows = read('data/content-windows.json');

/** The Stronghold Protocol events, newest first. The mode's own id is *autochess. */
const strongholds = Object.entries(contents)
  .filter(([id]) => /autochess/i.test(id))
  .map(([id, content]) => ({ id, content, window: windows[id] || null }))
  .sort((a, b) => String(b.content.release_date).localeCompare(String(a.content.release_date)));

if (!strongholds.length) throw new Error('no Stronghold Protocol content in data/stages-content.json');

/** The game's own name: ours adds " #2" or " 2026" when two contents collide. */
const gameName = (name) => String(name).replace(/ (#\d+|\d{4})$/, '');

const asked = process.argv[2];
const now = Math.floor(Date.now() / 1000);
const running = strongholds.find((s) => s.window && s.window[0] <= now && now <= s.window[1]);
const seed = asked ? strongholds.find((s) => s.id === asked) : (running ?? strongholds[0]);
if (!seed) throw new Error(`no Stronghold content with id ${asked}`);

// Every activity the game gave the same name. Newest first, so the label and the
// release date come from the latest run.
const family = strongholds.filter((s) => gameName(s.content.name) === gameName(seed.content.name));
const ids = new Set(family.map((s) => s.id));

// --- the stages, and who is in them ----------------------------------------
const stages = [];
/** name -> { certain, conditional, appears_in[] } */
const tally = new Map();

const note = (name, stageSlug, count, conditional) => {
  if (!tally.has(name)) tally.set(name, { certain: 0, conditional: 0, appears_in: [] });
  const row = tally.get(name);
  row[conditional ? 'conditional' : 'certain'] += count;
  row.appears_in.push({ stage: stageSlug, count, conditional });
};

for (const file of fs.readdirSync(path.join(ROOT, 'data/stages')).sort()) {
  const stage = read(`data/stages/${file}`);
  if (!ids.has(stage.content?.id)) continue;
  stages.push({
    activity: stage.content.id,
    slug: stage.slug,
    code: stage.code ?? null,
    name: stage.name ?? null,
    enemies_total: stage.enemies?.total ?? 0,
    conditional_total: stage.enemies?.conditional?.total ?? 0,
  });
  for (const list of Object.values(stage.enemies?.by_rank || {})) {
    for (const e of list) note(e.name, stage.slug, e.count ?? 1, false);
  }
  for (const list of Object.values(stage.enemies?.conditional?.by_rank || {})) {
    for (const e of list) note(e.name, stage.slug, e.count ?? 1, true);
  }
}

// --- the detail, from wherever the enemy was introduced ---------------------
const statByName = new Map(read('public/enemies-index.json').map((e) => [e.name, e]));
const richByName = new Map();
for (const file of fs.readdirSync(path.join(ROOT, 'data/enemies'))) {
  if (!file.endsWith('.json')) continue;
  const bundle = read(`data/enemies/${file}`);
  for (const enemy of bundle.enemies || []) {
    if (!richByName.has(enemy.name)) richByName.set(enemy.name, { enemy, from: bundle.content });
  }
}

const RANKS = { Boss: 0, Elite: 1, Normal: 2 };
const enemies = [...tally.entries()]
  .map(([name, counts]) => {
    const stat = statByName.get(name) || null;
    const rich = richByName.get(name) || null;
    return {
      name,
      slug: stat?.slug ?? rich?.enemy.slug ?? null,
      id: rich?.enemy.id ?? null,
      index: stat?.index ?? rich?.enemy.index ?? null,
      rank: stat?.rank ?? rich?.enemy.rank ?? null,
      icon: stat?.icon ?? rich?.enemy.icon ?? null,
      race: stat?.race ?? null,
      movement: stat?.movement ?? null,
      attack_position: stat?.attack_position ?? null,
      damage_type: stat?.damage_type ?? null,
      stats: stat ? { hp: stat.hp, atk: stat.atk, def: stat.def, res: stat.res, weight: stat.weight } : null,
      flavour_text: rich?.enemy.flavour_text ?? null,
      abilities: rich?.enemy.abilities ?? null,
      levels: rich?.enemy.levels ?? null,
      // Which content this enemy is FROM, which for every one of Alliance #2's is
      // somewhere else -- that is the whole reason this file exists.
      introduced_by: stat?.introduced_by ?? null,
      detail_from: rich ? rich.from.name : null,
      total: counts.certain,
      conditional_total: counts.conditional,
      appears_in: counts.appears_in,
    };
  })
  .sort((a, b) => (RANKS[a.rank] ?? 3) - (RANKS[b.rank] ?? 3) || b.total - a.total || a.name.localeCompare(b.name));

const out = {
  schema_version: 2,
  /** The game's name, without the #N our pipeline adds to separate the activity ids. */
  event: gameName(seed.content.name),
  /* Every activity id the game filed under that name, and when each ran. act2autochess
     adds one hard stage to what act1autochess shipped; both are the same event. */
  activities: family
    .slice()
    .sort((a, b) => String(a.content.release_date).localeCompare(String(b.content.release_date)))
    .map((s) => ({
      id: s.id,
      our_label: s.content.name,
      release_date: s.content.release_date,
      runs: s.window ? { start: s.window[0], end: s.window[1] } : null,
      running_when_built: s === running,
      stages: stages.filter((st) => st.activity === s.id).length,
    })),
  stages,
  enemies,
};

fs.writeFileSync(path.join(ROOT, 'data/stronghold_enemies.json'), `${JSON.stringify(out, null, 1)}\n`);

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
console.log(`${out.event} -- ${family.length} activity id${family.length === 1 ? '' : 's'} under one name`);
for (const a of out.activities) {
  console.log(`    ${a.id.padEnd(16)} ${a.our_label.padEnd(34)}`
    + (a.runs ? `${iso(a.runs.start)} to ${iso(a.runs.end)}` : 'no window').padEnd(26)
    + `${String(a.stages).padStart(2)} stages`
    + (a.running_when_built ? '   <- running now' : ''));
}
console.log(`  ${stages.length} stages, ${enemies.length} distinct enemies -> data/stronghold_enemies.json`);
for (const e of enemies) {
  console.log(`    ${(e.rank || '?').padEnd(7)} ${e.name.padEnd(26)} x${String(e.total).padStart(2)}`
    + (e.conditional_total ? ` +${e.conditional_total} conditional` : '')
    + (e.stats ? `  hp ${e.stats.hp}` : '  (no stat line)')
    + (e.abilities ? '' : '  (no rich entry)'));
}
