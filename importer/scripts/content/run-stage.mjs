#!/usr/bin/env node
/**
 * Runs one step of a content refresh so that its failure costs only its own outputs.
 *
 *   node scripts/content/run-stage.mjs begin
 *   node scripts/content/run-stage.mjs run <name> [--needs a,b] [--invariant] [--output <path>]...
 *                                      [--keep <path>]... [--timeout-minutes <n>] -- <command> [args...]
 *   node scripts/content/run-stage.mjs end [--strict]
 *
 * Before a stage starts, everything under data/ and public/ is mirrored into
 * .cache/stage-snapshot, copying only what changed since the previous stage. When the
 * command fails or times out, every file it changed there is put back and every file it
 * created is removed, so the next stage sees the tree as it was. That covers whatever a
 * script writes, declared or not. A stage whose --needs failed, was skipped or was rolled
 * back does not run.
 *
 * A stage that exits 0 but leaves an image under public/ that no asset repository
 * publishes (data/assets/external-asset-index.json) is failed the same way. Art reaches
 * readers only through those repositories, and check:assets, which the release runs,
 * refuses such a file: one importer saving a download there would block every record of
 * the day, where failing its stage costs only that stage's output.
 *
 * After a stage succeeds, the runner keeps what it changed and the bytes it replaced (the
 * run's ledger), so a later failure can take it back too. That is what --output is for:
 *
 *   --output <path>   A file or directory the stage writes. Outside data/ and public/ (a
 *                     download in $RUNNER_TEMP) it is saved before the stage and put back if
 *                     the stage fails. Under data/ or public/ it says the stage FINISHES IN
 *                     PLACE what an earlier stage it --needs wrote there: the stage build
 *                     writes public/stages-index.json raw and the enrichment rewrites it. A
 *                     half-made file like that cannot go back to what the earlier stage left,
 *                     so when this stage fails or is skipped, the earlier stage is rolled back
 *                     with every stage that ran on its output. Each file they changed gets its
 *                     bytes from before them again (unless a stage outside the rollback changed
 *                     it since, which the log names), and the stages still to come that need
 *                     them are skipped. The dataset and all that is derived from it stay as last
 *                     published, together. Declare it only where the earlier output is not
 *                     publishable without this stage.
 *   --keep <path>     What the stage changed under this path survives its failure: the
 *                     completeness gate's quarantine holds, which are true whether or not one
 *                     of its invariants stops the release.
 *
 * Each result lands in data/stage-report.json (stage, status -- ok, failed, skipped or
 * rolled-back -- duration, the tail of the output on failure). `run` exits non-zero only
 * when an --invariant stage fails, is skipped or is rolled back, which is what stops a
 * release; every other failure is reported and the refresh carries on. `end` prints the
 * summary, keeps one quarantine entry per stage that did not run to the end (stage
 * 'refresh', key stage:<name>, in data/quarantine.json, so how long a stage has been
 * failing survives the run and the daily issue can call it overdue) and drops the entry of
 * a stage the refresh no longer declares (STAGE_DEFINITIONS), and with --strict (a refresh
 * run by hand) fails if any stage did not.
 *
 * Every stage gets the mirror commits pinned in data/upstream.lock.json as environment
 * variables (see pin-upstream.mjs), and, once the upstream-cn stage has settled them, the
 * mirror and commit of the CN tables (cn-tables.mjs), so no two stages of one run read
 * different versions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pinEnvironment } from './pin-upstream.mjs';
import { beginStage, defaultNow, QUARANTINE_FILE, readQuarantine } from '../lib/quarantine.mjs';

export const REPORT = 'data/stage-report.json';
const SNAPSHOT = '.cache/stage-snapshot';
const TRACKED = ['data', 'public'];
/** The quarantine stage the runner owns: one entry per refresh stage that did not run to the end. */
export const HOLDER = 'refresh';
// The runner's own record of the run is the one file a restore must never touch.
const UNTRACKED = new Set([REPORT]);
const DEFAULT_TIMEOUT_MINUTES = 15;
const CREDENTIALS = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*-----|$)|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g;

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
};
const inActions = () => process.env.GITHUB_ACTIONS === 'true';
// Workflow commands take one line; %, CR and LF have to be escaped to survive.
const annotation = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/* ---- snapshot ------------------------------------------------------------------ */

