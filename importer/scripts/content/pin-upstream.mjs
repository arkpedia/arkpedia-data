#!/usr/bin/env node
/**
 * Resolves each upstream game-data mirror to ONE commit at the start of a refresh, so a
 * mirror that moves while the run is in progress cannot leave it with tables from two
 * versions.
 *
 *   node scripts/content/pin-upstream.mjs                       write data/upstream.lock.json
 *   node scripts/content/pin-upstream.mjs raw-url <repo> <path>  print a raw file URL at the pin
 *   node scripts/content/pin-upstream.mjs cn-table-url <file>    print a CN table's raw URL, for a
 *                                                                file under gamedata/ (cnTableUrl)
 *
 * The lock is published with the release, so the next run loads it with the rest of the
 * data and falls back to its commit for a mirror it cannot reach, with a warning instead of
 * a failed run. It has no timestamps on purpose: it changes only when a mirror moves.
 *
 * Every stage run by run-stage.mjs gets one environment variable per mirror (pinVariable),
 * holding the commit. A script that reads a mirror builds its URL from pinnedRef() (or
 * pinnedCommit() when it records the commit), a Python one from the variable itself:
 *   os.environ.get('ARKPEDIA_PIN_ARKNIGHTSASSETS_ARKNIGHTSGAMEDATA') or 'master'
 * and scripts/lib/upstream.sh reads the variable for its clone by itself.
 *
 * The CN game tables are the exception: they come from whichever of CN_TABLE_SOURCES the
 * run's upstream-cn stage settled on (scripts/content/cn-tables.mjs), recorded as `cnTables`
 * in the lock and passed to every later stage as ARKPEDIA_CN_TABLES. A script that fetches a
 * CN table builds its URL from cnTableUrl() or cnTables() (Python and shell: the cn-table-url
 * command above), never from a mirror's pin -- neither Kengxxiao's nor yuanyan's, whose pin is
 * for its art -- so it reads the same mirror at the same commit as the checkout every other
 * stage reads (.cache/upstream/cn-resource/gamedata). A test holds every stage's scripts to
 * this (test-stage-runner.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const LOCK = 'data/upstream.lock.json';
export const MIRRORS = [
  { repository: 'Kengxxiao/ArknightsGameData', branch: 'master' },
  { repository: 'ArknightsAssets/ArknightsGamedata', branch: 'master' },
  { repository: 'yuanyan3060/ArknightsGameResource', branch: 'main' },
  { repository: 'PuppiizSunniiz/ArknightsGameData_YoStar', branch: 'main' },
  // The Global client's art, for the Standard banners' name plates (banner-art-lineup.mjs).
  { repository: 'ArknightsAssets/ArknightsAssets2', branch: 'en' },
  // The CN client's furniture shop thumbnails; retain them beside Global's.
  { repository: 'ArknightsAssets/ArknightsAssets2', branch: 'cn', key: 'ArknightsAssets/ArknightsAssets2:cn' },
];
/*
 * Where the CN tables (gamedata/excel and gamedata/levels) may come from, in order: ALL of
 * them from one per run, at one commit (scripts/content/cn-tables.mjs). The two serialize
 * the same dump differently -- the first names each enum ("TIER_6") and writes an empty list
 * as null, the second numbers them and writes [] -- which the stage readers take either way
 * and the catalogue does not (sync-catalogue.mjs source()).
 */
export const CN_TABLE_SOURCES = [
  { repository: 'Kengxxiao/ArknightsGameData', folder: 'zh_CN/gamedata' },
  { repository: 'yuanyan3060/ArknightsGameResource', folder: 'gamedata' },
];
/** The run's CN tables as run-stage.mjs hands them to every stage: the lock's `cnTables`, as JSON. */
export const CN_TABLES_VARIABLE = 'ARKPEDIA_CN_TABLES';
const sha = /^[a-f0-9]{40}$/;
// Names the runner filled in from the lock itself, which pinUpstream must not read back as
// a commit someone chose: that would freeze every run on the first lock it ever wrote.
export const INJECTED = 'ARKPEDIA_PINS_INJECTED';

