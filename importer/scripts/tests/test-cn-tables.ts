import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { ART, COMPOSED, LEAST_LEVELS, STAGE, TABLE_CHECKOUTS, candidates, checkTables, resolveTables, syncArt } from '../content/cn-tables.mjs';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { CN_TABLES_VARIABLE, CN_TABLE_SOURCES, MIRRORS, cnTableUrl, cnTables, pinEnvironment, pinUpstream, pinVariable } from '../content/pin-upstream.mjs';

const commit = (c: string) => c.repeat(40);
const KENGXXIAO = 'Kengxxiao/ArknightsGameData', YUANYAN = 'yuanyan3060/ArknightsGameResource';
const NOW = new Date('2026-09-24T20:00:00Z');

/* A whole CN dump as the contract counts it, under `gamedata` (excel/ and levels/): the records
   are empty, only how many there are matters. `enums` is how the mirror writes them. */
function writeDump(gamedata: string, { enums = 'named', levels = LEAST_LEVELS, without = [] as string[], short = [] as string[] } = {}) {
  const many = (count: number, make: (i: number) => unknown = () => ({})) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, make(i)]));
  const tables: Record<string, unknown> = {
    'activity_table.json': { basicInfo: many(150) },
    'battle_equip_table.json': many(250),
    'building_data.json': { chars: many(200), customData: { furnitures: many(1400) } },
    'campaign_table.json': { campaigns: many(18) },
    'char_patch_table.json': { patchChars: many(1) },
    'character_table.json': many(600, i => ({ name: `op ${i}`, rarity: enums === 'named' ? 'TIER_6' : 5 })),
    'charm_table.json': { charmList: Array.from({ length: 10 }, () => ({})) },
    'charword_table.json': { charWords: many(9000), voiceLangDict: many(200) },
    'crisis_v2_table.json': { seasonInfoDataMap: many(1) },
    'display_meta_table.json': { playerAvatarData: { avatarList: Array.from({ length: 10 }, () => ({})) }, homeBackgroundData: { homeBgDataList: [{}] } },
    'gacha_table.json': { gachaPoolClient: Array.from({ length: 200 }, () => ({ gachaRuleType: enums === 'named' ? 'NORMAL' : 0 })) },
    'gamedata_const.json': { evolveGoldCost: [] },
    'handbook_info_table.json': { handbookDict: many(200) },
    'item_table.json': { items: many(750) },
    'range_table.json': many(35),
    'retro_table.json': { retroActList: many(20) },
    'roguelike_topic_table.json': { topics: many(3) },
    'sandbox_perm_table.json': { detail: many(1) },
    'skill_table.json': many(900),
    'skin_table.json': { charSkins: many(1100) },
    'stage_table.json': { stages: many(1700), storylines: many(7) },
    'uniequip_table.json': { equipDict: many(450) },
  };
  fs.mkdirSync(path.join(gamedata, 'excel'), { recursive: true });
  for (const [file, table] of Object.entries(tables)) {
    if (without.includes(file)) continue;
    fs.writeFileSync(path.join(gamedata, 'excel', file), short.includes(file) ? '{}' : JSON.stringify(table));
  }
  fs.mkdirSync(path.join(gamedata, 'levels/obt/main'), { recursive: true });
  for (let i = 0; i < levels; i++) fs.writeFileSync(path.join(gamedata, 'levels/obt/main', `level_main_${i}.json`), '{}');
}
function writeArt(checkout: string, count = ART.least) {
  for (const folder of ART.folders) {
    fs.mkdirSync(path.join(checkout, folder), { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(checkout, folder, `${folder}_${i}.png`), 'png');
  }
}
function withRoot(run: (root: string) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-cn-tables-'));
  const done = () => fs.rmSync(root, { recursive: true, force: true });
  let result;
  try { result = run(root); } catch (error) { done(); throw error; }
  return Promise.resolve(result).finally(done);
}
const lockOf = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'data/upstream.lock.json'), 'utf8'));
const quarantineOf = (root: string) => fs.existsSync(path.join(root, 'data/quarantine.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8')).entries : [];
function writeLock(root: string, extra: object = {}) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/upstream.lock.json'), JSON.stringify({ version: 1, repositories: {
    [KENGXXIAO]: { branch: 'master', commit: commit('1'), source: 'resolved' },
    [YUANYAN]: { branch: 'main', commit: commit('3'), source: 'resolved' },
  }, ...extra }, null, 2));
}
/* A stand-in for scripts/lib/upstream.sh: each source answers from `mirrors` (a dump writer, or
   an error to throw), and every call is recorded with the commit it asked for. */
