#!/usr/bin/env node
/**
 * Writes data/enemies/<Content>.json and data/enemy_appearances.json: the enemy
 * records themselves, and which contents field each one.
 *
 * WHY THIS EXISTS. Both were imported once, on 2026-08-17, from arkpedia-database's
 * build_enemies.py, and nothing in this repo regenerated them after that. The
 * index, the stage links and the detail files downstream of them are all derived,
 * so every one of those builders re-derived the same frozen roster: People, A
 * People went live on Global with 19 new enemies and not one of them had a page.
 * This is that generator, from the same EN tables the stage build reads.
 *
 * WHAT IT KEEPS AND WHAT IT REBUILDS.
 *
 *   - Every record is rebuilt from enemy_handbook_table and enemy_database, so a
 *     stat the game changes reaches the page. The schema is the one the import
 *     wrote (schema_version 3, lib/enemies/enemyTypes.ts), field for field.
 *   - The PARTITION is kept. A bundle holds the enemies its content introduced --
 *     the first Global content to field them -- and that is history, not something
 *     today's tables can re-answer: several contents were minted by the old
 *     collectors from mode tables no stage names (Defense Protocols, Design of
 *     Strife). So an enemy already filed somewhere stays there, and only an enemy
 *     with no record yet is filed, under the earliest content whose listed stages
 *     field it. The one thing that moves is a content's ID, when the stage dataset
 *     re-files a whole event under its rerun's id (see the re-key in main()).
 *   - Appearances are ADDED to, never taken from. A content's row gains every
 *     enemy its listed stages field; nothing already in a row is removed, for the
 *     same reason -- 74 rows name enemies from mode mechanics the stage dataset
 *     cannot see, and dropping them would take the content off those enemies'
 *     pages (build-enemy-details.mjs explains the 205 that lost every content once).
 *   - An icon path already on a record is kept: 11 records have no upstream art
 *     and carry null on purpose. A new record gets the path the image sync
 *     publishes it under; see iconPath() and the naming note in main().
 *
 * WHAT IT WILL NOT DO is fail the release over one enemy. A filed record whose
 * handbook or database entry has vanished keeps its previous version, a new enemy with
 * no database entry is left out, and a re-key that fits more than one content is not
 * made; each goes on the quarantine list under 'enemies' instead.
 *
 * A bundle or row is written only when what it SAYS changed. JSON.stringify does
 * not round-trip the gamedata's floats (10.0 comes back as 10), so rewriting an
 * unchanged file would churn 167 files in the data repo for nothing -- the reason
 * scripts/stage-pipeline/settle-float-churn.mjs exists. Comparing parsed values
 * here needs no git, so it holds in the release job too.
 *
 * Only stages the index lists count, the same allowlist
 * build-enemy-stage-appearances.mjs uses: an excluded stage has no page, and the
 * rows this writes must agree with the stage links that file carries.
 *
 * Runs in the stage refresh chain, after the stage build and before
 * build-enemy-stage-appearances.mjs and build-enemies-index.mjs, which read it.
 *
 *   node scripts/build/build-enemy-records.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { excel, levelsDir } from '../stage-pipeline/lib/gamedata.mjs';
import { asList, enemySlugs, plain } from '../stage-pipeline/lib/level.mjs';
import { text } from '../stage-pipeline/lib/text.mjs';
import { beginStage } from '../lib/quarantine.mjs';

const ROOT = process.env.ARKPEDIA_ROOT || process.cwd();
const BUNDLES = path.join(ROOT, 'data/enemies');
const APPEARANCES = path.join(ROOT, 'data/enemy_appearances.json');
const STAGES = path.join(ROOT, 'data/stages');
const CONTENTS = path.join(ROOT, 'data/stages-content.json');
const INDEX = path.join(ROOT, 'public/stages-index.json');
const SCHEMA_VERSION = 3;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// --- the record -------------------------------------------------------------

const RANK = { NORMAL: 'Normal', ELITE: 'Elite', BOSS: 'Boss' };
const MOVEMENT = { WALK: 'Ground', FLY: 'Flying' };
const ATTACK_POSITION = { MELEE: 'Melee', RANGED: 'Ranged', ALL: 'Melee and Ranged' };
const DAMAGE_TYPE = { PHYSIC: 'Physical', MAGIC: 'Arts', NO_DAMAGE: 'No Damage', HEAL: 'Healing' };
const SP_RECOVERY = {
  INCREASE_WITH_TIME: 'Over time', INCREASE_WHEN_ATTACK: 'On attack', INCREASE_WHEN_TAKEN_DAMAGE: 'On taking damage',
};

/** enemy_database attribute -> record stat, in the record's own key order. */
const STATS = [
  ['hp', 'maxHp'], ['atk', 'atk'], ['def', 'def'], ['res', 'magicResistance'],
  ['elemental_res', 'epResistance'], ['elemental_damage_res', 'epDamageResistance'],
  ['attack_interval', 'baseAttackTime'], ['attack_speed', 'attackSpeed'],
  ['move_speed', 'moveSpeed'], ['range', 'rangeRadius'], ['weight', 'massLevel'],
  ['taunt', 'tauntLevel'], ['life_cost', 'lifePointReduce'],
];

