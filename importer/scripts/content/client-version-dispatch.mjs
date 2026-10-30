#!/usr/bin/env node
/**
 * Starts the import soon after a game patch, instead of at the nightly run: every three hours
 * (.github/workflows/client-version-dispatch.yml) it asks each region's client which
 * version it is on (network_config's version file, scripts/lib/official-endpoints.mjs) and
 * compares that with the version the published release's tables were built from --
 * data/client-versions.json in arkpedia-data `main`, written by the client-versions stage
 * (scripts/sync/watch-client-versions.mjs): its `mirror.resVersion`, the version the mirror
 * carried at that run's pin.
 *
 * A region whose client is past the published tables is ready once the mirror its tables come
 * from carries the live version (MIRROR_VERSION: ArknightsAssets/ArknightsGamedata's file list
 * for en/jp/kr, yuanyan3060's `version` file for CN), read at the mirror's branch head (the
 * commit an import would pin) from the file's first bytes. A ready region dispatches import.yml
 * on main with reason=patch, unless:
 *   - an import is queued or running on main: a second dispatch would replace the queued one
 *     (GitHub keeps one pending run per concurrency group), and a running import reads the
 *     mirrors anyway;
 *   - this dispatcher started one less than MIN_HOURS_BETWEEN ago;
 *   - it already started one for these same versions less than RETRY_HOURS ago: an import that
 *     ran and still left the published versions behind failed, and the 'Import failing' issue and
 *     the application's 'Content release failing' issue report that; retrying every few hours
 *     would not help.
 * The import marks its commit on the imports branch "patch", and the application's content
 * watcher (arkpedia/arkpedia scripts/content/editorial-watch.mjs) compiles a marked import as soon
 * as it sees it, rather than at its nightly run. Moved here from the application with the import
 * (data split phase 4), so no token crosses between the repositories.
 * Its last dispatch (when, and for which versions) is the state file STATE, kept between runs
 * in the Actions cache by the workflow. Every run logs why it did or did not dispatch.
 *
 *   node scripts/content/client-version-dispatch.mjs [--dry-run] [--data-branch main] [--state FILE]
 *
 * GET only toward the game's servers and the mirrors, under the site's User-Agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getJson, OFFICIAL_USER_AGENT, REGIONS, regionNetwork } from '../lib/official-endpoints.mjs';
import { MIRROR_VERSION, mirrorResVersion } from '../sync/watch-client-versions.mjs';
import { lsRemote, MIRRORS } from './pin-upstream.mjs';

const DATA = 'arkpedia/arkpedia-data';
/** Whether any of these workflow runs is still queued or running. */
export const isBusy = runs => runs.some(run => run.status !== 'completed');
const PUBLISHED = 'source/data/client-versions.json';
export const MIN_HOURS_BETWEEN = 6;
export const RETRY_HOURS = 24;
export const STATE = '.cache/client-version-dispatch/state.json';
const HOUR = 3_600_000;

/** The version a published region's tables were built from: what its mirror carried at the pin. */
const tablesVersion = entry => entry?.mirror?.resVersion ?? entry?.resVersion ?? null;

/**
 * The decision, from what each step read:
 *   live:      { region: resVersion | null }          null when the client could not be read
 *   mirrors:   { region: resVersion | null }          the mirror's head, null when unread
 *   published: { regions: {...} } | null              data main's client-versions.json, null when absent
 *   busy:      whether an import is queued or running on the branch
 *   last:      { at: ISO time, versions: { region: resVersion } } | null, this dispatcher's last dispatch
 * Returns { dispatch, reason, regions: [{ region, status, detail }], versions } where versions is
 * the live set this dispatch is for.
 */
export function dispatchPlan({ live, mirrors, published, busy, last, now = new Date() }) {
  const regions = [];
  for (const region of REGIONS) {
    const version = live[region] ?? null;
    if (!version) { regions.push({ region, status: 'unread', detail: "the client's version could not be read" }); continue; }
    const entry = published?.regions?.[region];
    if (!entry) { regions.push({ region, status: 'no-baseline', detail: `live ${version}; the published release records no version for it` }); continue; }
    const built = tablesVersion(entry);
    if (built === version) { regions.push({ region, status: 'current', detail: `live ${version} = published tables` }); continue; }
    const mirror = mirrors[region] ?? null;
    if (mirror === version) regions.push({ region, status: 'ready', detail: `live ${version}, published tables ${built}, mirror has ${version}` });
    else regions.push({ region, status: 'mirror-behind', detail: `live ${version}, published tables ${built}, mirror ${mirror ?? 'unread'}` });
  }
  const ready = regions.filter(entry => entry.status === 'ready');
  const versions = Object.fromEntries(REGIONS.filter(region => live[region]).map(region => [region, live[region]]));
  const no = reason => ({ dispatch: false, reason, regions, versions });
  if (!published) return no('The published release carries no client-versions.json yet (its content run predates the client-versions stage): nothing to compare with.');
  if (!ready.length) {
    const waiting = regions.filter(entry => entry.status === 'mirror-behind').map(entry => entry.region);
    return no(waiting.length ? `A new client version is live in ${waiting.join(', ')}, but the mirror does not carry it yet.` : 'No region has a client version newer than the published tables.');
  }
  const names = ready.map(entry => entry.region).join(', ');
  if (busy) return no(`${names} ready, but an import is already queued or running: it would be replaced, or it reads the mirrors itself.`);
  const lastAt = Date.parse(last?.at ?? '');
  if (Number.isFinite(lastAt)) {
    const hours = (now.getTime() - lastAt) / HOUR;
    if (hours < MIN_HOURS_BETWEEN) return no(`${names} ready, but this dispatcher started an import ${hours.toFixed(1)} h ago (at most one per ${MIN_HOURS_BETWEEN} h).`);
    const same = ready.every(entry => last?.versions?.[entry.region] === live[entry.region]);
    if (same && hours < RETRY_HOURS) return no(`${names} ready, but an import was already started for these versions ${hours.toFixed(1)} h ago and the published release still lags: see that run rather than retrying before ${RETRY_HOURS} h.`);
  }
  return { dispatch: true, reason: `New client version with its tables in the mirror: ${names}. Starting the import.`, regions, versions };
}