function fakeSync(root: string, mirrors: Record<string, ((gamedata: string) => void) | Error>) {
  const calls: { repository: string; commit: string | null; folders: string[] }[] = [];
  const sync = async (_root: string, { repository, commit: at, checkout, folders }: { repository: string; commit: string | null; checkout: string; folders: string[] }) => {
    calls.push({ repository, commit: at, folders });
    const key = `${repository}@${at}`;
    const answer = mirrors[key] ?? mirrors[repository];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error(`no fixture for ${key}`);
    const source = CN_TABLE_SOURCES.find((entry: { repository: string }) => entry.repository === repository);
    const dir = path.join(root, '.cache/upstream', checkout);
    if (folders.includes('map')) writeArt(dir);
    else {
      fs.rmSync(dir, { recursive: true, force: true });
      answer(path.join(dir, source.folder));
    }
    return at ?? commit('f');
  };
  return { sync, calls };
}
const linkOf = (root: string, name: string) => fs.readlinkSync(path.join(root, COMPOSED, name));

test('the table contract passes a whole dump, names how it writes enums, and catches a partial one', () => withRoot(root => {
  writeDump(path.join(root, 'named'));
  assert.deepEqual(checkTables(path.join(root, 'named')), { problems: [], serialization: 'named' });
  writeDump(path.join(root, 'numeric'), { enums: 'numeric' });
  assert.deepEqual(checkTables(path.join(root, 'numeric')), { problems: [], serialization: 'numeric' });
  writeDump(path.join(root, 'partial'), { without: ['charword_table.json'], short: ['stage_table.json'], levels: 12 });
  assert.deepEqual(checkTables(path.join(root, 'partial')).problems, [
    'excel/charword_table.json is missing', 'excel/stage_table.json holds fewer records than a whole dump', 'levels/ holds 12 level files, fewer than a whole dump']);
  fs.writeFileSync(path.join(root, 'named/excel/skin_table.json'), '{"charSkins": {');
  assert.deepEqual(checkTables(path.join(root, 'named')).problems, ['excel/skin_table.json is not JSON']);
}));

test('the primary mirror at its pin supplies every CN table, recorded in the lock and linked where the readers look', () => withRoot(async root => {
  writeLock(root, { lastCnTables: { repository: KENGXXIAO, commit: commit('0'), folder: 'zh_CN/gamedata', serialization: 'named' } });
  const { sync, calls } = fakeSync(root, { [KENGXXIAO]: dir => writeDump(dir) });
  const { tables, chosen } = await resolveTables(root, { sync, now: NOW });
  assert.equal(chosen.as, 'pinned');
  // At the commit pin-upstream wrote into the lock, excel/ and levels/ only.
  assert.deepEqual(calls, [{ repository: KENGXXIAO, commit: commit('1'), folders: ['zh_CN/gamedata/excel', 'zh_CN/gamedata/levels'] }]);
  assert.deepEqual(tables, { repository: KENGXXIAO, commit: commit('1'), folder: 'zh_CN/gamedata', serialization: 'named' });
  const lock = lockOf(root);
  assert.deepEqual(lock.cnTables, tables);
  assert.equal(lock.lastCnTables, undefined, 'the last run\'s record goes once this run has its own');
  assert.equal(lock.repositories[KENGXXIAO].commit, commit('1'));
  assert.equal(linkOf(root, 'gamedata'), path.join('..', TABLE_CHECKOUTS[KENGXXIAO], 'zh_CN/gamedata'));
  assert.ok(fs.existsSync(path.join(root, COMPOSED, 'gamedata/excel/character_table.json')));
  assert.deepEqual(quarantineOf(root), [], 'nothing to report, and no quarantine file started for it');
}));