/** The immunity flags, in the order the database declares them. */
const IMMUNITIES = [
  ['stunImmune', 'Stun'], ['silenceImmune', 'Silence'], ['sleepImmune', 'Sleep'],
  ['frozenImmune', 'Frozen'], ['levitateImmune', 'Levitate'],
  ['disarmedCombatImmune', 'Disarm'], ['fearedImmune', 'Fear'],
  ['palsyImmune', 'Paralysis'], ['attractImmune', 'Lure'],
];

/**
 * The file name the image sync publishes an enemy's icon under: the display name,
 * minus the characters a filename cannot hold. 'OpFor: Fissure' is
 * 'OpFor Fissure.webp'. The same rule every existing record's icon follows.
 */
function iconPath(name) {
  return `/enemies-icons/${String(name).replace(/[\\/*?:"<>|]/g, '').trim()}.webp`;
}

/** Bundles are named after their content, with the same characters removed. */
const bundleFile = (content) => `${String(content.name).replace(/[\\/*?:"<>|]/g, '').trim()}.json`;

/** {key: value} with the keys in code-point order, as Python's sorted() gives. */
function sortedObject(out) {
  return Object.fromEntries(Object.keys(out).sort(byCodePoint).map((key) => [key, out[key]]));
}

// Code-point order: 'PassiveM2' before 'Passive_Hit', where a locale collation would
// swap every mixed-case pair the import wrote.
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** valueStr wins where it is set: that is where string parameters live. */
const blackboardValue = (entry) => (entry.valueStr != null ? entry.valueStr : entry.value);

/**
 * A skill blackboard as {key: value}. A key listed twice keeps its LAST value, as
 * the client does.
 */
function parameters(entries) {
  const out = {};
  for (const entry of asList(entries)) {
    if (typeof entry?.key === 'string') out[entry.key] = blackboardValue(entry);
  }
  return sortedObject(out);
}

/**
 * talentBlackboard is one flat list of '<talent>.<parameter>' keys. Each talent
 * becomes its own entry; the talent name is everything before the FIRST dot, so
 * 'Reborning.dhnzzh_reborn_c2.enemy_key' is Reborning's 'dhnzzh_reborn_c2.enemy_key',
 * and a key with nothing after the dot, or no dot at all, is that talent's 'value'.
 *
 * 'attack@range_atk_scale': the part before the @ says when the client reads the
 * value, not what it is, so the name is what follows it -- unless the talent ALSO
 * declares that plain name (Funnel_s2 carries ep_damage_ratio and
 * attack@ep_damage_ratio), where folding the two would lose one.
 */
function talents(blackboard) {
  const groups = new Map();
  for (const entry of asList(blackboard)) {
    if (typeof entry?.key !== 'string') continue;
    const dot = entry.key.indexOf('.');
    const talent = dot === -1 ? entry.key : entry.key.slice(0, dot);
    const name = (dot === -1 ? '' : entry.key.slice(dot + 1)) || 'value';
    if (!groups.has(talent)) groups.set(talent, []);
    groups.get(talent).push([name, blackboardValue(entry)]);
  }
  return [...groups.keys()].sort(byCodePoint).map((talent) => {
    const pairs = groups.get(talent);
    const plainNames = new Set(pairs.map(([name]) => name).filter((name) => !name.includes('@')));
    const out = {};
    for (const [name, value] of pairs) {
      const bare = name.slice(name.lastIndexOf('@') + 1);
      out[plainNames.has(bare) && bare !== name ? name : bare] = value;
    }
    return { key: talent, parameters: sortedObject(out) };
  });
}

