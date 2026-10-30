#!/usr/bin/env node
// Builds every stage file this site serves, from public gamedata alone.
//
//   data/stages/<slug>.json          one per stage, 4,130 of them
//   data/stages-content.json         the content each stage was introduced by
//   data/stage-geometry/<key>.json   the map, shared by the stages that use it
//   data/stage-conditional/<key>.json  spawns that may never fire
//   data/stage-tile-legend.json      tile names and descriptions, once
//   public/stages-index.json         summaries for the list page
//
// This replaces the private arkpedia-database bundles. Everything downstream of
// it -- variant links, borrowed names, story groups, run windows, devices,
// exclusions -- is rebuilt by the later steps in scripts/sync/refresh-stage-data.sh,
// one of which has to run last.
//
// Output is built beside the real directories and swapped in only at the end, so
// a failure leaves the site's data as it was rather than half-rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { excel, levelKey, levelsDir, levelFile, forGlobal } from './lib/gamedata.mjs';
import { levelIds } from './lib/levelfiles.mjs';
import { identityFields, stageSlugs, tableOrder, variantParents, hardModeLevels, bossRushTrials, threeStarBonus } from './lib/records.mjs';
import { readActs } from './lib/story.mjs';
import { collect, contentBlocks, contentForStage, levelOwner } from './lib/contents.mjs';
import { releaseDates } from './lib/dates.mjs';
import { Rewards, buildDrops } from './lib/drops.mjs';
import { Levels, enemyCatalogue, loadEnemyNames } from './lib/level.mjs';
import { buildGeometry, owningStage, enemyDatabaseLevels, unitNames } from './lib/geometry.mjs';
import { encodeGeometry } from './lib/encode.mjs';
import { stagePreviews, defaultImagesDir } from './lib/preview.mjs';
import { assetFileNames } from '../lib/public-assets.mjs';
import { missingLevels, syntheticSlugs, syntheticRecord, tableLevelMetadata, compareNatural } from './lib/synthetic.mjs';
import { isVariations } from './lib/isvariations.mjs';
import { raBeginnerCuts } from './lib/rabeginner.mjs';
import { assertStageCoverage } from './lib/coverage.mjs';

const ROOT = process.env.ARKPEDIA_ROOT || process.cwd();
const out = (...p) => path.join(ROOT, ...p);
const notes = [];
const compact = (value) => JSON.stringify(value);

// --- inputs ----------------------------------------------------------------
const stageTable = excel('stage_table');
const stages = stageTable.stages;
const zoneTable = excel('zone_table');
const activityTable = excel('activity_table');
const levels = levelIds();

const registry = collect(levels);
const blocks = contentBlocks(registry, releaseDates(registry.all()));
const owner = levelOwner(registry);
const known = new Set([...registry.all().map((e) => `${e.kind} ${e.id}`), 'guide guide_1']);

const rewards = new Rewards();
const catalogue = enemyCatalogue();
const levelReader = new Levels(catalogue);
const previews = stagePreviews(stages, defaultImagesDir(ROOT), assetFileNames('stages-images', ROOT));

// The tiers of a Trials for Navigator trial, which stage_table does not
// distinguish at all -- needed by the slugs as well as by the records.
const trials = bossRushTrials((activityTable.activity || {}).BOSS_RUSH);

const ctx = {
  stages,
  slugs: stageSlugs(stages, trials.tiers),
  order: tableOrder(stages),
  parents: variantParents(stages, stageTable.diffGroupTable || {}, excel('climb_tower_table').towers,
    trials.parents),
  hardModeLevels: hardModeLevels(excel('climb_tower_table').towers),
  trialTiers: trials.tiers,
  zones: zoneTable.zones,
  towers: excel('climb_tower_table').towers,
  weekly: zoneTable.weeklyAdditionInfo,
  bonus: threeStarBonus(excel('gamedata_const')),
  acts: readActs(excel('chapter_table'), zoneTable.mainlineAdditionInfo).acts,
  zoneToActivity: activityTable.zoneToActivity,
  activityInfo: activityTable.basicInfo,
};

// --- geometry --------------------------------------------------------------
// Grouped by level file and written once per layout: a Challenge Mode row points
// its levelId at its parent's map, so one file serves several stages.
const databaseFile = path.join(levelsDir, 'enemydata', 'enemy_database.json');
const geoCtx = {
  tileInfo: stageTable.tileInfo || {},
  enemyNames: loadEnemyNames(),
  enemySlugs: new Map([...catalogue].map(([id, e]) => [id, e.slug])),
  databaseLevels: fs.existsSync(databaseFile)
    ? enemyDatabaseLevels(JSON.parse(fs.readFileSync(databaseFile, 'utf8'))) : new Map(),
  unitNames: unitNames(),
};

