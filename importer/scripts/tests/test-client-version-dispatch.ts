import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { dispatchPlan, MIN_HOURS_BETWEEN, RETRY_HOURS, run } from '../content/client-version-dispatch.mjs';

const CONFIGS: Record<string, string> = {
  en: 'https://ak-conf.arknights.global/config/prod/official/network_config',
  jp: 'https://ak-conf.arknights.jp/config/prod/official/network_config',
  kr: 'https://ak-conf.arknights.kr/config/prod/official/network_config',
  cn: 'https://ak-conf.hypergryph.com/config/prod/official/network_config',
};
const config = (host: string) => ({ content: JSON.stringify({ funcVer: 'V1', configs: { V1: { network: {
  hv: `https://${host}/assetbundle/official/{0}/version`, hu: `https://${host}/assetbundle/official`, prean: `https://webview.${host}` } } } }) });
const HEADS: Record<string, string> = { 'ArknightsAssets/ArknightsGamedata': 'a'.repeat(40), 'yuanyan3060/ArknightsGameResource': 'b'.repeat(40) };
const MIRROR_URLS: Record<string, string> = {
  en: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${'a'.repeat(40)}/en/hot_update_list.json`,
  jp: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${'a'.repeat(40)}/jp/hot_update_list.json`,
  kr: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${'a'.repeat(40)}/kr/hot_update_list.json`,
  cn: `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/${'b'.repeat(40)}/version`,
};
const V = (region: string, v: string) => `${region}-${v}-xxxxxxxx`;
const ALL = (v: string) => ({ en: V('en', v), jp: V('jp', v), kr: V('kr', v), cn: V('cn', v) });
const publishedAt = (versions: Record<string, string>) => ({ version: 1, regions: Object.fromEntries(Object.entries(versions).map(([region, resVersion]) => [region, { resVersion, mirror: { repository: 'x', resVersion } }])) });
const NOW = new Date('2026-10-19T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

/** The game's servers on `live`, each mirror's head on `mirrors`: GETs only, the mirrors by their first bytes. */
function server({ live, mirrors = {}, down = [] as string[] }: { live: Record<string, string>; mirrors?: Record<string, string>; down?: string[] }, seen: Array<{ url: string; init: any }> = []) {
  return async (url: string, init?: any) => {
    seen.push({ url, init });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (down.includes(url)) return reply(503, {});
    for (const [region, configUrl] of Object.entries(CONFIGS)) {
      const host = `${region}.test`;
      if (url === configUrl) return reply(200, config(host));
      if (url === `https://${host}/assetbundle/official/Android/version`) return reply(200, { resVersion: live[region], clientVersion: '1.0.0' });
      if (url === MIRROR_URLS[region]) {
        assert.equal(init?.headers?.range, 'bytes=0-511', 'the mirror is read by its first bytes only');
        const version = mirrors[region] ?? live[region];
        return reply(206, region === 'cn' ? `${version}\n` : `{\n    "versionId": "${version}",\n    "abInfos": [`);
      }
    }
    return reply(404, {});
  };
}

/** The GitHub API: data's published client-versions.json (null: 404), and main's import runs. */
function github({ published, runs = [] as any[] }: { published: unknown; runs?: any[] }, routes: string[] = []) {
  return (route: string) => {
    routes.push(route);
    if (route.startsWith('repos/arkpedia/arkpedia-data/contents/source/data/client-versions.json')) {
      if (!published) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
      return { content: Buffer.from(JSON.stringify(published)).toString('base64') };
    }
    if (route.startsWith('repos/arkpedia/arkpedia-data/actions/workflows/import.yml/runs')) return { workflow_runs: runs };
    throw new Error(`unexpected route ${route}`);
  };
}