function skills(list) {
  return asList(list).map((skill) => ({
    key: skill.prefabKey,
    sp_cost: skill.spCost ?? null,
    cooldown: skill.cooldown ?? null,
    initial_cooldown: skill.initCooldown ?? null,
    priority: skill.priority ?? null,
    parameters: parameters(skill.blackboard),
  }));
}

function sp(data) {
  if (data == null || typeof data !== 'object') return null;
  return {
    initial: data.initSp ?? null,
    max: data.maxSp ?? null,
    recovery: SP_RECOVERY[data.spType] ?? null,
    increment: data.increment ?? null,
  };
}

/**
 * The handbook's letter grade for a value: the band whose [min, max) holds it, a
 * max of -1 meaning unbounded. An absent stat has no grade.
 */
function grade(bands, field, value) {
  if (value == null) return null;
  for (const band of bands) {
    const { min, max } = band[field] || {};
    if (min == null) continue;
    if (value >= min && (max === -1 || value < max)) return band.classLevel;
  }
  return null;
}

/**
 * Two grades do not follow the stat line. Elemental RES and Elemental Damage RES
 * grade an absent value as 0 -- the handbook shows E for an enemy with none, not a
 * blank. And the attack-speed grade is banded on the attack INTERVAL, which is what
 * the handbook's attackSpeed bands measure (SS is under 0.5s between attacks); an
 * interval of 0 is no attack at all and has no grade.
 */
function statRanks(bands, stats) {
  return {
    hp: grade(bands, 'maxHP', stats.hp),
    atk: grade(bands, 'attack', stats.atk),
    def: grade(bands, 'def', stats.def),
    res: grade(bands, 'magicRes', stats.res),
    elemental_res: grade(bands, 'enemyRes', stats.elemental_res ?? 0),
    elemental_damage_res: grade(bands, 'enemyDamageRes', stats.elemental_damage_res ?? 0),
    attack_speed: stats.attack_interval ? grade(bands, 'attackSpeed', stats.attack_interval) : null,
    move_speed: grade(bands, 'moveSpeed', stats.move_speed),
  };
}

/**
 * An attribute node's value, or undefined when it has none.
 *
 * m_defined is not the whole story. A node can be undefined and still carry the
 * value the client uses -- Crystal Doll's rangeRadius is undefined at 99, the level-1
 * Sargonian Cat's DEF undefined at 700 -- while an undefined 0 is a blank the client
 * fills from elsewhere. So a node counts when it is defined OR its value is not
 * empty, the reading the import made and every existing record follows.
 */
function valueOf(node) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const v = node.m_value;
  if (node.m_defined || (v != null && v !== 0 && v !== false && v !== '')) return v ?? undefined;
  return undefined;
}

/**
 * Every database level as a record level. Only level 0 is complete: each later
 * level declares what it changes and inherits the rest from the level BEFORE it,
 * so level 2 of a boss that only raises its HP at level 1 keeps that raised HP.
 * Skills and talent parameters inherit the same way, one skill or one blackboard
 * key at a time: Mandragora's level 1 restates PetrifiedRay alone and keeps the
 * other five skills of level 0.
 */
function levels(rows, bands) {
  const out = [];
  let attrs = {};
  let spData = null;
  const skillsByKey = new Map();      // prefabKey -> skill, in first-declared order
  const talentsByKey = new Map();     // '<talent>.<parameter>' -> blackboard entry
  for (const row of asList(rows)) {
    const data = row?.enemyData || {};
    attrs = { ...attrs };
    const nodes = { ...(data.attributes || {}), rangeRadius: data.rangeRadius, lifePointReduce: data.lifePointReduce };
    for (const [key, node] of Object.entries(nodes)) {
      const v = valueOf(node);
      if (v !== undefined) attrs[key] = v;
    }
    if (data.spData != null) spData = data.spData;
    for (const skill of asList(data.skills)) if (skill?.prefabKey) skillsByKey.set(skill.prefabKey, skill);
    for (const entry of asList(data.talentBlackboard)) {
      if (typeof entry?.key === 'string') talentsByKey.set(entry.key, entry);
    }

    const stats = {};
    for (const [field, attribute] of STATS) stats[field] = attrs[attribute] ?? null;
    // -1 is the client's "no range": a melee enemy that never reaches past its tile.
    if (stats.range === -1) stats.range = null;
    out.push({
      level: row.level ?? out.length,
      stats,
      stat_ranks: statRanks(bands, stats),
      skills: skills([...skillsByKey.values()]),
      talents: talents([...talentsByKey.values()]),
      immunities: IMMUNITIES.filter(([attribute]) => attrs[attribute] === true).map(([, label]) => label),
      sp: sp(spData),
    });
  }
  return out;
}

