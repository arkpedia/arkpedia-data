#!/usr/bin/env node
/**
 * The CN game tables of a refresh, all from ONE mirror at ONE commit, and the CN art beside them.
 *
 *   node scripts/content/cn-tables.mjs        stage upstream-cn, an invariant: the tables
 *   node scripts/content/cn-tables.mjs art    stage upstream-cn-art: map/ and item/
 *
 * Every reader finds both under .cache/upstream/cn-resource, as it did when that was a single
 * checkout of yuanyan3060/ArknightsGameResource: gamedata/ (excel/ and levels/), map/ and item/.
 * It is now a directory of links. gamedata/ links to the first of these that serves tables:
 *
 *   1. Kengxxiao/ArknightsGameData (zh_CN/gamedata) at the commit pinned for this run;
 *   2. the same mirror at the commit the last run read, when that is another one (a dump
 *      published half-way at the pinned commit);
 *   3. yuanyan3060/ArknightsGameResource (gamedata) at the commit pinned for this run.
 *
 * Each is a partial, sparse checkout of excel/ and levels/ (scripts/lib/upstream.sh), held to
 * the table contract below: every table a reader of the refresh opens is there, parses, and
 * holds about as many records as the game has. The first that passes is the run's, recorded as
 * `cnTables` in data/upstream.lock.json, and run-stage.mjs hands it to every later stage
 * (ARKPEDIA_CN_TABLES): the stages that fetch a CN table by URL -- the catalogue, the voice
 * lines, the content inventory -- read the same mirror at the same commit as the checkout the
 * others read (cnTableUrl() in pin-upstream.mjs). Tables from anything but the first are
 * reported under 'upstream-cn' in data/quarantine.json, which the daily issue lists, with a
 * reason that names no error, so a long outage does not rewrite it every day; the run log and
 * its warnings say what failed. Only no usable tables from any source fails the stage, and
 * with it the run.
 *
 * The two mirrors serialize the same dump differently: Kengxxiao names each enum ("TIER_6",
 * "NORMAL") and writes an empty list as null, yuanyan numbers them and writes []. The stage
 * readers take either (on 2026-09-24 they wrote the same bytes from both); the catalogue reads
 * named enums only, and fails its own stage on the other (sync-catalogue.mjs source()), which
 * keeps its records as last published.
 *
 * map/ and item/ -- the Contingency Contract renders and the item icons, which only yuanyan
 * carries -- link to a checkout of those two folders alone, at yuanyan's pin. That stage is no
 * invariant: when the art cannot be had, the links are removed and it fails alone. item-icons,
 * which needs it, is skipped and keeps its records; cc-stages still names and labels every
 * stage, keeps each render the image repository publishes, and reports the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CN_TABLE_SOURCES, LOCK, cnTablesRecord, pinVariable, readLock } from './pin-upstream.mjs';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';

/** What the readers open (ARKPEDIA_CN points one elsewhere): gamedata/, map/ and item/, as links. */
export const COMPOSED = '.cache/upstream/cn-resource';
const UPSTREAM = '.cache/upstream';
/** The checkout, under .cache/upstream/, each CN table source is synced into. */
export const TABLE_CHECKOUTS = { 'Kengxxiao/ArknightsGameData': 'cn-tables', 'yuanyan3060/ArknightsGameResource': 'cn-tables-fallback' };
/** The art only yuanyan carries, in a checkout of its own. */
export const ART = { repository: 'yuanyan3060/ArknightsGameResource', checkout: 'cn-art', folders: ['map', 'item'], least: 500 };
/** The quarantine stage for tables that did not come from the primary mirror at its pin. */
export const STAGE = 'upstream-cn';
// One sync that hangs must leave the stage time to try the next source.
const SYNC_TIMEOUT_MINUTES = 10;
const sha = /^[a-f0-9]{40}$/;
const size = value => (value && typeof value === 'object' ? Object.keys(value).length : 0);
const inActions = () => process.env.GITHUB_ACTIONS === 'true';
// Workflow commands take one line; %, CR and LF have to be escaped to survive.
const annotation = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const warn = (title, text) => console.log(inActions() ? `::warning title=${title}::${annotation(text)}` : `warning: ${text}`);

/*
 * The table contract: every table a reader of the refresh opens -- the scripts that read
 * ARKPEDIA_CN or .cache/upstream/cn-resource, and the catalogue, voice and inventory stages,
 * which fetch theirs by URL from the same source -- each holding at least about half the
 * records the game had in 2026-09. A mirror that published part of a dump, or a table cut
 * short, fails here, where the next source can stand in, instead of in whichever stage opens it.
 */