async function look({ live, mirrors, published, runs, state, dryRun = false, now = NOW }: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-dispatch-'));
  const file = path.join(dir, 'state.json');
  if (state) fs.writeFileSync(file, JSON.stringify(state));
  const started: string[][] = [], seen: Array<{ url: string; init: any }> = [], routes: string[] = [];
  const log = console.log, warn = console.warn;
  const lines: string[] = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = () => {};
  try {
    const plan = await run({ dryRun, state: file, now, fetcher: server({ live, mirrors }, seen), api: github({ published, runs }, routes),
      head: async (repository: string) => HEADS[repository], start: (args: string[]) => started.push(args) });
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { plan, started, saved, seen, routes, lines };
  } finally {
    console.log = log;
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a new client version the mirror already carries starts the import, and is remembered', async () => {
  const { plan, started, saved, seen, lines } = await look({ live: { ...ALL('v1'), jp: V('jp', 'v2') }, published: publishedAt(ALL('v1')) });
  assert.equal(plan.dispatch, true);
  assert.deepEqual(started, [['workflow', 'run', 'import.yml', '--repo', 'arkpedia/arkpedia-data', '--ref', 'main', '-f', 'reason=patch']]);
  assert.deepEqual(saved, { at: NOW.toISOString(), versions: { ...ALL('v1'), jp: V('jp', 'v2') } });
  assert.deepEqual(plan.regions.map((entry: any) => [entry.region, entry.status]), [['en', 'current'], ['jp', 'ready'], ['kr', 'current'], ['cn', 'current']]);
  assert.ok(seen.every(({ init }) => !init?.method || init.method === 'GET'), 'GET only');
  assert.ok(seen.every(({ init }) => init?.headers?.['user-agent']?.startsWith('ArkpediaBot/1.0')), 'every request names the site');
  assert.ok(lines.some(line => /^jp: ready/.test(line)) && lines.some(line => /^Dispatching: .*jp/.test(line)), 'the log says why');
});

test('CN is read from yuanyan\'s version file, the others from the file list\'s versionId', async () => {
  const { plan, seen } = await look({ live: { ...ALL('v1'), cn: V('cn', 'v2') }, published: publishedAt(ALL('v1')) });
  assert.equal(plan.dispatch, true);
  assert.ok(seen.some(({ url }) => url === MIRROR_URLS.cn) && seen.some(({ url }) => url === MIRROR_URLS.kr));
  assert.ok(!seen.some(({ url }) => /\/(?:master|main)\//.test(url)), 'each mirror at its head commit, not its branch name');
});

test('a mirror that does not carry the new version yet waits', async () => {
  const { plan, started, saved } = await look({ live: { ...ALL('v1'), en: V('en', 'v2') }, mirrors: { en: V('en', 'v1') }, published: publishedAt(ALL('v1')) });
  assert.equal(plan.dispatch, false);
  assert.match(plan.reason, /live in en, but the mirror does not carry it yet/);
  assert.deepEqual(started, []);
  assert.equal(saved, null);
});

test('the published tables count, not the live version the last run saw: a run before the mirror caught up still leaves the region ready', () => {
  const published = { version: 1, regions: { ...publishedAt(ALL('v1')).regions, en: { resVersion: V('en', 'v2'), mirror: { repository: 'x', resVersion: V('en', 'v1') } } } };
  const plan = dispatchPlan({ live: { ...ALL('v1'), en: V('en', 'v2') }, mirrors: { ...ALL('v1'), en: V('en', 'v2') }, published, busy: false, last: null, now: NOW });
  assert.equal(plan.dispatch, true);
  const quiet = dispatchPlan({ live: ALL('v1'), mirrors: ALL('v1'), published: publishedAt(ALL('v1')), busy: false, last: null, now: NOW });
  assert.equal(quiet.dispatch, false);
  assert.match(quiet.reason, /No region has a client version newer/);
});

test('a queued or running import blocks a dispatch, which would replace it', async () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const { plan, started } = await look({ live: { ...ALL('v1'), kr: V('kr', 'v2') }, published: publishedAt(ALL('v1')), runs: [{ id: 1, status }] });
    assert.equal(plan.dispatch, false, status);
    assert.match(plan.reason, /already queued or running/);
    assert.deepEqual(started, []);
  }
  const { plan } = await look({ live: { ...ALL('v1'), kr: V('kr', 'v2') }, published: publishedAt(ALL('v1')), runs: [{ id: 1, status: 'completed' }] });
  assert.equal(plan.dispatch, true, 'a finished run does not');
});