function buildRecord(id, entry, rows, { slugOf, races, bands, icon }) {
  const base = rows?.[0]?.enemyData || {};
  const name = plain(entry.name);
  const index = text(entry.enemyIndex);
  const description = text(entry.description);
  const tags = asList(valueOf(base.enemyTags));
  return {
    slug: slugOf.get(id),
    id,
    name,
    index: index === '-' ? null : index,
    rank: RANK[entry.enemyLevel],
    sort: entry.sortId,
    hidden: Boolean(entry.hideInHandbook),
    icon,
    // '-' is the handbook's placeholder for no description, as it is for no index.
    flavour_text: description === '-' ? null : description,
    race: tags.map((tag) => races[tag]?.raceName).find(Boolean) ?? null,
    movement: MOVEMENT[valueOf(base.motion)] ?? 'Ground',
    attack_position: ATTACK_POSITION[valueOf(base.applyWay)] ?? null,
    damage_type: asList(entry.damageType).map((t) => DAMAGE_TYPE[t] ?? t),
    abilities: asList(entry.abilityList)
      .map((a) => ({ text: text(a.text), format: String(a.textFormat || 'NORMAL').toLowerCase() }))
      .filter((a) => a.text),
    levels: levels(rows, bands),
  };
}

// --- run --------------------------------------------------------------------

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Writes `value` unless the file already says exactly that. */
function writeIfChanged(file, value) {
  if (fs.existsSync(file) && canonical(readJson(file)) === canonical(value)) return false;
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

function main() {
  for (const required of [BUNDLES, APPEARANCES, STAGES, CONTENTS, INDEX]) {
    if (!fs.existsSync(required)) throw new Error(`missing ${path.relative(ROOT, required)}`);
  }
  const alerts = beginStage(ROOT, 'enemies');
  const handbookTable = excel('enemy_handbook_table');
  const handbook = handbookTable.enemyData || {};
  const bands = asList(handbookTable.levelInfoList);
  const races = handbookTable.raceData || {};
  const databaseFile = path.join(levelsDir, 'enemydata', 'enemy_database.json');
  if (!fs.existsSync(databaseFile)) throw new Error(`missing ${databaseFile}`);
  const database = readJson(databaseFile);
  const slugOf = enemySlugs(handbook);
  const idBySlug = new Map([...slugOf].map(([id, slug]) => [slug, id]));

  // The existing partition: which bundle each enemy lives in, where in it, and its icon.
  const bundles = new Map();          // content id -> {file, content, ids}
  const filedIn = new Map();          // enemy id -> content id
  const position = new Map();         // enemy id -> its place in that bundle
  const iconOf = new Map();           // enemy id -> icon as recorded
  const recorded = new Map();         // enemy id -> the record as filed, kept if its entries vanish
  for (const file of fs.readdirSync(BUNDLES).sort()) {
    if (!file.endsWith('.json')) continue;
    const bundle = readJson(path.join(BUNDLES, file));
    if (bundles.has(bundle.content.id)) throw new Error(`two bundles for content ${bundle.content.id}`);
    bundles.set(bundle.content.id, { file, content: bundle.content, ids: [] });
    for (const enemy of bundle.enemies || []) {
      if (filedIn.has(enemy.id)) throw new Error(`${enemy.id} is filed in two bundles`);
      filedIn.set(enemy.id, bundle.content.id);
      position.set(enemy.id, position.size);
      iconOf.set(enemy.id, enemy.icon ?? null);
      recorded.set(enemy.id, enemy);
    }
  }

  // Which listed stages field which enemies, per content.
  const listed = new Set(readJson(INDEX).map((row) => row.slug));
  const contentBlock = new Map();     // content id -> the stage records' content block
  const fielded = new Map();          // content id -> Set of enemy slugs
  for (const file of fs.readdirSync(STAGES).sort()) {
    if (!file.endsWith('.json')) continue;
    const stage = readJson(path.join(STAGES, file));
    if (!listed.has(stage.slug) || !stage.content?.id) continue;
    const enemies = stage.enemies || {};
    const slugs = new Set();
    for (const group of [enemies.by_rank, enemies.conditional?.by_rank]) {
      for (const list of Object.values(group || {})) {
        for (const entry of list || []) if (entry.slug) slugs.add(entry.slug);
      }
    }
    if (!slugs.size) continue;
    if (!contentBlock.has(stage.content.id)) contentBlock.set(stage.content.id, stage.content);
    if (!fielded.has(stage.content.id)) fielded.set(stage.content.id, new Set());
    for (const slug of slugs) fielded.get(stage.content.id).add(slug);
  }

  // A content the stage dataset has re-filed under another id. When a rerun ships,
  // the rerun's activity registers the original's levels and the stage build files
  // every stage under it: When Elegies Are Ashes was act41side when the enemies were
  // imported and is act41sre in the stages now. The enemy side has to follow, or the
  // stage links (keyed by the new id) find no appearance row to hang off, and the
  // enemy page lists the event twice -- once with no stages. So a bundle whose id
  // the stage dataset no longer has, facing exactly one content of the same kind,
  // label and name that has no bundle and no row of its own, takes that content's id.
  // Facing several, it is left where it is and reported: which rerun it became is a
  // question for a person. Facing none is normal -- Defense Protocols, Design of Strife
  // and the first RA season were minted from mode tables no stage names.
  const registry = readJson(CONTENTS);
  const rows = new Map(readJson(APPEARANCES).map((row) => [row.id, row]));
  const same = (a, b) => a.kind === b.kind && a.name === b.name && (a.label ?? null) === (b.label ?? null);
  const rekeyed = [];
  for (const [oldId, bundle] of [...bundles]) {
    if (registry[oldId]) continue;
    const matches = Object.values(registry)
      .filter((c) => !bundles.has(c.id) && !rows.has(c.id) && same(c, bundle.content));
    if (matches.length > 1) {
      alerts.add({ key: `enemy-bundle:${oldId}`, action: 'kept-previous',
        reason: `The stage dataset no longer has content ${oldId} (${bundle.content.name}), and ${matches.length} contents of the same kind and name could have taken its place (${matches.map((c) => c.id).join(', ')}); data/enemies/${bundle.file} keeps its old id.` });
    }
    if (matches.length !== 1) continue;
    const content = matches[0];
    bundles.delete(oldId);
    bundles.set(content.id, { ...bundle, content });
    for (const [id, contentId] of filedIn) if (contentId === oldId) filedIn.set(id, content.id);
    const row = rows.get(oldId);
    if (row) {
      rows.delete(oldId);
      rows.set(content.id, { ...row, id: content.id });
    }
    rekeyed.push(`${oldId} -> ${content.id} (${content.name})`);
  }

  // A slug a stage names that the handbook does not know is a stage build that
  // disagrees with this one, and the enemy would silently have no page.
  const unknown = [...fielded.values()].flatMap((s) => [...s]).filter((slug) => !idBySlug.has(slug));
  if (unknown.length) throw new Error(`stages field enemies the handbook has no entry for: ${[...new Set(unknown)].join(', ')}`);

  // File each new enemy under the earliest content that fields it.
  const released = (id) => bundles.get(id)?.content.release_date ?? contentBlock.get(id)?.release_date ?? '9999';
  const firstFielding = new Map();    // enemy id -> content id
  for (const contentId of [...fielded.keys()].sort((a, b) => byCodePoint(released(a), released(b)) || byCodePoint(a, b))) {
    for (const slug of fielded.get(contentId)) {
      const id = idBySlug.get(slug);
      if (!firstFielding.has(id)) firstFielding.set(id, contentId);
    }
  }
  const added = [];
  for (const [id, contentId] of firstFielding) {
    if (filedIn.has(id)) continue;
    if (!database[id]) {
      alerts.add({ key: `enemy:${id}`, action: 'omitted-new',
        reason: `${id} (${slugOf.get(id)}) is fielded by ${contentId} but has no enemy_database entry, so it gets no record yet.` });
      continue;
    }
    filedIn.set(id, contentId);
    added.push(id);
    if (!bundles.has(contentId)) {
      const content = registry[contentId] || contentBlock.get(contentId);
      bundles.set(contentId, { file: bundleFile(content), content, ids: [] });
    }
  }

  // A new record's icon is named after the enemy, as every record's is -- unless
  // another record already has that file. Records that share a name share a picture
  // only when the art is identical (boss phases, difficulty tiers), which nothing
  // here can see, and the two Jailed Students of People, A People share a name and
  // not a picture. So the later one is told apart by its handbook code and the image
  // sync publishes it from its own upstream file: a duplicate picture under a second
  // name costs a few KB, a wrong picture is a wrong page.
  const claimed = new Set([...iconOf.values()].filter(Boolean));
  for (const id of [...added].sort((a, b) => handbook[a].sortId - handbook[b].sortId || byCodePoint(a, b))) {
    const name = plain(handbook[id].name);
    const index = text(handbook[id].enemyIndex);
    let icon = iconPath(name);
    if (claimed.has(icon)) icon = iconPath(`${name} (${index && index !== '-' ? index : id})`);
    if (claimed.has(icon)) icon = iconPath(`${name} (${id})`);
    claimed.add(icon);
    iconOf.set(id, icon);
  }

  // Rebuild every record, bundle by bundle. One whose entries have vanished from the
  // tables cannot be rebuilt, and keeps the version already filed.
  const stale = new Set();
  for (const [id, contentId] of filedIn) {
    const vanished = [!handbook[id] && 'enemy_handbook_table', !database[id] && 'enemy_database'].filter(Boolean);
    if (vanished.length) {
      stale.add(id);
      alerts.add({ key: `enemy:${id}`, action: 'kept-previous',
        reason: `${id} (${recorded.get(id)?.name ?? 'unnamed'}) has a record but no ${vanished.join(' or ')} entry; its previous record is kept.` });
    }
    bundles.get(contentId).ids.push(id);
  }
  const taken = new Set();
  let written = 0;
  for (const bundle of [...bundles.values()].sort((a, b) => byCodePoint(a.file, b.file))) {
    if (taken.has(bundle.file)) throw new Error(`two contents want data/enemies/${bundle.file}`);
    taken.add(bundle.file);
    const enemies = bundle.ids
      .map((id) => (stale.has(id) ? recorded.get(id) : buildRecord(id, handbook[id], database[id], {
        slugOf, races, bands, icon: iconOf.get(id),
      })))
      // Filed records keep their place -- the import's order is arbitrary but moving
      // it rewrites the file for nothing -- and new ones follow in handbook order.
      .sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity)
        || a.sort - b.sort || byCodePoint(a.slug, b.slug));
    const body = { schema_version: SCHEMA_VERSION, content: bundle.content, enemies };
    if (writeIfChanged(path.join(BUNDLES, bundle.file), body)) written += 1;
  }

  // Appearances: every existing row kept, each gaining what its listed stages field.
  let grown = 0;
  for (const [contentId, slugs] of fielded) {
    const known = rows.get(contentId);
    const content = known || bundles.get(contentId)?.content || contentBlock.get(contentId);
    const enemies = new Set([...(known?.enemies || []), ...slugs]);
    if (known && enemies.size === known.enemies.length) continue;
    grown += 1;
    const sorted = [...enemies].sort(byCodePoint);
    rows.set(contentId, {
      kind: content.kind, id: contentId, label: content.label ?? null, name: content.name,
      enemy_count: sorted.length, enemies: sorted,
    });
  }
  // Grouped by kind, then by name -- the order the import wrote.
  const appearanceRows = [...rows.values()].sort((a, b) => byCodePoint(a.kind, b.kind)
    || byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id));
  writeIfChanged(APPEARANCES, appearanceRows);

  const total = [...bundles.values()].reduce((n, b) => n + b.ids.length, 0);
  console.log(`${total} enemies in ${bundles.size} bundles: ${added.length} new, ${written} bundle file(s) written`
    + `; ${grown} appearance row(s) added or grown, ${rekeyed.length} content(s) re-keyed`);
  for (const line of rekeyed) console.log(`  ~ ${line}: re-filed by the stage dataset`);
  for (const id of added) console.log(`  + ${slugOf.get(id)} -> ${bundles.get(filedIn.get(id)).file}`);
  for (const entry of alerts.commit()) console.warn(`  ! ${entry.key} (${entry.action}): ${entry.reason}`);
}

main();