export const TABLE_CONTRACT = {
  'activity_table.json': table => size(table.basicInfo) >= 150,
  'battle_equip_table.json': table => size(table) >= 250,
  'building_data.json': table => size(table.chars) >= 200 && size(table.customData?.furnitures) >= 1400,
  'campaign_table.json': table => size(table.campaigns) >= 18,
  'char_patch_table.json': table => size(table.patchChars) >= 1,
  'character_table.json': table => size(table) >= 600,
  // The event-rewards stage names charms from it, as the stage pipeline's drops do: a charmList,
  // or a bare list in a mirror that writes it so.
  'charm_table.json': table => size(table.charmList ?? table) >= 10,
  'charword_table.json': table => size(table.charWords) >= 9000 && size(table.voiceLangDict) >= 200,
  'crisis_v2_table.json': table => size(table.seasonInfoDataMap) >= 1,
  // The event-rewards stage names a reward's player icon, background and theme from it.
  'display_meta_table.json': table => size(table.playerAvatarData?.avatarList) >= 10 && size(table.homeBackgroundData?.homeBgDataList) >= 1,
  'gacha_table.json': table => Array.isArray(table.gachaPoolClient) && table.gachaPoolClient.length >= 200,
  'gamedata_const.json': table => Array.isArray(table.evolveGoldCost),
  'handbook_info_table.json': table => size(table.handbookDict) >= 200,
  'item_table.json': table => size(table.items) >= 750,
  'range_table.json': table => size(table) >= 35,
  'retro_table.json': table => size(table.retroActList) >= 20,
  'roguelike_topic_table.json': table => size(table.topics) >= 3,
  'sandbox_perm_table.json': table => size(table.detail) >= 1,
  'skill_table.json': table => size(table) >= 900,
  'skin_table.json': table => size(table.charSkins) >= 1100,
  'stage_table.json': table => size(table.stages) >= 1700 && size(table.storylines) >= 7,
  'uniequip_table.json': table => size(table.equipDict) >= 450,
};
/** Level files under levels/: 3,793 (yuanyan) and 3,901 (Kengxxiao) in 2026-09. */
export const LEAST_LEVELS = 1800;

/** JSON files under `dir`, counted up to `enough`. */
function countFiles(dir, pattern, enough) {
  let count = 0;
  const walk = at => {
    let entries;
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= enough) return;
      if (entry.isDirectory()) walk(path.join(at, entry.name));
      else if (pattern.test(entry.name)) count++;
    }
  };
  walk(dir);
  return count;
}

/** What is wrong with the tables under `gamedata` (the folder holding excel/ and levels/), and
 * how they write enums: {problems: [...], serialization: 'named' | 'numeric' | null}. */
export function checkTables(gamedata) {
  const problems = [];
  let serialization = null;
  for (const [file, holds] of Object.entries(TABLE_CONTRACT)) {
    let table;
    try {
      table = JSON.parse(fs.readFileSync(path.join(gamedata, 'excel', file), 'utf8'));
    } catch (error) {
      problems.push(`excel/${file} is ${error.code === 'ENOENT' ? 'missing' : 'not JSON'}`);
      continue;
    }
    if (!table || typeof table !== 'object' || !holds(table)) {
      problems.push(`excel/${file} holds fewer records than a whole dump`);
      continue;
    }
    if (file === 'character_table.json') {
      // How most of them write it: a mirror that names enums can still number one it cannot name.
      const kinds = Object.values(table).map(character => typeof character?.rarity);
      const most = kind => kinds.filter(each => each === kind).length * 2 > kinds.length;
      serialization = most('string') ? 'named' : most('number') ? 'numeric' : null;
      if (!serialization) problems.push('excel/character_table.json writes rarity as neither a name nor a number');
    }
  }
  const levels = countFiles(path.join(gamedata, 'levels'), /\.json$/, LEAST_LEVELS);
  if (levels < LEAST_LEVELS) problems.push(`levels/ holds ${levels} level files, fewer than a whole dump`);
  return { problems, serialization };
}

/* ---- checkouts ----------------------------------------------------------------- */

/** Runs a command in a process group of its own, so that git under it goes when it is timed
 * out or this stage is (run-stage.mjs signals the stage's group, not this one), echoing its
 * output; resolves to {code, tail, timedOut}. */
function run(command, args, options, timeoutMinutes) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let tail = '', timedOut = false;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
    const forward = signal => { kill('SIGKILL'); process.exit(signal === 'SIGINT' ? 130 : 143); };
    process.once('SIGINT', forward).once('SIGTERM', forward);
    const keep = (stream, chunk) => { stream.write(chunk); tail = `${tail}${chunk}`.slice(-4000); };
    child.stdout.on('data', chunk => keep(process.stdout, chunk));
    child.stderr.on('data', chunk => keep(process.stderr, chunk));
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeoutMinutes * 60_000);
    const done = result => {
      clearTimeout(timer);
      process.off('SIGINT', forward).off('SIGTERM', forward);
      resolve({ ...result, tail: result.tail ?? tail, timedOut });
    };
    child.on('error', error => done({ code: null, tail: error.message }));
    child.on('close', code => done({ code }));
  });
}