/** A `cnTables` record -- {repository, commit, folder, serialization} -- that names one of
 * CN_TABLE_SOURCES at a commit, or null. */
export function cnTablesRecord(value) {
  const source = CN_TABLE_SOURCES.find(entry => entry.repository === value?.repository);
  if (!source || !sha.test(value.commit ?? '') || value.folder !== source.folder || !['named', 'numeric'].includes(value.serialization)) return null;
  return { repository: source.repository, commit: value.commit, folder: source.folder, serialization: value.serialization };
}

/** ARKPEDIA_PIN_<OWNER>_<REPO>, upper case, every other character run an underscore. */
export const pinVariable = repository => `ARKPEDIA_PIN_${repository.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

export function readLock(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK), 'utf8'));
    return lock?.version === 1 && lock.repositories && typeof lock.repositories === 'object' ? lock : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The pinned commits as environment variables, leaving any already set alone. */
export function pinEnvironment(root, env = process.env) {
  const lock = readLock(root);
  const pins = {};
  for (const [repository, entry] of Object.entries(lock?.repositories ?? {})) {
    const name = pinVariable(repository);
    if (sha.test(entry?.commit ?? '') && !env[name]) pins[name] = entry.commit;
  }
  if (Object.keys(pins).length) pins[INJECTED] = Object.keys(pins).join(',');
  // Once the upstream-cn stage has settled on them, every later stage reads the same tables.
  const tables = cnTablesRecord(lock?.cnTables);
  if (tables && !env[CN_TABLES_VARIABLE]) pins[CN_TABLES_VARIABLE] = JSON.stringify(tables);
  return pins;
}

/**
 * One commit per mirror/region: an optional key keeps a second branch of the same
 * repository in its own lock entry and environment variable (the CN furniture art).
 * A commit given in the environment, else the branch head, else the
 * previous lock's commit (with a warning), else none (with a warning; readers then use the
 * branch, as they did before pinning).
 */
export async function pinUpstream({ previous = null, resolve, env = {}, mirrors = MIRRORS }) {
  const injected = new Set(String(env[INJECTED] ?? '').split(',').filter(Boolean));
  const repositories = {}, warnings = [];
  for (const { repository, branch, key = repository } of mirrors) {
    const variable = pinVariable(key);
    const given = injected.has(variable) ? '' : String(env[variable] ?? '');
    let commit = null, source;
    if (sha.test(given)) { commit = given; source = 'given'; } else {
      try {
        commit = await resolve(repository, branch);
        if (!sha.test(commit ?? '')) throw new Error(`not a commit: ${JSON.stringify(commit)}`);
        source = 'resolved';
      } catch (error) {
        const last = previous?.repositories?.[key]?.commit;
        if (sha.test(last ?? '')) {
          commit = last; source = 'last-known';
          warnings.push(`${repository}: cannot resolve ${branch} (${error.message}); using the last known commit ${last.slice(0, 12)}`);
        } else {
          commit = null; source = 'unpinned';
          warnings.push(`${repository}: cannot resolve ${branch} (${error.message}) and no earlier commit is known; its readers use the branch`);
        }
      }
    }
    repositories[key] = { branch, commit, variable, source };
  }
  // Which CN tables the previous run read is this run's to settle again (cn-tables.mjs), and
  // no stage may read them before it has: the record is kept only as where they last came
  // from, which that stage falls back to when the primary mirror's pinned commit is unusable.
  const last = cnTablesRecord(previous?.cnTables) ?? cnTablesRecord(previous?.lastCnTables);
  return { lock: { version: 1, repositories, ...(last ? { lastCnTables: last } : {}) }, warnings };
}

const run = promisify(execFile);
/** The branch head, from git itself: no API token, no rate limit. */
export async function lsRemote(repository, branch) {
  const { stdout } = await run('git', ['ls-remote', '--exit-code', `https://github.com/${repository}.git`, `refs/heads/${branch}`],
    { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.split(/\s/)[0];
}

/**
 * What a script of the refresh reads a mirror at: the commit pinned for this run, which
 * run-stage.mjs passes to every stage, else the mirror's branch, as before pinning. Only the
 * environment, never the lock: run by hand, a reader wants today's branch, not the commit
 * of the release it was hydrated from. A test holds every stage's scripts to this.
 */