const dirs = {
  stages: out('data/stages'),
  geometry: out('data/stage-geometry'),
  conditional: out('data/stage-conditional'),
};
const tmp = Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, `${v}.new`]));
for (const dir of Object.values(tmp)) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const sharedLegend = {};
const geometryOfLevel = new Map();     // level key -> geometry file stem
let geoWritten = 0; let condWritten = 0; let noLevelFile = 0; let noMap = 0; let fromCn = 0;

function writeGeometry(level, stem) {
  // EN first; the CN mirror's copy when Global no longer carries the file (lib/gamedata.mjs).
  const found = levelFile(level);
  if (!found) { noLevelFile++; return; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(found.file, 'utf8')); } catch { noLevelFile++; return; }
  // Outside the try: a level whose enums the build cannot read fails the build, naming the
  // file, rather than counting as missing (decodeNumericEnums).
  raw = forGlobal(raw, found.source, found.file);
  const built = buildGeometry(raw, geoCtx);
  if (!built) { noMap++; return; }
  for (const [key, value] of Object.entries(built.tile_legend)) {
    if (!(key in sharedLegend)) sharedLegend[key] = value;
  }
  // `source` only on a map read from the CN client, so the 2,800 EN maps keep their bytes;
  // the stage page says where such a map came from.
  const { geometry, conditional } = encodeGeometry(stem, built, found.source);
  if (found.source === 'cn') fromCn++;
  fs.writeFileSync(path.join(tmp.geometry, `${stem}.json`), compact(geometry));
  geometryOfLevel.set(levelKey(level), stem);
  geoWritten++;
  if (conditional) {
    fs.writeFileSync(path.join(tmp.conditional, `${stem}.json`), compact(conditional));
    condWritten++;
  }
}

const byLevel = new Map();
for (const stageId of Object.keys(stages).sort()) {
  const level = (stages[stageId].levelId || '').trim().toLowerCase();
  if (!level) continue;
  if (!byLevel.has(level)) byLevel.set(level, []);
  byLevel.get(level).push(stageId);
}
let blankCode = 0;
for (const level of [...byLevel.keys()].sort()) {
  const stageId = owningStage(byLevel.get(level), stages);
  // A layout whose owner has no code has nothing to name its file after.
  if (!(stages[stageId].code || '').trim()) { blankCode++; continue; }
  writeGeometry(level, ctx.slugs.get(stageId));
}

// --- table-backed records --------------------------------------------------
const records = [];
for (const [sid, s] of Object.entries(stages)) {
  const record = identityFields(sid, s, ctx);
  const fromLevel = levelReader.of(s.levelId, s.difficulty);
  record.battle = fromLevel?.battle ?? null;
  record.enemies = fromLevel?.enemies ?? null;
  record.drops = buildDrops(sid, s, rewards);
  record.preview = previews.get(sid) ?? null;
  record.geometry = geometryOfLevel.get(levelKey(s.levelId)) ?? null;
  const key = contentForStage(record, s, owner, known);
  if (!key) { notes.push(`stage ${sid} belongs to no content -- skipped`); continue; }
  record.content = blocks.get(key.id);
  record.geometryKey = record.geometry;
  records.push(record);
}

// --- synthetic records: the stages that exist only as a level file ---------
const claimed = new Set();
for (const s of Object.values(stages)) {
  const key = levelKey(s.levelId);
  if (key) claimed.add(key);
}
const missing = missingLevels(owner, claimed);
const entries = new Map(registry.all().map((e) => [`${e.kind} ${e.id}`, e]));
const ownerKey = new Map([...owner].map(([level, k]) => [level, `${k.kind} ${k.id}`]));
const levelMeta = tableLevelMetadata();
const resolved = syntheticSlugs(records, missing, entries, ownerKey, levelMeta);
const perContent = new Map();
for (const record of records) {
  const id = record.content.id;
  perContent.set(id, (perContent.get(id) || 0) + 1);
}
for (const level of missing) {
  const entry = entries.get(ownerKey.get(level));
  const codes = [...(entry.levels.get(level) || [])].sort(compareNatural);
  const meta = levelMeta.get(level) || {};
  const stem = resolved.get(`level:${level}`);
  // Its own geometry, named after its own slug: nothing else shares a mode level.
  writeGeometry(level, stem);
  const record = syntheticRecord(level, entry, codes[0] ?? meta.code ?? null, meta, stem,
    levelReader.of(level), perContent.get(entry.id) || 0, blocks.get(entry.id));
  record.geometry = geometryOfLevel.get(level) ?? null;
  record.geometryKey = record.geometry;
  perContent.set(entry.id, (perContent.get(entry.id) || 0) + 1);
  records.push(record);
}