test('with the primary mirror down, every CN table comes from the fallback, reported in words that do not change with the error', () => withRoot(async root => {
  const day = async (error: Error) => {
    writeLock(root);
    const { sync, calls } = fakeSync(root, { [KENGXXIAO]: error, [YUANYAN]: dir => writeDump(dir, { enums: 'numeric' }) });
    const result = await resolveTables(root, { sync, now: NOW });
    return { ...result, calls, quarantine: fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8') };
  };
  const first = await day(new Error('fatal: unable to access \'https://github.com/Kengxxiao/ArknightsGameData.git/\': Failed to connect to github.com port 443: Connection refused'));
  assert.equal(first.chosen.as, 'fallback');
  assert.deepEqual(first.calls.map((call: { repository: string; commit: string | null }) => [call.repository, call.commit]), [[KENGXXIAO, commit('1')], [YUANYAN, commit('3')]]);
  assert.deepEqual(first.tables, { repository: YUANYAN, commit: commit('3'), folder: 'gamedata', serialization: 'numeric' });
  assert.deepEqual(lockOf(root).cnTables, first.tables);
  assert.equal(linkOf(root, 'gamedata'), path.join('..', TABLE_CHECKOUTS[YUANYAN], 'gamedata'));
  const [entry] = quarantineOf(root);
  assert.deepEqual([entry.stage, entry.key, entry.action, entry.firstSeen], [STAGE, 'cn-tables', 'published-partial', '2026-09-24']);
  assert.match(entry.reason, /Kengxxiao\/ArknightsGameData could not be synced, or failed the table contract, so the CN tables come from yuanyan3060\/ArknightsGameResource/);
  assert.match(entry.reason, /the catalogue keeps its records as last published/);
  assert.doesNotMatch(entry.reason, /refused|443|fatal/);
  // A timeout the next day is the same outage: the published file does not change.
  const second = await day(new Error('no answer within 10 min'));
  assert.equal(second.quarantine, first.quarantine);
  // The primary back: the entry goes by itself.
  writeLock(root);
  await resolveTables(root, { sync: fakeSync(root, { [KENGXXIAO]: dir => writeDump(dir) }).sync, now: NOW });
  assert.deepEqual(quarantineOf(root), []);
}));

test('a dump that fails the contract at the pin gives way to the commit the last run read, then to the fallback', () => withRoot(async root => {
  const last = { repository: KENGXXIAO, commit: commit('0'), folder: 'zh_CN/gamedata', serialization: 'named' };
  writeLock(root, { lastCnTables: last });
  const { sync, calls } = fakeSync(root, {
    [`${KENGXXIAO}@${commit('1')}`]: dir => writeDump(dir, { without: ['gacha_table.json'] }),
    [`${KENGXXIAO}@${commit('0')}`]: dir => writeDump(dir),
  });
  const { tables, chosen, failures } = await resolveTables(root, { sync, now: NOW });
  assert.equal(chosen.as, 'last-run');
  assert.deepEqual(calls.map(call => call.commit), [commit('1'), commit('0')]);
  assert.deepEqual(tables, last);
  assert.match(failures[0], /Kengxxiao\/ArknightsGameData at 111111111111 \(pinned\) fails the table contract: excel\/gacha_table\.json is missing/);
  const [entry] = quarantineOf(root);
  assert.deepEqual([entry.key, entry.action], ['cn-tables', 'kept-previous']);
  assert.match(entry.reason, /the CN tables come from the commit of it the last run read/);
  // No commit of the primary to fall back to: straight to the fallback mirror.
  assert.deepEqual(candidates({ repositories: { [KENGXXIAO]: { commit: commit('1') }, [YUANYAN]: { commit: commit('3') } } }).map((c: { as: string }) => c.as), ['pinned', 'fallback']);
  assert.deepEqual(candidates({ repositories: {}, lastCnTables: { ...last, repository: YUANYAN, folder: 'gamedata' } }).map((c: { as: string; commit: string | null }) => [c.as, c.commit]),
    [['pinned', null], ['fallback', null]], 'unpinned, a source is synced at its branch head');
}));

test('with no usable CN tables from any mirror the stage fails, and leaves nothing for a reader to open', () => withRoot(async root => {
  writeLock(root);
  // A previous run's tables are still linked; they must not be read as this run's.
  fs.mkdirSync(path.join(root, COMPOSED), { recursive: true });
  fs.symlinkSync('../cn-tables/zh_CN/gamedata', path.join(root, COMPOSED, 'gamedata'));
  const { sync } = fakeSync(root, { [KENGXXIAO]: new Error('Could not resolve host: github.com'), [YUANYAN]: dir => writeDump(dir, { short: ['character_table.json'] }) });
  await assert.rejects(resolveTables(root, { sync, now: NOW }),
    /No source serves usable CN tables[\s\S]*Kengxxiao\/ArknightsGameData at 111111111111 \(pinned\) could not be synced: Could not resolve host[\s\S]*yuanyan3060\/ArknightsGameResource at 333333333333 \(fallback\) fails the table contract/);
  assert.deepEqual(fs.readdirSync(path.join(root, COMPOSED)), []);
  assert.equal(lockOf(root).cnTables, undefined);
}));

test('the art is a stage of its own: at yuanyan\'s pin when it syncs, and gone, not stale, when it does not', () => withRoot(async root => {
  writeLock(root);
  // The single checkout of before becomes the art checkout, so a restored cache is reused.
  fs.mkdirSync(path.join(root, COMPOSED, '.git'), { recursive: true });
  writeDump(path.join(root, COMPOSED, 'gamedata'), { levels: 1 });
  const art = fakeSync(root, { [YUANYAN]: () => {} });
  assert.equal(await syncArt(root, { sync: art.sync }), commit('3'));
  assert.deepEqual(art.calls, [{ repository: YUANYAN, commit: commit('3'), folders: ['map', 'item'] }]);
  assert.ok(fs.existsSync(path.join(root, '.cache/upstream', ART.checkout, '.git')), 'moved, not downloaded again');
  assert.equal(fs.existsSync(path.join(root, COMPOSED, '.git')), false);
  assert.equal(fs.existsSync(path.join(root, '.cache/upstream', ART.checkout, 'gamedata')), false, 'its tables, which nothing reads now, are dropped');
  assert.deepEqual(['map', 'item'].map(folder => linkOf(root, folder)), [path.join('..', ART.checkout, 'map'), path.join('..', ART.checkout, 'item')]);
  assert.ok(fs.existsSync(path.join(root, COMPOSED, 'item/item_0.png')));
  await assert.rejects(syncArt(root, { sync: fakeSync(root, { [YUANYAN]: new Error('Connection timed out') }).sync }), /Connection timed out/);
  assert.deepEqual(fs.readdirSync(path.join(root, COMPOSED)), [], 'no stage reads art of another commit');
}));

test('every stage after upstream-cn reads the CN tables it settled on, even at a commit that is not the pin', () => withRoot(root => {
  const settled = { repository: KENGXXIAO, commit: commit('a'), folder: 'zh_CN/gamedata', serialization: 'named' };
  writeLock(root, { cnTables: settled });
  const env = pinEnvironment(root, {});
  assert.equal(env[pinVariable(KENGXXIAO)], commit('1'));
  assert.deepEqual(JSON.parse(env[CN_TABLES_VARIABLE]), settled);
  assert.equal(cnTableUrl('excel/charword_table.json', env), `https://raw.githubusercontent.com/${KENGXXIAO}/${commit('a')}/zh_CN/gamedata/excel/charword_table.json`);
  const fallback = { [CN_TABLES_VARIABLE]: JSON.stringify({ repository: YUANYAN, commit: commit('3'), folder: 'gamedata', serialization: 'numeric' }) };
  assert.equal(cnTableUrl('excel', fallback), `https://raw.githubusercontent.com/${YUANYAN}/${commit('3')}/gamedata/excel`);
  // Run by hand, outside a refresh: the primary at its pin, else its branch, as before.
  assert.equal(cnTableUrl('excel', { [pinVariable(KENGXXIAO)]: commit('1') }), `https://raw.githubusercontent.com/${KENGXXIAO}/${commit('1')}/zh_CN/gamedata/excel`);
  assert.deepEqual(cnTables({}), { repository: KENGXXIAO, commit: null, ref: 'master', folder: 'zh_CN/gamedata', serialization: null });
  // Python and shell ask pin-upstream.mjs for the same URL, so no script names a CN mirror itself.
  const cli = (given: Record<string, string>) => spawnSync(process.execPath, ['scripts/content/pin-upstream.mjs', 'cn-table-url', 'excel'],
    { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARKPEDIA_'))), ...given } as NodeJS.ProcessEnv });
  assert.equal(cli(fallback).stdout, `https://raw.githubusercontent.com/${YUANYAN}/${commit('3')}/gamedata/excel\n`);
  assert.equal(cli({ [pinVariable(KENGXXIAO)]: commit('1') }).stdout, `https://raw.githubusercontent.com/${KENGXXIAO}/${commit('1')}/zh_CN/gamedata/excel\n`);
  const broken = cli({ [CN_TABLES_VARIABLE]: 'yuanyan' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /does not name one of the CN table sources/);
  // A value that names no source is a broken refresh, never a quiet read of another mirror.
  assert.throws(() => cnTables({ [CN_TABLES_VARIABLE]: JSON.stringify({ repository: 'someone/else', commit: commit('3'), folder: 'gamedata', serialization: 'numeric' }) }), /does not name one of the CN table sources/);
  assert.throws(() => cnTables({ [CN_TABLES_VARIABLE]: 'yuanyan' }), /does not name one of the CN table sources/);
}));

test('the readers that fetch a CN table by URL fetch it from the mirror and commit the run settled on', () => withRoot(root => {
  // Every request is recorded and refused, so each script stops at its first reads.
  const preload = path.join(root, 'offline.mjs'), sitecustomize = path.join(root, 'py'), log = path.join(root, 'fetched.txt');
  fs.writeFileSync(preload, "import fs from 'node:fs';\nglobalThis.fetch = async url => { fs.appendFileSync(process.env.FETCH_LOG, `${url}\\n`); throw new Error('offline'); };\n");
  fs.mkdirSync(sitecustomize);
  fs.writeFileSync(path.join(sitecustomize, 'sitecustomize.py'), 'import os, urllib.request\n'
    + 'def refuse(request, *args, **kwargs):\n    open(os.environ["FETCH_LOG"], "a").write(getattr(request, "full_url", request) + "\\n")\n    raise OSError("offline")\n'
    + 'urllib.request.urlopen = refuse\n');
  const cwd = path.join(root, 'cwd');
  // The reward icons need one reward without an icon, and the EN tables on disk, to reach the CN ones.
  fs.mkdirSync(path.join(cwd, 'data/events'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'data/events/events_2099.json'), JSON.stringify([{ name: 'Test', rewards: { items: [{ name: 'Imaginary Widget', type: 'material' }] } }]));
  fs.mkdirSync(path.join(root, 'en/gamedata/excel'), { recursive: true });
  for (const file of ['item_table.json', 'building_data.json']) fs.writeFileSync(path.join(root, 'en/gamedata/excel', file), '{"items": {}}');
  const pins = Object.fromEntries(MIRRORS.map((mirror: { repository: string }, i: number) => [pinVariable(mirror.repository), commit(String(i + 1))]));
  // GITHUB_ACTIONS changes what the scripts print, so the children run as they do on a laptop.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARKPEDIA_') && name !== 'GITHUB_ACTIONS')) as NodeJS.ProcessEnv;
  const said: Record<string, string> = {};
  const read = (settled: object | null) => Object.fromEntries([
    ['sync/sync-content-inventory.mjs', 'node'], ['build/build-operator-voices.mjs', 'node'], ['sync/sync-event-windows.mjs', 'node'], ['imports/import-reward-icons.py', 'python3'],
  ].map(([script, runtime]) => {
    fs.rmSync(log, { force: true });
    said[script] = spawnSync(runtime, [...(runtime === 'node' ? ['--import', preload] : []), path.resolve('scripts', script)], { cwd, encoding: 'utf8',
      env: { ...clean, ...pins, ...(settled ? { [CN_TABLES_VARIABLE]: JSON.stringify(settled) } : {}), FETCH_LOG: log, PYTHONPATH: sitecustomize,
        ARKPEDIA_EN: path.join(root, script.endsWith('.py') ? 'en' : 'none'), ARKPEDIA_CN: path.join(root, 'none') } }).stderr.slice(-1500);
    return [script, fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []];
  }));
  // The fallback mirror: no stage fetches a CN table from the primary, and every one is at the commit settled on.
  const fallback = read({ repository: YUANYAN, commit: commit('9'), folder: 'gamedata', serialization: 'numeric' });
  for (const [script, urls] of Object.entries(fallback)) {
    const tables = urls.filter(url => url.includes('/gamedata/excel/') && !url.includes('/en/gamedata/') && !url.includes('/en_US/'));
    assert.ok(tables.length, `${script} fetched no CN table: ${urls.join(', ')}\n${said[script]}`);
    for (const url of tables) assert.ok(url.startsWith(`https://raw.githubusercontent.com/${YUANYAN}/${commit('9')}/gamedata/excel/`), `${script}: ${url}`);
    assert.ok(!urls.some(url => url.includes(KENGXXIAO)), `${script} read the primary mirror too: ${urls.join(', ')}`);
  }
  // The primary at the last run's commit, which is not its pin: that commit, never the pin.
  const lastRun = read({ repository: KENGXXIAO, commit: commit('a'), folder: 'zh_CN/gamedata', serialization: 'named' });
  for (const [script, urls] of Object.entries(lastRun)) {
    const tables = urls.filter(url => url.includes(`/${KENGXXIAO}/`));
    assert.ok(tables.length, `${script} fetched no CN table: ${urls.join(', ')}\n${said[script]}`);
    for (const url of tables) assert.ok(url.startsWith(`https://raw.githubusercontent.com/${KENGXXIAO}/${commit('a')}/zh_CN/gamedata/excel/`), `${script}: ${url}`);
  }
  // Run by hand, with no tables settled: the primary at its pin, the Python script included.
  const byHand = read(null);
  for (const [script, urls] of Object.entries(byHand)) {
    const tables = urls.filter(url => url.includes('/gamedata/excel/') && !url.includes('/en/gamedata/') && !url.includes('/en_US/'));
    assert.ok(tables.length, `${script} fetched no CN table: ${urls.join(', ')}\n${said[script]}`);
    for (const url of tables) assert.ok(url.startsWith(`https://raw.githubusercontent.com/${KENGXXIAO}/${commit('1')}/zh_CN/gamedata/excel/`), `${script}: ${url}`);
  }
}));

test('pin-upstream keeps where the last run\'s CN tables came from only as a fallback, never as this run\'s', async () => {
  const settled = { repository: KENGXXIAO, commit: commit('a'), folder: 'zh_CN/gamedata', serialization: 'named' };
  const resolve = async (repository: string) => (repository === KENGXXIAO ? commit('1') : commit('2'));
  const { lock } = await pinUpstream({ previous: { version: 1, repositories: {}, cnTables: settled }, resolve });
  assert.equal(lock.cnTables, undefined, 'no stage may read CN tables before upstream-cn settles them');
  assert.deepEqual(lock.lastCnTables, settled);
  // A lock from a run that failed before settling still names the one before it.
  assert.deepEqual((await pinUpstream({ previous: { version: 1, repositories: {}, lastCnTables: settled }, resolve })).lock.lastCnTables, settled);
  assert.equal((await pinUpstream({ previous: { version: 1, repositories: {}, cnTables: { ...settled, commit: 'master' } }, resolve })).lock.lastCnTables, undefined);
});

test('the catalogue refuses CN tables that number their enums, instead of misfiling every record', async () => {
  // @ts-expect-error Node publication scripts are plain JavaScript.
  const { cnSource } = await import('../sync/sync-catalogue.mjs');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-catalogue-enums-'));
  const many = (count: number, make: (i: number) => unknown = () => ({})) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, make(i)]));
  const tables = (rarity: string | number, gachaRuleType: string | number): Record<string, unknown> => ({
    'character_table.json': many(400, i => ({ name: `op ${i}`, rarity })), 'skin_table.json': { charSkins: many(500) }, 'skill_table.json': many(500),
    'handbook_info_table.json': { handbookDict: many(300) }, 'gacha_table.json': { gachaPoolClient: Array.from({ length: 100 }, () => ({ gachaRuleType })) },
    'activity_table.json': { basicInfo: {} }, 'gamedata_const.json': { evolveGoldCost: [] },
  });
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let serving: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string) => { asked.push(String(url)); return new Response(JSON.stringify(serving[String(url).split('/').at(-1)!] ?? {})); }) as typeof fetch;
  try {
    const yuanyan = { [CN_TABLES_VARIABLE]: JSON.stringify({ repository: YUANYAN, commit: commit('3'), folder: 'gamedata', serialization: 'numeric' }) };
    serving = tables(5, 0);
    await assert.rejects(cnSource(cache, yuanyan), /yuanyan3060\/ArknightsGameResource numbers the game's enums, and the catalogue reads them by name/);
    assert.ok(asked.length && asked.every(url => url.startsWith(`https://raw.githubusercontent.com/${YUANYAN}/${commit('3')}/gamedata/excel/`)), asked.join(', '));
    // The same tables with named enums, from the primary at the commit the run settled on --
    // one value its decoder could not name is still a mirror that names them (the Global one
    // numbers its RETURN_EN_41_0_1 pool, gachaRuleType 11, in 2026-09).
    serving = tables('TIER_6', 'NORMAL');
    (serving['gacha_table.json'] as { gachaPoolClient: object[] }).gachaPoolClient[0] = { gachaRuleType: 11 };
    asked.length = 0;
    const kengxxiao = { [CN_TABLES_VARIABLE]: JSON.stringify({ repository: KENGXXIAO, commit: commit('a'), folder: 'zh_CN/gamedata', serialization: 'named' }) };
    const cn = await cnSource(cache, kengxxiao);
    assert.deepEqual([cn.repository, cn.revision], [`https://github.com/${KENGXXIAO}`, commit('a')]);
    assert.ok(asked.every(url => url.startsWith(`https://raw.githubusercontent.com/${KENGXXIAO}/${commit('a')}/zh_CN/gamedata/excel/`)), asked.join(', '));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

/* The stage command as the refresh runs it, with scripts/lib/upstream.sh cloning stand-in
   mirrors served over file:// under GitHub's URLs, as the pin test in test-upstream-pins does. */
test('the upstream-cn and upstream-cn-art stages, end to end against mirrors that are up, down or moved past the pin', () => withRoot(root => {
  // Without GITHUB_ACTIONS the stage writes warning: lines, not workflow annotations.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARKPEDIA_') && !name.startsWith('GIT_') && name !== 'GITHUB_ACTIONS')) as NodeJS.ProcessEnv;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...clean, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const mirror = (name: string, branch: string) => {
    const dir = path.join(root, 'mirrors', name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', branch);
    git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(dir, 'config', 'uploadpack.allowFilter', 'true');
    return dir;
  };
  const commitAll = (dir: string, message: string) => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  // The primary: the pinned commit is whole; the head, which moved on, lost a table.
  const kengxxiao = mirror('kengxxiao', 'master');
  writeDump(path.join(kengxxiao, 'zh_CN/gamedata'));
  const pinned = commitAll(kengxxiao, 'whole');
  fs.rmSync(path.join(kengxxiao, 'zh_CN/gamedata/excel/skin_table.json'));
  commitAll(kengxxiao, 'partial');
  const yuanyan = mirror('yuanyan', 'main');
  writeDump(path.join(yuanyan, 'gamedata'), { enums: 'numeric' });
  writeArt(yuanyan);
  const yuanyanPin = commitAll(yuanyan, 'dump');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'scripts/lib'), { recursive: true });
  fs.copyFileSync('scripts/lib/upstream.sh', path.join(app, 'scripts/lib/upstream.sh'));
  const lock = () => {
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    fs.writeFileSync(path.join(app, 'data/upstream.lock.json'), JSON.stringify({ version: 1, repositories: {
      [KENGXXIAO]: { branch: 'master', commit: pinned, source: 'resolved' }, [YUANYAN]: { branch: 'main', commit: yuanyanPin, source: 'resolved' } } }));
  };
  const stage = (up: string[], ...args: string[]) => {
    const gitconfig = path.join(root, 'gitconfig');
    const served: Record<string, string> = { [KENGXXIAO]: kengxxiao, [YUANYAN]: yuanyan };
    fs.writeFileSync(gitconfig, Object.entries(served).map(([repository, dir]) =>
      `[url "file://${up.includes(repository) ? dir : path.join(root, 'down', repository)}"]\n\tinsteadOf = https://github.com/${repository}.git\n`).join('') + '[protocol "file"]\n\tallow = always\n');
    const result = spawnSync(process.execPath, [path.resolve('scripts/content/cn-tables.mjs'), ...args],
      { cwd: app, encoding: 'utf8', env: { ...clean, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', ARKPEDIA_NOW: NOW.toISOString() } });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  // Both up: the primary, at the pin and not at its moved head.
  lock();
  let run = stage([KENGXXIAO, YUANYAN]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /CN tables from Kengxxiao\/ArknightsGameData at [0-9a-f]{12} \(pinned; enums named\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'data/upstream.lock.json'), 'utf8')).cnTables,
    { repository: KENGXXIAO, commit: pinned, folder: 'zh_CN/gamedata', serialization: 'named' });
  assert.ok(fs.existsSync(path.join(app, COMPOSED, 'gamedata/excel/skin_table.json')), 'the pinned commit, which still has every table');
  // The art beside it, at yuanyan's pin.
  run = stage([KENGXXIAO, YUANYAN], 'art');
  assert.equal(run.status, 0, run.output);
  assert.ok(fs.existsSync(path.join(app, COMPOSED, 'map/map_0.png')) && fs.existsSync(path.join(app, COMPOSED, 'item/item_0.png')));
  // The primary down: the fallback, recorded and reported, and the stage still succeeds.
  lock();
  run = stage([YUANYAN]);
  assert.equal(run.status, 0, run.output);
  // It names git's failure, not the advice git prints after it.
  assert.match(run.output, /warning: Kengxxiao\/ArknightsGameData at [0-9a-f]{12} \(pinned\) could not be synced: fatal: '[^']*' does not appear to be a git repository/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'data/upstream.lock.json'), 'utf8')).cnTables,
    { repository: YUANYAN, commit: yuanyanPin, folder: 'gamedata', serialization: 'numeric' });
  assert.equal(fs.readlinkSync(path.join(app, COMPOSED, 'gamedata')), path.join('..', TABLE_CHECKOUTS[YUANYAN], 'gamedata'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'data/quarantine.json'), 'utf8')).entries.map((entry: { key: string }) => entry.key), ['cn-tables']);
  // yuanyan down: the art stage fails alone, and the tables still come from the primary.
  lock();
  assert.equal(stage([KENGXXIAO]).status, 0);
  run = stage([KENGXXIAO], 'art');
  assert.equal(run.status, 1, run.output);
  assert.deepEqual(fs.readdirSync(path.join(app, COMPOSED)), ['gamedata']);
  // Both down: the one failure that stops the run.
  lock();
  run = stage([]);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /No source serves usable CN tables, so no stage has them/);
  assert.deepEqual(fs.readdirSync(path.join(app, COMPOSED)), []);
}));
