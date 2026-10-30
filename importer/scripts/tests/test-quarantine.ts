import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Plain Node helper shared by the importers.
import { beginStage, readQuarantine } from '../lib/quarantine.mjs';
// @ts-expect-error Plain Node import scripts share their pure reconciliation with tests.
import { reconcileCalendars } from '../sync/catalogue-model.mjs';

// How a stage writes and keeps its entries is held by arkpedia-app's own
// scripts/tests/test-quarantine.ts, which runs the same scripts/lib/quarantine.mjs;
// these are the two the importers here are the subject of.

function temporary(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-quarantine-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const file = (root: string) => path.join(root, 'data/quarantine.json');
const serverDay = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10).replaceAll('-', '/');

test("the reward-icons importer cites the EN wiki by that name, and other hosts as they are", () => {
  // A reason may not name wiki.gg, which a released record may only cite: the stage's own
  // wording, read from its source.
  const named = execFileSync('python3', ['-c', `
import ast, pathlib, re
source = ast.parse(pathlib.Path('scripts/imports/import-reward-icons.py').read_text())
scope = {'re': re}
exec(compile(ast.Module(body=[next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'cited')], type_ignores=[]), 'cited', 'exec'), scope)
for text in ['has an icon at arknights.wiki.gg, staged', 'has an icon at torappu.prts.wiki, but downloading it failed']: print(scope['cited'](text))
`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n');
  assert.deepEqual(named, ['has an icon at the EN wiki, staged', 'has an icon at torappu.prts.wiki, but downloading it failed']);
});

/*
 * data/quarantine.json is a release input, so a day on which nothing changed -- the same
 * tables, the same wiki rows, the same records -- must write it byte for byte, even with
 * the clock a few days on and every mirror at a newer commit. Each writer below has
 * something to report on both days: CN pools published from the client (one a Joint
 * Operation, named after its pool), wiki event rows that stop matching (one of them opening
 * between the two days), a Global pool in another record's estimated window, and two Kernel
 * banners, one waiting for an operator record and one the wiki row disagrees with.
 */
test('the same inputs on two different days, with the mirrors a commit on, write the same quarantine file byte for byte', async () => {
  const cnDay = (day: string) => Date.parse(`${day.replaceAll('/', '-')}T16:00:00+08:00`) / 1000;
  const enDay = (day: string) => Date.parse(`${day.replaceAll('/', '-')}T04:00:00-07:00`) / 1000;
  const fortnight = (open: number) => open + 14 * 86400 - 1;
  const empty = { characters: {}, skins: { charSkins: {}, brandList: {} }, activity: { basicInfo: {}, missionData: {} }, gacha: { gachaPoolClient: [] } };
  const activities = Object.fromEntries(['2026/06/01', '2026/06/15', '2026/07/01', '2026/07/15', '2026/09/24'].map((day, i) =>
    [`act${i}`, { id: `act${i}`, name: `act${i}`, hasStage: true, startTime: cnDay(day), endTime: cnDay(day) + 14 * 86400 }]));
  const cn = { ...empty, source: 'cn-mirror', activity: { basicInfo: activities, missionData: {} }, gacha: { gachaPoolClient: [
    { gachaPoolId: 'NORM_90_0_3', gachaRuleType: 'NORMAL', gachaPoolName: '适合多种场合的强力干员', openTime: cnDay('2026/09/14'), endTime: fortnight(cnDay('2026/09/14')) },
    { gachaPoolId: 'LIMITED_90_0_1', gachaRuleType: 'LIMITED', gachaPoolName: '限定之名', openTime: cnDay('2026/09/10'), endTime: fortnight(cnDay('2026/09/10')), limitParam: { limitedCharId: 'char_9001_ltd' } },
  ] } };
  const en = { ...empty, source: 'en-mirror', gacha: { gachaPoolClient: [
    { gachaPoolId: 'SINGLE_EN_50_0_1', gachaRuleType: 'SINGLE', gachaPoolName: 'Dithyramb Unending', openTime: enDay('2026/09/20'), endTime: fortnight(enDay('2026/09/20')) },
  ] } };
  const operators = [{ name: 'Limited Six', internalName: 'char_9001_ltd', rarity: 6 }, { name: 'Five A', internalName: 'char_9003_five', rarity: 5 }];
  const eventRows = Object.values(activities).map((act: any, i) => ({ name: `Event ${i}`, type: 'side story', cnstart: serverDay(act.startTime), cnend: '2026/12/31' }));
  const catalogueBanners = [{ name: 'Deterministic Chaos', pull_type: 'featured', category: 'standard', global_date: '2026/09/20–2026/10/04', cnPoolId: 'SINGLE_75_0_1' }];
  // The recurring importer builds its client URL from the pin when it loads, so each day loads its own copy.
  const kernelPool = (gachaPoolId: string, day: string, rare5CharList: string[]) => ({ gachaPoolId, gachaRuleType: 'CLASSIC_DOUBLE', openTime: enDay(day), endTime: fortnight(enDay(day)),
    dynMeta: { main6RarityCharId: 'six_c', sub6RarityCharId: 'six_d', rare5CharList } });
  const gachaTable = { gachaPoolClient: [kernelPool('kernel_a', '2026/09/01', ['newguy', 'five_e', 'five_f']), kernelPool('kernel_b', '2026/09/15', ['five_d', 'five_e', 'five_f'])] };
  const characters = Object.fromEntries(['Six C', 'Six D', 'Five D', 'Five E', 'Five F', 'NewGuy'].map(name => [name.toLowerCase().replace(' ', '_'), { name }]));
  const roster = new Map([['Six C', 6], ['Six D', 6], ['Five D', 5], ['Five E', 5], ['Five F', 5], ['Five A', 5]]);
  const wikiRows = [
    { type: 'kernel', number: 60, start: '2026/09/01', end: '2026/09/15', operators: ['Six C', 'Six D', 'NewGuy', 'Five E', 'Five F'] },
    { type: 'kernel', number: 61, start: '2026/09/15', end: '2026/09/29', operators: ['Six C', 'Six D', 'Five A', 'Five E', 'Five F'] },
  ];
  const pin = 'ARKPEDIA_PIN_ARKNIGHTSASSETS_ARKNIGHTSGAMEDATA', pinned = process.env[pin];
  const recurringAt = async (commit: string) => {
    process.env[pin] = commit;
    try { return await import(`../sync/sync-recurring-banners.mjs?pin=${commit}`); } finally { if (pinned === undefined) delete process.env[pin]; else process.env[pin] = pinned; }
  };
  const days = [{ now: new Date('2026-09-22T12:00:00Z'), recurring: await recurringAt('a'.repeat(40)) }, { now: new Date('2026-09-26T12:00:00Z'), recurring: await recurringAt('b'.repeat(40)) }];
  temporary(root => {
    let records = { events: [] as object[], banners: catalogueBanners as object[], recurring: [] as object[] };
    const files = days.map(({ now, recurring }) => {
      const calendars = reconcileCalendars({ announced: { events: [], banners: [] }, events: records.events, banners: records.banners, operators, cn, en, eventRows, bannerRows: [], now: now.getTime() });
      const banners = recurring.reconcileRecurringBanners({ banners: records.recurring, gachaTable, characters, wikiRows, roster, now: now.getTime() });
      for (const [stage, entries] of [['catalogue', calendars.quarantine], ['recurring-banners', banners.quarantine]] as [string, object[]][]) {
        const writer = beginStage(root, stage, now);
        for (const entry of entries) writer.add(entry);
        writer.commit();
      }
      records = { events: calendars.events, banners: calendars.banners, recurring: banners.banners };
      return fs.readFileSync(file(root), 'utf8');
    });
    const entries = readQuarantine(root).entries;
    assert.deepEqual(entries.map((e: any) => e.key), ['banner:LIMITED_90_0_1', 'banner:NORM_90_0_3', 'banner:SINGLE_EN_50_0_1', 'events:wiki-rows', 'banner:kernel_a', 'banner:kernel_b']);
    assert.match(entries[1].reason, /^Joint Operation \(NORM_90_0_3\) is published from the CN client without/, 'the pool id once');
    assert.equal(files[1], files[0]);
  });
});