// --- Integrated Strategies: the alternates of one node ---------------------
// After the synthetics, because an IS node and its alternates are all mode levels
// and none of them exists until the loop above has run. This is the only variant
// link the pipeline makes outside identityFields: the rest come from stage_table
// fields (hardStagedId, diffGroupTable, the towers' paired arrays), and an IS node
// has no stage_table row at all.
const byRecordId = new Map(records.map((r) => [r.id, r]));
let variations = 0;
for (const [id, { of, index }] of isVariations(records)) {
  const record = byRecordId.get(id);
  const base = byRecordId.get(of);
  if (!record || !base) continue;
  record.variant = {
    kind: 'variation',
    // Numbered rather than named: the game gives an alternate no name of its own,
    // and the label is what the toggle on the stage page reads.
    label: `Variation ${index}`,
    of_stage_code: base.code ?? null,
    of_stage_id: base.id,
    // Each variation is its OWN level file -- that is what makes it a variation --
    // so the map, the waves and the enemies all differ from the base's.
    shares_parent_level_file: false,
  };
  variations += 1;
}

// --- Reclamation Algorithm: the beginner cut of an operation ---------------
// Same shape as the pass above and for the same reason: an RA stage has no
// stage_table row, so identityFields never sees these. See lib/rabeginner.mjs for
// which four they are and how the game names them.
let beginnerCuts = 0;
for (const [id, { of }] of raBeginnerCuts(records)) {
  const record = byRecordId.get(id);
  const base = byRecordId.get(of);
  if (!record || !base) continue;
  record.variant = {
    kind: 'beginner_mode',
    label: 'Beginner Mode',
    of_stage_code: base.code ?? null,
    of_stage_id: base.id,
    // Its own level file, on the same map: the grid matches the base's exactly and
    // the fight does not.
    shares_parent_level_file: false,
  };
  beginnerCuts += 1;
}

// --- write -----------------------------------------------------------------
// Before swapping any output: a newly introduced type or content mapping may
// not silently drop source rows while the historical total still passes.
assertStageCoverage({ stages, records });
if (records.length < 3000 || !geoWritten) {
  console.error(`only ${records.length} records and ${geoWritten} maps -- refusing to write`);
  process.exit(1);
}

const contents = {};
for (const record of records) {
  fs.writeFileSync(path.join(tmp.stages, `${record.slug}.json`), compact(record));
  if (record.content?.id) contents[record.content.id] = record.content;
}

const index = records.map((s) => ({
  slug: s.slug,
  code: s.code,
  name: s.name,
  stageType: s.stage_type,
  chapter: s.chapter,
  variant: s.variant,
  zoneId: s.zone?.id ?? null,
  zoneName: s.zone?.name ?? null,
  zoneGroup: s.zone?.group ?? null,
  zoneType: s.zone?.type ?? null,
  contentId: s.content?.id ?? null,
  contentLabel: s.content?.label ?? null,
  contentName: s.content?.name ?? null,
  sanity: s.sanity_cost,
  recommended: s.difficulty?.recommended_level ?? null,
  tier: s.difficulty?.tier ?? null,
  enemyTotal: s.enemies?.total ?? null,
  hasBoss: Boolean(s.enemies?.by_rank?.Boss?.length),
  farmable: [...new Set(s.drops.filter((d) => d.kind === 'farmable' && d.item?.name).map((d) => d.item.name))].sort(),
  hasGeometry: s.geometryKey != null,
  preview: s.preview,
  order: s.order,
}));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
index.sort((a, b) => cmp(String(a.stageType), String(b.stageType))
  || cmp(String(a.contentLabel), String(b.contentLabel))
  || (a.order || 0) - (b.order || 0)
  || cmp(String(a.code), String(b.code)));

fs.writeFileSync(out('data/stages-content.json.new'), compact(contents));
fs.writeFileSync(out('public/stages-index.json.new'), compact(index));
fs.writeFileSync(out('data/stage-tile-legend.json.new'), `${JSON.stringify(sharedLegend, null, 1)}\n`);
for (const [key, dir] of Object.entries(dirs)) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp[key], dir);
}
for (const file of ['data/stages-content.json', 'public/stages-index.json', 'data/stage-tile-legend.json']) {
  fs.renameSync(out(`${file}.new`), out(file));
}

for (const note of notes.slice(0, 12)) console.log(`  note: ${note}`);
console.log(`stages written     : ${records.length} (${records.length - missing.length} from stage_table, ${missing.length} mode levels)`);
console.log(`IS variations      : ${variations} alternate levels folded into their node`);
console.log(`RA beginner cuts   : ${beginnerCuts} folded into their operation`);
console.log(`contents           : ${Object.keys(contents).length}`);
console.log(`geometries         : ${geoWritten}  conditional: ${condWritten}  legend keys: ${Object.keys(sharedLegend).length}`);
console.log(`from the CN client : ${fromCn} maps whose level file only the CN mirror still carries`);
console.log(`skipped            : ${noLevelFile} level file missing, ${noMap} no map, ${blankCode} owner has no code`);