/**
 * Syncs one checkout under .cache/upstream/ at `commit` (null: the branch head) with
 * scripts/lib/upstream.sh, and returns the commit it holds; throws with the first fatal: or
 * error: line git printed, else its last line. The commit is given to upstream.sh as the
 * mirror's pin, which for the last run's commit is not the pin of this run.
 */
export async function upstreamSync(root, { repository, commit, checkout, folders }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };
  delete env[pinVariable(repository)];
  if (commit) env[pinVariable(repository)] = commit;
  const result = await run('bash', ['scripts/lib/upstream.sh', checkout, `https://github.com/${repository}.git`, 'default', ...folders],
    { cwd: root, env }, SYNC_TIMEOUT_MINUTES);
  if (result.code !== 0) {
    // git's first fatal: or error: line names the failure; the lines after it are advice.
    const lines = result.tail.split('\n').map(line => line.trim()).filter(Boolean);
    const said = lines.find(line => /^(fatal|error):/.test(line)) ?? lines.at(-1);
    throw new Error(result.timedOut ? `no answer within ${SYNC_TIMEOUT_MINUTES} min` : said || `upstream.sh exited ${result.code}`);
  }
  const head = await run('git', ['-C', path.join(UPSTREAM, checkout), 'rev-parse', 'HEAD'], { cwd: root, env }, 1);
  const at = head.tail.trim().split('\n').at(-1);
  if (head.code !== 0 || !sha.test(at ?? '')) throw new Error(`${checkout} holds no commit after the sync`);
  return at;
}

/*
 * .cache/upstream/cn-resource as a directory of links. Until 2026-09 it was one checkout of
 * yuanyan's tables and art; that checkout becomes the art checkout, so a cache from before (a
 * local .cache/upstream, or one the retired refresh-stage-data.yml restored) does not download
 * the art again. Its tables go:
 * restored from a cache, git takes them for changed files and would keep them at the next
 * sync, 600 MB that nothing reads.
 */