export function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state.at === 'string' ? state : null;
  } catch {
    return null;
  }
}

async function liveVersions(fetcher) {
  const live = {};
  for (const region of REGIONS) {
    try {
      const network = await regionNetwork(region, fetcher);
      const version = String((await getJson(network.hv, fetcher))?.resVersion ?? '');
      live[region] = mirrorResVersion(version);
      if (!live[region]) throw new Error(`${network.hv} names no resVersion`);
    } catch (error) {
      console.warn(`${region}: ${error.message}`);
      live[region] = null;
    }
  }
  return live;
}

/** Each region's mirror at its branch head, from the first bytes of its version file. */
async function mirrorVersions(fetcher, head) {
  const mirrors = {}, heads = new Map();
  for (const region of REGIONS) {
    const { repository, file } = MIRROR_VERSION[region];
    try {
      if (!heads.has(repository)) heads.set(repository, head(repository, MIRRORS.find(entry => entry.repository === repository && !entry.key).branch));
      const commit = await heads.get(repository);
      const url = `https://raw.githubusercontent.com/${repository}/${commit}/${file}`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': OFFICIAL_USER_AGENT, range: 'bytes=0-511' } });
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status} for ${url}`);
      mirrors[region] = mirrorResVersion(await response.text());
    } catch (error) {
      console.warn(`${region}: the mirror's version could not be read: ${error.message}`);
      mirrors[region] = null;
    }
  }
  return mirrors;
}

const ghJson = route => JSON.parse(execFileSync('gh', ['api', route], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));

/** data/client-versions.json as `dataBranch` of arkpedia-data publishes it, or null when absent. */
function publishedVersions(dataBranch, api) {
  try {
    const file = api(`repos/${DATA}/contents/${PUBLISHED}?ref=${encodeURIComponent(dataBranch)}`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (error) {
    if (String(error.stderr ?? error.message).includes('HTTP 404')) return null;
    throw error;
  }
}

/**
 * One look. `dryRun` reads and decides but starts nothing and writes no state; the workflow
 * forces it anywhere but main, since only main's import reaches the live release.
 */
export async function run({ dryRun = false, dataBranch = 'main', branch = 'main', state = STATE, now = new Date(),
  fetcher = globalThis.fetch, api = ghJson, head = lsRemote, start = args => execFileSync('gh', args, { stdio: 'inherit' }) } = {}) {
  const [live, mirrors] = await Promise.all([liveVersions(fetcher), mirrorVersions(fetcher, head)]);
  const published = publishedVersions(dataBranch, api);
  const runs = api(`repos/${DATA}/actions/workflows/import.yml/runs?branch=${encodeURIComponent(branch)}&per_page=30`).workflow_runs ?? [];
  const plan = dispatchPlan({ live, mirrors, published, busy: isBusy(runs), last: readState(state), now });
  for (const entry of plan.regions) console.log(`${entry.region}: ${entry.status} (${entry.detail})`);
  console.log(`${plan.dispatch ? (dryRun ? 'Would dispatch' : 'Dispatching') : 'Not dispatching'}: ${plan.reason}`);
  if (plan.dispatch && !dryRun) {
    start(['workflow', 'run', 'import.yml', '--repo', DATA, '--ref', branch, '-f', 'reason=patch']);
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, `${JSON.stringify({ at: now.toISOString(), versions: plan.versions }, null, 1)}\n`);
    return { ...plan, started: true };
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  run({ dryRun: process.argv.includes('--dry-run'), dataBranch: value('--data-branch') ?? 'main', state: value('--state') ?? STATE })
    .then(plan => {
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (plan.started && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'dispatched=true\n');
      if (summary) fs.appendFileSync(summary, `### Client version dispatch\n\n${plan.regions.map(entry => `- **${entry.region}**: ${entry.status} (${entry.detail})`).join('\n')}\n\n${plan.reason}\n`);
    }, error => { console.error(error); process.exitCode = 1; });
}