export function pinnedRef(repository, env = process.env, branch = null) {
  const mirror = MIRRORS.find(entry => entry.repository === repository && (!branch || entry.branch === branch));
  if (!mirror) throw new Error(`Not a pinned mirror: ${repository}`);
  const commit = String(env[pinVariable(mirror.key ?? repository)] ?? '');
  return sha.test(commit) ? commit : mirror.branch;
}

/** For readers that record the commit they read: the pin, else the branch head as
 * `head(repository, branch)` resolves it -- so a pinned run makes no API call for it. */
export async function pinnedCommit(repository, head, env = process.env) {
  const ref = pinnedRef(repository, env);
  return sha.test(ref) ? ref : head(repository, ref);
}

/**
 * The CN tables this run reads: the ones the upstream-cn stage settled on, which run-stage.mjs
 * passes to every later stage, else -- a script run by hand -- the primary mirror at its pin,
 * else its branch, as before. {repository, commit (null for a branch), ref, folder}, where
 * folder holds excel/ and levels/. A value that is set but names no source is a mistake in
 * the refresh, and fails loudly rather than reading another mirror than the rest of the run.
 */
export function cnTables(env = process.env) {
  const given = env[CN_TABLES_VARIABLE];
  if (given) {
    let parsed = null;
    try { parsed = JSON.parse(given); } catch { /* reported below */ }
    const tables = cnTablesRecord(parsed);
    if (!tables) throw new Error(`${CN_TABLES_VARIABLE} does not name one of the CN table sources at a commit: ${given}`);
    return { ...tables, ref: tables.commit };
  }
  const [primary] = CN_TABLE_SOURCES;
  const ref = pinnedRef(primary.repository, env);
  return { repository: primary.repository, commit: sha.test(ref) ? ref : null, ref, folder: primary.folder, serialization: null };
}

/** https://raw.githubusercontent.com/<CN tables mirror>/<its commit>/<its folder>/<file>, for a
 * file under gamedata/: cnTableUrl('excel/charword_table.json'). */
export function cnTableUrl(file, env = process.env) {
  const { repository, ref, folder } = cnTables(env);
  return `https://raw.githubusercontent.com/${repository}/${ref}/${folder}/${file}`;
}

/** https://raw.githubusercontent.com/<repo>/<pinned commit, else branch>/<path> */
export function rawUrl(root, repository, file, env = process.env) {
  const mirror = MIRRORS.find(entry => entry.repository === repository);
  if (!mirror) throw new Error(`Not a pinned mirror: ${repository}`);
  const commit = env[pinVariable(repository)] || readLock(root)?.repositories?.[repository]?.commit;
  return `https://raw.githubusercontent.com/${repository}/${sha.test(commit ?? '') ? commit : mirror.branch}/${file}`;
}

async function main(argv) {
  const root = process.cwd();
  if (argv[0] === 'raw-url') {
    if (argv.length !== 3) throw new Error('usage: pin-upstream.mjs raw-url <owner/repo> <path>');
    console.log(rawUrl(root, argv[1], argv[2]));
    return;
  }
  if (argv[0] === 'cn-table-url') {
    if (argv.length !== 2) throw new Error('usage: pin-upstream.mjs cn-table-url <file under gamedata/, e.g. excel/item_table.json>');
    console.log(cnTableUrl(argv[1]));
    return;
  }
  const { lock, warnings } = await pinUpstream({ previous: readLock(root), resolve: lsRemote, env: process.env });
  const file = path.join(root, LOCK);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const warning of warnings) console.log(actions ? `::warning title=Upstream mirror not pinned::${warning}` : `warning: ${warning}`);
  for (const [repository, { commit, source }] of Object.entries(lock.repositories)) {
    console.log(`  ${repository} at ${commit ? commit.slice(0, 12) : '(branch)'} (${source})`);
  }
  // Deliberately not exported to later workflow steps: none of them reads a mirror, and
  // npm test runs in one, where a pin in the environment would change what a test of a
  // reader's branch fallback sees. The lock file is the record; pinEnvironment reads it.
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