test(`at most one dispatch per ${MIN_HOURS_BETWEEN} hours, and none for the same versions within ${RETRY_HOURS}`, () => {
  const live = { ...ALL('v1'), kr: V('kr', 'v2') };
  const base = { live, mirrors: live, published: publishedAt(ALL('v1')), busy: false, now: NOW };
  assert.equal(dispatchPlan({ ...base, last: { at: hoursAgo(5), versions: ALL('v0') } }).dispatch, false);
  assert.match(dispatchPlan({ ...base, last: { at: hoursAgo(5), versions: ALL('v0') } }).reason, /5\.0 h ago \(at most one per 6 h\)/);
  assert.equal(dispatchPlan({ ...base, last: { at: hoursAgo(7), versions: ALL('v0') } }).dispatch, true, 'other versions after six hours');
  assert.equal(dispatchPlan({ ...base, last: { at: hoursAgo(7), versions: live } }).dispatch, false, 'the same versions are not retried');
  assert.equal(dispatchPlan({ ...base, last: { at: hoursAgo(25), versions: live } }).dispatch, true, 'until a day has passed');
});

test('a published release with no client-versions.json (main before the stage) dispatches nothing, and says so', async () => {
  const { plan, started, lines } = await look({ live: { ...ALL('v1'), en: V('en', 'v2') }, published: null });
  assert.equal(plan.dispatch, false);
  assert.match(plan.reason, /carries no client-versions\.json yet/);
  assert.deepEqual(started, []);
  assert.ok(lines.some(line => line.startsWith('Not dispatching: ')));
  const partial = dispatchPlan({ live: ALL('v2'), mirrors: ALL('v2'), published: { version: 1, regions: {} }, busy: false, last: null, now: NOW });
  assert.equal(partial.dispatch, false);
  assert.ok(partial.regions.every((entry: any) => entry.status === 'no-baseline'));
});

test('a dry run decides but starts and remembers nothing; an unreadable client is left out', async () => {
  const { plan, started, saved, lines } = await look({ live: { ...ALL('v1'), jp: V('jp', 'v2') }, published: publishedAt(ALL('v1')), dryRun: true });
  assert.equal(plan.dispatch, true);
  assert.deepEqual(started, []);
  assert.equal(saved, null);
  assert.ok(lines.some(line => line.startsWith('Would dispatch: ')));
  const unread = dispatchPlan({ live: { ...ALL('v1'), cn: null }, mirrors: ALL('v1'), published: publishedAt(ALL('v1')), busy: false, last: null, now: NOW });
  assert.deepEqual(unread.regions.find((entry: any) => entry.region === 'cn'), { region: 'cn', status: 'unread', detail: "the client's version could not be read" });
  assert.equal(unread.dispatch, false);
});

test('the workflow starts a real import only from main, on its schedule or when dispatched without dry_run', () => {
  // Run from importer/, as the importer's tests are.
  const text = fs.readFileSync('../.github/workflows/client-version-dispatch.yml', 'utf8');
  const expression = text.match(/DRY_RUN: \$\{\{ (.+) \}\}/)?.[1] ?? '';
  // The expression, evaluated for each way the workflow starts.
  const dryRun = (ref: string, event: string, input = false) => expression
    .replace(/github\.ref_name/g, JSON.stringify(ref)).replace(/github\.event_name/g, JSON.stringify(event)).replace(/inputs\.dry_run/g, String(input))
    .replace(/ && '--dry-run' \|\| ''$/, '');
  const evaluate = (ref: string, event: string, input?: boolean) => Function(`return (${dryRun(ref, event, input)})`)() as boolean;
  assert.equal(evaluate('main', 'schedule'), false);
  assert.equal(evaluate('main', 'workflow_dispatch', false), false);
  assert.equal(evaluate('main', 'workflow_dispatch', true), true);
  assert.equal(evaluate('main', 'push'), true, 'a push to the dispatcher only tries it');
  assert.equal(evaluate('dev', 'push'), true);
  assert.equal(evaluate('dev', 'workflow_dispatch', false), true, 'off main, always a dry run');
});