/** Every file and directory under data/ and public/, with what tells a rewrite apart. */
function scan(root) {
  const files = {}, dirs = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    dirs.push(dir);
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && !UNTRACKED.has(rel)) {
        const stat = fs.statSync(path.join(root, rel));
        files[rel] = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
      }
    }
  };
  for (const dir of TRACKED) walk(dir);
  return { files, dirs };
}
const same = (a, b) => a && b && a.every((value, i) => value === b[i]);
// A clone on filesystems that support it (APFS, btrfs), an ordinary copy elsewhere.
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
};
const move = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
};
/** A path given on the command line, as the tree-relative form scan() uses. */
const relative = (root, file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
const inTree = rel => TRACKED.some(dir => rel === dir || rel.startsWith(`${dir}/`));
const under = (rel, paths) => paths.some(at => rel === at || rel.startsWith(`${at}/`));

/*
 * The ledger (.cache/stage-snapshot/ledger.json): for every stage that succeeded, in run
 * order, what it changed -- {path: null} for a file it created, {path: mtime} for one it
 * rewrote or deleted, whose previous bytes wait in history/<seq>/<path> -- and the
 * directories it created or removed. Taking the replaced copy out of the mirror is a
 * rename, so keeping every version costs nothing the mirror did not already copy.
 */
const readLedger = base => fs.existsSync(path.join(base, 'ledger.json')) ? readJson(path.join(base, 'ledger.json')) : { next: 0, entries: [] };

/** Bring the mirror up to date with the tree, copying only files that changed. With `by`
 * (the stage that just succeeded), what changed is its own, and goes into the ledger. */
export function syncSnapshot(root, by = null) {
  const base = path.join(root, SNAPSHOT);
  const indexFile = path.join(base, 'index.json');
  const previous = fs.existsSync(indexFile) ? readJson(indexFile) : null;
  const saved = previous ?? { files: {}, dirs: [] };
  const current = scan(root);
  // Nothing is anyone's before the first mirror exists: that is the tree the run started from.
  const ledger = by && previous ? readLedger(base) : null;
  const seq = ledger?.next;
  const changes = {};
  const keepReplaced = rel => move(path.join(base, 'files', rel), path.join(base, 'history', String(seq), rel));
  for (const [rel, stat] of Object.entries(current.files)) {
    const before = saved.files[rel];
    if (same(before, stat)) continue;
    if (ledger) {
      changes[rel] = before ? before[1] : null;
      if (before) keepReplaced(rel);
    }
    copy(path.join(root, rel), path.join(base, 'files', rel));
  }
  for (const [rel, stat] of Object.entries(saved.files)) {
    if (current.files[rel]) continue;
    if (ledger) { changes[rel] = stat[1]; keepReplaced(rel); } else fs.rmSync(path.join(base, 'files', rel), { force: true });
  }
  if (ledger) {
    const had = new Set(saved.dirs), has = new Set(current.dirs);
    const dirsCreated = current.dirs.filter(dir => !had.has(dir)), dirsRemoved = saved.dirs.filter(dir => !has.has(dir));
    if (Object.keys(changes).length || dirsCreated.length || dirsRemoved.length) {
      ledger.entries.push({ seq, stage: by, changes, dirsCreated, dirsRemoved });
      ledger.next = seq + 1;
      writeJson(path.join(base, 'ledger.json'), ledger);
    }
  }
  writeJson(indexFile, current);
  return current;
}

/** Put data/ and public/ back as the last sync saw them, except under `keep`; returns what
 * had changed. */
export function restoreSnapshot(root, keep = []) {
  const base = path.join(root, SNAPSHOT);
  const saved = readJson(path.join(base, 'index.json'));
  const current = scan(root);
  const changed = [];
  for (const rel of Object.keys(current.files)) {
    if (!saved.files[rel] && !under(rel, keep)) { fs.rmSync(path.join(root, rel), { force: true }); changed.push(rel); }
  }
  for (const [rel, stat] of Object.entries(saved.files)) {
    if (same(current.files[rel], stat) || under(rel, keep)) continue;
    copy(path.join(base, 'files', rel), path.join(root, rel));
    // Back to its own modification time, for any tool that compares them.
    fs.utimesSync(path.join(root, rel), new Date(), new Date(stat[1]));
    changed.push(rel);
  }
  // Directories the stage created, deepest first; they hold only files it created.
  const known = new Set(saved.dirs);
  for (const dir of current.dirs.filter(dir => !known.has(dir)).sort((a, b) => b.length - a.length)) {
    if (keep.some(at => under(at, [dir]))) continue;
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    changed.push(`${dir}/`);
  }
  for (const dir of saved.dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  // The restored copies carry new timestamps; record them so the next sync skips them.
  syncSnapshot(root);
  return changed.sort();
}

/** Take the named stages' changes back out of the tree: every file they changed returns to
 * its bytes from before the first of them changed it. A file a stage outside the set changed
 * afterwards is left as it is, since putting it back would undo that stage too. */
export function rollBack(root, stages) {
  const base = path.join(root, SNAPSHOT);
  const ledger = readLedger(base);
  const members = ledger.entries.filter(entry => stages.has(entry.stage));
  const restored = [], kept = [], seen = new Set();
  for (const entry of members) {
    for (const [rel, mtime] of Object.entries(entry.changes)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const since = ledger.entries.find(other => other.seq > entry.seq && !stages.has(other.stage) && rel in other.changes);
      if (since) { kept.push(`${rel} (changed since by ${since.stage})`); continue; }
      const at = path.join(root, rel);
      if (mtime === null) fs.rmSync(at, { force: true });
      else {
        copy(path.join(base, 'history', String(entry.seq), rel), at);
        fs.utimesSync(at, new Date(), new Date(mtime));
      }
      restored.push(rel);
    }
  }
  for (const dir of members.flatMap(entry => entry.dirsCreated).sort((a, b) => b.length - a.length)) {
    // Only an empty one: whatever is left in it belongs to a stage outside the rollback.
    try { fs.rmdirSync(path.join(root, dir)); restored.push(`${dir}/`); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    }
  }
  for (const dir of members.flatMap(entry => entry.dirsRemoved)) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const entry of members) fs.rmSync(path.join(base, 'history', String(entry.seq)), { recursive: true, force: true });
  writeJson(path.join(base, 'ledger.json'), { ...ledger, entries: ledger.entries.filter(entry => !stages.has(entry.stage)) });
  syncSnapshot(root);
  return { restored: restored.sort(), kept };
}

/** Images the stage created or rewrote under public/ that no asset repository publishes,
 * against the mirror taken before it ran. The same test as check-external-assets.cjs. */
const MEDIA = /\.(webp|png|jpe?g|gif|svg|avif|ico)$/i;
function unpublishedMedia(root) {
  const saved = readJson(path.join(root, SNAPSHOT, 'index.json'));
  const indexFile = path.join(root, 'data/assets/external-asset-index.json');
  const published = new Set(fs.existsSync(indexFile) ? readJson(indexFile).files ?? [] : []);
  return Object.entries(scan(root).files)
    .filter(([rel, stat]) => rel.startsWith('public/') && MEDIA.test(rel) && !same(saved.files[rel], stat) && !published.has(rel.slice('public/'.length)))
    .map(([rel]) => rel).sort();
}

/** --output paths outside data/ and public/ are saved whole, for this stage only. */
function saveOutputs(root, outputs) {
  const base = path.join(root, SNAPSHOT, 'outputs');
  fs.rmSync(base, { recursive: true, force: true });
  return outputs.map((output, i) => {
    const at = path.resolve(root, output), copyAt = path.join(base, String(i));
    const existed = fs.existsSync(at);
    if (existed) fs.cpSync(at, copyAt, { recursive: true });
    return { at, copyAt, existed };
  });
}
function restoreOutputs(saved) {
  for (const { at, copyAt, existed } of saved) {
    fs.rmSync(at, { recursive: true, force: true });
    if (existed) fs.cpSync(copyAt, at, { recursive: true });
  }
}

/* ---- report -------------------------------------------------------------------- */

export function beginRun(root, now = new Date()) {
  fs.rmSync(path.join(root, SNAPSHOT), { recursive: true, force: true });
  writeJson(path.join(root, REPORT), { version: 1, startedAt: now.toISOString(), stages: [] });
}
function readReport(root) {
  const file = path.join(root, REPORT);
  if (fs.existsSync(file)) return readJson(file);
  // A stage run on its own, outside any begin: start a report rather than refuse.
  beginRun(root);
  return readJson(file);
}
function record(root, entry) {
  const report = readReport(root);
  report.stages.push(entry);
  writeJson(path.join(root, REPORT), report);
}
const HOW = { failed: 'failed', skipped: 'was skipped', 'rolled-back': 'was rolled back' };
/*
 * The reason a stage's quarantine entry carries (recordStageHolds), kept on its report entry as
 * `hold`. It names the kind of problem and the stages involved, never how that day went: the
 * exit code, the signal, the time limit and the error text differ from one day of an outage to
 * the next (a server answers 502, then times out, then refuses the connection), and
 * data/quarantine.json is published, so each of those would be a new release with no content
 * change. They stay in the log and in the stage report, which is not published (.gitignore, and
 * validate-release.mjs refuses it). For the same reason a timeout is not told apart from any
 * other failure here, and a stage skipped or rolled back names the stage it waited on, not
 * what became of that stage.
 */
const HOLD = {
  failed: () => 'failed or timed out; the run\'s stage report says how',
  skipped: need => `skipped: needs ${need}, which did not run to the end`,
  rolledBack: (name, heads) => `rolled back: ${name} did not finish in place what ${heads.join(', ')} wrote`,
};

/* ---- run ----------------------------------------------------------------------- */

export function parseRunArgs(args) {
  const split = args.indexOf('--');
  if (split < 1 || split === args.length - 1) throw new Error('usage: run <name> [options] -- <command> [args...]');
  const [name, ...options] = args.slice(0, split);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid stage name: ${name}`);
  const parsed = { name, needs: [], outputs: [], keep: [], invariant: false, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, command: args.slice(split + 1) };
  for (let i = 0; i < options.length; i++) {
    const option = options[i], value = options[i + 1];
    if (option === '--invariant') parsed.invariant = true;
    else if (option === '--needs' && value) { parsed.needs.push(...value.split(',').filter(Boolean)); i++; }
    else if (option === '--output' && value) { parsed.outputs.push(value); i++; }
    else if (option === '--keep' && value) { parsed.keep.push(value); i++; }
    else if (option === '--timeout-minutes' && Number(value) > 0) { parsed.timeoutMinutes = Number(value); i++; }
    else throw new Error(`Unknown or incomplete option for stage ${name}: ${option}`);
  }
  return parsed;
}

/** Why a stage must not run, from what the stages it needs did earlier in this run: the first
 * such need, and what became of it. */
function blockedBy(report, needs) {
  for (const need of needs) {
    const result = report.stages.findLast(entry => entry.stage === need);
    if (!result) return { need, reason: `needs ${need}, which has not run` };
    if (result.status !== 'ok') return { need, reason: `needs ${need}, which ${HOW[result.status] ?? result.status}` };
  }
  return null;
}

/* What the output of a failed stage says went wrong, in one line, for the job summary and
 * the daily issue: its last line that is not a stack frame, an inspected property, a bracket
 * or Node's closing version banner. A Node crash ends with "Node.js v22.x", so the last line
 * alone named the runtime instead of the cause (a refused connection, a 404, a bad row). */
const NOISE = [/^Node\.js v\d/, /^\s*at\s/, /^\s*\.\.\. \d+ lines? matching/, /^[\s{}()[\],^]*$/, /^\s+[\w$]+: (?!.*Error)/];
export function failureLine(error) {
  const lines = String(error ?? '').split('\n').filter(line => line.trim());
  return (lines.findLast(line => !NOISE.some(noise => noise.test(line))) ?? lines.at(-1) ?? '').trim();
}

function excerpt(lines) {
  const text = lines.join('').replace(CREDENTIALS, '[redacted]');
  // A progress meter redraws its line with carriage returns: keep what a terminal shows.
  const tail = text.split('\n').map(line => line.split('\r').at(-1).trimEnd()).filter(Boolean).slice(-15).join('\n');
  return tail.length > 2000 ? `…${tail.slice(-2000)}` : tail;
}

/** Run the command in its own process group, echoing its output and keeping the tail. */
function execute(command, env, timeoutMinutes) {
  return new Promise(resolve => {
    const tail = [];
    const keep = chunk => { tail.push(chunk.toString()); if (tail.length > 200) tail.splice(0, tail.length - 200); };
    const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', chunk => { process.stdout.write(chunk); keep(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); keep(chunk); });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
    let timedOut = false, interrupted = null, hardKill, done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), 10_000);
    }, timeoutMinutes * 60_000);
    // A cancelled job must not leave the stage running on its own.
    const forward = signal => { interrupted = signal; kill(signal); };
    process.on('SIGINT', forward).on('SIGTERM', forward);
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hardKill);
      process.off('SIGINT', forward).off('SIGTERM', forward);
      resolve({ code, signal, timedOut, interrupted, output: tail });
    };
    // A command that cannot start at all (not installed, not executable) never closes.
    child.on('error', error => { keep(`${error.message}\n`); if (child.pid === undefined) finish(null, null); });
    child.on('close', finish);
  });
}

/*
 * When a stage that declared --output paths under data/ or public/ fails or is skipped:
 * the stages it needs (directly or through others) that already changed a file there
 * wrote it for this stage to finish, so they are rolled back, with every stage that ran on
 * their output. Returns the stages rolled back, or null when no declared path was touched.
 */
function rollBackUnfinished(root, { name, needs, outputs }, why) {
  const declared = outputs.map(output => relative(root, output)).filter(inTree);
  if (!declared.length) return null;
  const report = readReport(root);
  const needsOf = new Map(report.stages.map(entry => [entry.stage, entry.needs ?? []]));
  const upstream = new Set(), queue = [...needs];
  while (queue.length) {
    const need = queue.pop();
    if (upstream.has(need)) continue;
    upstream.add(need);
    queue.push(...(needsOf.get(need) ?? []));
  }
  const { entries } = readLedger(path.join(root, SNAPSHOT));
  const heads = entries.filter(entry => upstream.has(entry.stage) && Object.keys(entry.changes).some(rel => under(rel, declared))).map(entry => entry.stage);
  if (!heads.length) return null;
  // The report is in run order, so one pass collects what ran on a head, and on that.
  const stages = new Set(heads);
  for (const entry of report.stages) if (entry.status === 'ok' && (entry.needs ?? []).some(need => stages.has(need))) stages.add(entry.stage);
  const { restored, kept } = rollBack(root, stages);
  const reason = `rolled back: ${name} ${why} before finishing in place what ${[...new Set(heads)].join(', ')} wrote`;
  const hold = HOLD.rolledBack(name, [...new Set(heads)]);
  for (const entry of report.stages) {
    if (!stages.has(entry.stage) || entry.status !== 'ok') continue;
    entry.status = 'rolled-back';
    entry.reason = reason;
    entry.hold = hold;
  }
  writeJson(path.join(root, REPORT), report);
  const invariant = report.stages.some(entry => stages.has(entry.stage) && entry.invariant);
  const summary = `${name} ${why}, so ${[...stages].join(', ')} ${stages.size === 1 ? 'was' : 'were'} rolled back: ${restored.length} file(s) under data/ and public/ as they were before them`
    + (kept.length ? `; kept, as a later stage changed them: ${kept.join(', ')}` : '');
  console.log(inActions() ? `::warning title=Stages rolled back::${annotation(summary)}` : `\n== ${summary}`);
  return { stages: [...stages], restored: restored.length, invariant };
}

export async function runStage(root, options) {
  const { name, needs, outputs, keep, invariant, timeoutMinutes, command } = options;
  const report = readReport(root);
  if (report.stages.some(entry => entry.stage === name)) throw new Error(`Stage ${name} already ran in this run`);
  const kept = keep.map(file => relative(root, file));
  for (const file of kept) if (!inTree(file)) throw new Error(`--keep takes a path under data/ or public/, not ${file}`);
  const facts = { stage: name, ...(invariant ? { invariant } : {}), ...(needs.length ? { needs } : {}) };
  const blocked = blockedBy(report, needs);
  if (blocked) {
    const { reason } = blocked;
    record(root, { ...facts, status: 'skipped', reason, hold: HOLD.skipped(blocked.need), durationMs: 0 });
    console.log(inActions() ? `::warning title=Stage ${name} skipped::${annotation(reason)}` : `\n== ${name}: skipped (${reason})`);
    const rolled = rollBackUnfinished(root, options, 'was skipped');
    return { status: 'skipped', exitCode: invariant || rolled?.invariant ? 1 : 0 };
  }
  console.log(inActions() ? `::group::${name}` : `\n\u001b[1m== ${name}\u001b[0m`);
  syncSnapshot(root);
  const savedOutputs = saveOutputs(root, outputs.filter(output => !inTree(relative(root, output))));
  const env = { ...process.env, ...pinEnvironment(root, process.env), PYTHONUNBUFFERED: '1' };
  const started = Date.now();
  const result = await execute(command, env, timeoutMinutes);
  const durationMs = Date.now() - started;
  const unpublished = result.code === 0 ? unpublishedMedia(root) : [];
  if (result.code === 0 && !unpublished.length) {
    if (inActions()) console.log('::endgroup::');
    // What it changed is now its own, for a later stage that cannot finish it to take back.
    syncSnapshot(root, name);
    record(root, { ...facts, status: 'ok', durationMs });
    return { status: 'ok', exitCode: 0 };
  }
  const restored = restoreSnapshot(root, kept);
  restoreOutputs(savedOutputs);
  const how = unpublished.length ? 'wrote unpublished media under public/'
    : result.interrupted ? `interrupted by ${result.interrupted}` : result.timedOut ? `timed out after ${timeoutMinutes} min`
    : result.signal ? `killed by ${result.signal}` : result.code === null ? 'could not start' : `exited ${result.code}`;
  const error = unpublished.length
    ? [excerpt(result.output), `Only the asset repositories publish media, and check:assets refuses these: ${unpublished.slice(0, 10).join(', ')}${unpublished.length > 10 ? ` and ${unpublished.length - 10} more` : ''}; stage them outside public/ and report them.`].filter(Boolean).join('\n')
    : excerpt(result.output) || how;
  if (inActions()) console.log('::endgroup::');
  record(root, { ...facts, status: 'failed', durationMs, exit: how, error, hold: HOLD.failed(), command: command.join(' '), restored: restored.length });
  const summary = `${how}; ${restored.length} file(s) under data/ and public/ restored${kept.length ? ` (what it wrote to ${kept.join(', ')} is kept)` : ''}${invariant ? '. This stage is an invariant, so the run fails.' : ', stages that need it are skipped, the rest continue.'}`;
  console.log(inActions() ? `::error title=Stage ${name} failed::${annotation(`${summary}\n${error}`)}` : `\n== ${name}: FAILED (${summary})`);
  // A cancelled job stops here too, instead of starting the next stage (or rolling back).
  if (result.interrupted) return { status: 'failed', exitCode: result.interrupted === 'SIGINT' ? 130 : 143 };
  const rolled = rollBackUnfinished(root, options, 'failed');
  return { status: 'failed', exitCode: invariant || rolled?.invariant ? 1 : 0 };
}

/* ---- end ----------------------------------------------------------------------- */

export function summarize(root, { strict = false } = {}) {
  const file = path.join(root, REPORT);
  if (!fs.existsSync(file)) return { lines: ['No stage report.'], exitCode: strict ? 1 : 0 };
  const { stages } = readJson(file);
  const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
  const lines = stages.map(entry => `${entry.status.padEnd(7)} ${entry.stage}${entry.invariant ? ' (invariant)' : ''} ${seconds(entry.durationMs)}`
    + (entry.status === 'failed' ? ` -- ${entry.exit}: ${failureLine(entry.error)}` : entry.reason ? ` -- ${entry.reason}` : ''));
  const failedInvariant = stages.some(entry => entry.invariant && entry.status !== 'ok');
  const failed = stages.some(entry => entry.status !== 'ok');
  return { lines, stages, exitCode: failedInvariant || (strict && failed) ? 1 : 0 };
}

/*
 * The files that declare the refresh's stages, one `stage <name> ...` line each: the daily
 * workflow's refresh step and the stage-data script it calls (which `npm run stages:refresh`
 * runs alone, by hand). A test holds every file that runs stages to this list.
 */
// In arkpedia-data's importer the steps are its own (run-imports.sh), not the application's workflow.
export const STAGE_DEFINITIONS = ['scripts/content/run-imports.sh', 'scripts/sync/refresh-stage-data.sh'];
/** Every stage name the refresh declares, or null in a tree without the definitions (then
 * nothing is taken for gone). */
export function declaredStages(root) {
  const names = new Set();
  for (const file of STAGE_DEFINITIONS) {
    if (!fs.existsSync(path.join(root, file))) return null;
    for (const [, name] of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/^\s*stage ([a-z0-9][a-z0-9-]*)\s/gm)) names.add(name);
  }
  return names;
}

/*
 * One quarantine entry (stage 'refresh', key stage:<name>, kept-previous) for every stage of
 * this run that did not run to the end, so its firstSeen carries over from run to run and
 * the daily issue can say how long it has been failing. A stage that ran to the end drops
 * its entry; one this run did not include (a refresh of the stage data alone, or a run an
 * invariant stopped early) keeps it -- unless the refresh no longer declares it: a stage
 * renamed or dropped while failing would otherwise stay in the published file, and reopen
 * the daily issue, for good.
 * The reason (HOLD, kept on the report entry as `hold`) stays the same from day to day on
 * purpose: the file is published, and the day's exit and error text are in the stage report
 * and the issue. A clean run in a tree with no quarantine file (a local refresh) does not
 * start one.
 */
export function recordStageHolds(root, stages, now = defaultNow()) {
  if (!fs.existsSync(path.join(root, QUARANTINE_FILE)) && stages.every(entry => entry.status === 'ok')) return [];
  const holds = beginStage(root, HOLDER, now);
  const ran = new Set(stages.map(entry => `stage:${entry.stage}`)), declared = declaredStages(root);
  for (const entry of readQuarantine(root).entries) {
    if (entry.stage !== HOLDER || ran.has(entry.key)) continue;
    if (declared && !declared.has(entry.key.replace(/^stage:/, ''))) continue;
    holds.add({ key: entry.key, action: entry.action, reason: entry.reason });
  }
  for (const entry of stages) {
    if (entry.status === 'ok') continue;
    holds.add({ key: `stage:${entry.stage}`, action: 'kept-previous', reason: entry.hold ?? entry.status });
  }
  return holds.commit();
}

function writeStepSummary(stages) {
  if (!process.env.GITHUB_STEP_SUMMARY || !stages?.length) return;
  const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  const rows = stages.map(entry => `| \`${entry.stage}\`${entry.invariant ? ' (invariant)' : ''} | ${entry.status} | ${(entry.durationMs / 1000).toFixed(1)}s | ${cell(entry.status === 'failed' ? `${entry.exit}: ${failureLine(entry.error)}` : entry.reason)} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Refresh stages', '', '| Stage | Status | Time | Detail |', '|---|---|---|---|', ...rows, ''].join('\n') + '\n');
}

async function main(argv) {
  const root = process.cwd();
  const [command, ...args] = argv;
  if (command === 'begin') { beginRun(root); return 0; }
  if (command === 'end') {
    const { lines, stages, exitCode } = summarize(root, { strict: args.includes('--strict') });
    console.log(`\nStages (${REPORT}):\n${lines.map(line => `  ${line}`).join('\n')}`);
    writeStepSummary(stages);
    fs.rmSync(path.join(root, SNAPSHOT), { recursive: true, force: true });
    // A convenience for the daily issue: it must never be what fails the run.
    if (stages) {
      try { recordStageHolds(root, stages); } catch (error) { console.warn(`Could not record the stages that did not run to the end in data/quarantine.json: ${error.message}`); }
    }
    return exitCode;
  }
  if (command === 'run') return (await runStage(root, parseRunArgs(args))).exitCode;
  throw new Error('usage: run-stage.mjs begin | run <name> [options] -- <command> | end [--strict]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    // A usage error is a mistake in the refresh itself: fail loudly, not as a skipped stage.
    process.exitCode = 2;
  });
}