function compose(root) {
  const at = path.join(root, COMPOSED);
  let stat = null;
  try { stat = fs.lstatSync(at); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat?.isSymbolicLink() || stat?.isFile()) fs.unlinkSync(at);
  else if (stat && fs.existsSync(path.join(at, '.git'))) {
    const art = path.join(root, UPSTREAM, ART.checkout);
    if (fs.existsSync(art)) fs.rmSync(at, { recursive: true, force: true });
    else {
      fs.renameSync(at, art);
      fs.rmSync(path.join(art, 'gamedata'), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(at, { recursive: true });
}
function unlink(root, name) {
  const at = path.join(root, COMPOSED, name);
  let stat;
  try { stat = fs.lstatSync(at); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) fs.rmSync(at, { recursive: true, force: true });
  else fs.unlinkSync(at);
}
/** cn-resource/<name> -> <target>, relative to cn-resource, so the cache can move. */
function link(root, name, target) {
  unlink(root, name);
  fs.symlinkSync(target, path.join(root, COMPOSED, name));
}

/* ---- the tables ---------------------------------------------------------------- */

/** The sources to try, in order: the primary at its pin, the primary at the commit the last run
 * read (pin-upstream.mjs keeps it as lastCnTables) when that is another one, the fallback. */
export function candidates(lock) {
  const [primary, fallback] = CN_TABLE_SOURCES;
  const pinned = repository => {
    const commit = lock?.repositories?.[repository]?.commit;
    return sha.test(commit ?? '') ? commit : null;
  };
  const last = cnTablesRecord(lock?.lastCnTables);
  return [
    { ...primary, commit: pinned(primary.repository), as: 'pinned' },
    ...(last?.repository === primary.repository && last.commit !== pinned(primary.repository) ? [{ ...primary, commit: last.commit, as: 'last-run' }] : []),
    { ...fallback, commit: pinned(fallback.repository), as: 'fallback' },
  ];
}

function writeLock(root, lock) {
  const file = path.join(root, LOCK);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/* The quarantine entry for tables that are not the primary mirror's at the pin. It says where
 * they came from and what that costs, never the day's error: the file is published, and a
 * refused connection one day and a timeout the next are the same outage. */
function reasonFor(chosen, tables) {
  const [primary] = CN_TABLE_SOURCES;
  if (chosen.as === 'last-run') {
    return `${primary.repository} could not be synced, or failed the table contract, at the commit pinned for this run, so the CN tables come from the commit of it the last run read. The run log says what failed.`;
  }
  return `${primary.repository} could not be synced, or failed the table contract, so the CN tables come from ${tables.repository}.`
    + (tables.serialization === 'numeric' ? ' That mirror numbers the game\'s enums, which the catalogue does not read: the catalogue keeps its records as last published until the primary is back.' : '')
    + ' The run log says what failed.';
}

/**
 * Settles the run's CN tables: syncs and checks each candidate in turn, links the first that
 * passes as cn-resource/gamedata, records it in the lock and reports anything but the first.
 * Returns {tables, chosen, failures}; throws when no source serves usable tables.
 */
export async function resolveTables(root, { sync = upstreamSync, check = checkTables, now = defaultNow() } = {}) {
  const lock = readLock(root);
  if (!lock) throw new Error(`${LOCK} is missing or unreadable; the pin-upstream stage writes it first`);
  compose(root);
  const failures = [];
  for (const candidate of candidates(lock)) {
    const checkout = TABLE_CHECKOUTS[candidate.repository];
    const where = `${candidate.repository}${candidate.commit ? ` at ${candidate.commit.slice(0, 12)}` : ''} (${candidate.as})`;
    let commit;
    try {
      commit = await sync(root, { repository: candidate.repository, commit: candidate.commit, checkout, folders: [`${candidate.folder}/excel`, `${candidate.folder}/levels`] });
    } catch (error) {
      failures.push(`${where} could not be synced: ${error.message}`);
      warn('CN tables source unavailable', failures.at(-1));
      continue;
    }
    const { problems, serialization } = check(path.join(root, UPSTREAM, checkout, candidate.folder));
    if (problems.length) {
      failures.push(`${where} fails the table contract: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`);
      warn('CN tables source unusable', failures.at(-1));
      continue;
    }
    const tables = { repository: candidate.repository, commit, folder: candidate.folder, serialization };
    link(root, 'gamedata', path.join('..', checkout, candidate.folder));
    const { lastCnTables: _, ...pins } = lock;
    writeLock(root, { ...pins, cnTables: tables });
    const alerts = beginStage(root, STAGE, now);
    if (candidate.as !== 'pinned') alerts.add({ key: 'cn-tables', action: candidate.as === 'last-run' ? 'kept-previous' : 'published-partial', reason: reasonFor(candidate, tables) });
    alerts.commit();
    return { tables, chosen: candidate, failures };
  }
  // Nothing may read tables this run did not settle on.
  unlink(root, 'gamedata');
  throw new Error(`No source serves usable CN tables, so no stage has them:\n${failures.map(line => `  ${line}`).join('\n')}`);
}

/* ---- the art ------------------------------------------------------------------- */

/** Syncs map/ and item/ at yuanyan's pin and links them into cn-resource; returns the commit.
 * On failure the links are removed first, so no stage reads art of another commit. */
export async function syncArt(root, { sync = upstreamSync } = {}) {
  const commit = readLock(root)?.repositories?.[ART.repository]?.commit;
  compose(root);
  for (const folder of ART.folders) unlink(root, folder);
  const at = await sync(root, { repository: ART.repository, commit: sha.test(commit ?? '') ? commit : null, checkout: ART.checkout, folders: ART.folders });
  for (const folder of ART.folders) {
    const files = countFiles(path.join(root, UPSTREAM, ART.checkout, folder), /\.png$/, ART.least);
    if (files < ART.least) throw new Error(`${ART.repository} ${folder}/ holds ${files} images, fewer than it publishes`);
  }
  for (const folder of ART.folders) link(root, folder, path.join('..', ART.checkout, folder));
  return at;
}

async function main(argv) {
  const root = process.cwd();
  if (argv[0] === 'art' && argv.length === 1) {
    title = 'No CN art';
    const commit = await syncArt(root);
    console.log(`  CN art (${ART.folders.join('/, ')}/) from ${ART.repository} at ${commit.slice(0, 12)}`);
    return;
  }
  if (argv.length) throw new Error('usage: cn-tables.mjs [art]');
  const { tables, chosen } = await resolveTables(root);
  console.log(`  CN tables from ${tables.repository} at ${tables.commit.slice(0, 12)} (${chosen.as}; enums ${tables.serialization})`);
  if (chosen.as !== 'pinned') warn('CN tables from a fallback', `The CN tables come from ${tables.repository} at ${tables.commit.slice(0, 12)} (${chosen.as}); see the warnings above for why.`);
}
let title = 'No CN tables';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.log(inActions() ? `::error title=${title}::${annotation(error.message)}` : error.message);
    process.exitCode = 1;
  });
}
