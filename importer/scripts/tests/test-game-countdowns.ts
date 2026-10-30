import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The event and banner windows the import copies out of the client. What the site then
// counts down from them is held by arkpedia-app's own scripts/tests/test-game-countdowns.ts.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SYNC = path.join(REPO, 'scripts/sync/sync-event-windows.mjs');

test('sync retains exact hours even when calendar days are unchanged, and is idempotent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-window-test-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data/events'), { recursive: true });
    const year = new Date().getUTCFullYear() + 1;
    const range = `${year}/09/16–${year}/09/30`;
    const open = Date.UTC(year, 8, 16, 17) / 1000, close = Date.UTC(year, 8, 30, 11) / 1000;
    const eventFile = path.join(tmp, `data/events/events_${year}.json`), bannerFile = path.join(tmp, 'data/headhunting_banners.json');
    fs.writeFileSync(eventFile, JSON.stringify([{ name: 'Test event', global: { dateRange: range, note: 'Estimated' } }]));
    fs.writeFileSync(bannerFile, JSON.stringify([{ name: 'Test banner', global_date: range }]));
    for (const region of ['en', 'cn']) {
      const dir = path.join(tmp, region, 'gamedata/excel'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'activity_table.json'), JSON.stringify({ basicInfo: region === 'en' ? { test: { name: 'Test event', startTime: open, endTime: close - 1 } } : {} }));
      fs.writeFileSync(path.join(dir, 'gacha_table.json'), JSON.stringify({ gachaPoolClient: region === 'en' ? [{ gachaPoolName: 'Test banner', openTime: open, endTime: close }] : [] }));
    }
    const run = () => execFileSync(process.execPath, [SYNC], { cwd: tmp, env: { ...process.env, ARKPEDIA_EN: 'en', ARKPEDIA_CN: 'cn' }, encoding: 'utf8' });
    run();
    const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'))[0].global;
    const banner = JSON.parse(fs.readFileSync(bannerFile, 'utf8'))[0].global_window;
    assert.equal(event.startAt, `${year}-09-16T17:00:00.000Z`);
    assert.equal(event.endAt, `${year}-09-30T11:00:00.000Z`);
    assert.equal(event.note, null);
    assert.equal(banner.startAt, event.startAt);
    assert.equal(banner.endAt, event.endAt);
    const saved = fs.readFileSync(eventFile, 'utf8') + fs.readFileSync(bannerFile, 'utf8');
    run();
    assert.equal(fs.readFileSync(eventFile, 'utf8') + fs.readFileSync(bannerFile, 'utf8'), saved);
    // An official notice may announce maintenance hours that the mirror lacks.
    const official = { startAt: `${year}-09-16T15:00:00.000Z`, endAt: event.endAt, timingSource: 'https://www.arknights.global/news/4635' };
    fs.writeFileSync(eventFile, JSON.stringify([{ name: 'Test event', global: { dateRange: range, ...official } }]));
    fs.writeFileSync(bannerFile, JSON.stringify([{ name: 'Test banner', global_date: range, global_window: official }]));
    const announced = fs.readFileSync(eventFile, 'utf8') + fs.readFileSync(bannerFile, 'utf8');
    run();
    assert.equal(fs.readFileSync(eventFile, 'utf8') + fs.readFileSync(bannerFile, 'utf8'), announced);

    // A banner that carries its pool id takes that pool's window even when no name
    // matches, and a rerun takes its own pool rather than its original's.
    const later = Date.UTC(year, 9, 14, 11) / 1000;
    fs.writeFileSync(path.join(tmp, 'en/gamedata/excel/gacha_table.json'), JSON.stringify({ gachaPoolClient: [
      { gachaPoolId: 'SINGLE_EN_1', gachaPoolName: 'Official Name', openTime: open, endTime: close },
      { gachaPoolId: 'SINGLE_EN_2', gachaPoolName: 'Twice Run', openTime: open, endTime: close },
      { gachaPoolId: 'SINGLE_EN_3', gachaPoolName: 'Twice Run', openTime: later, endTime: later + 14 * 86400 },
    ] }));
    fs.writeFileSync(bannerFile, JSON.stringify([{ name: 'Community Name', global_date: null, globalPoolId: 'SINGLE_EN_1' },
      { name: 'Twice Run Rerun', global_date: range, globalPoolId: 'SINGLE_EN_3' }]));
    run();
    const [community, rerun] = JSON.parse(fs.readFileSync(bannerFile, 'utf8'));
    assert.deepEqual([community.global_date, community.global_window.startAt], [range, event.startAt]);
    assert.equal(rerun.global_window.startAt, new Date(later * 1000).toISOString());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/* The calendar days a script writes come from one helper (scripts/lib/server-day.mjs), so a
   window sync-event-windows.mjs copies from the client and the one catalogue-model.mjs or the
   CN announcements write are one string for one day. sync-event-windows.mjs kept a copy of its
   own until 2026-10-05; a copy that drifts (an offset's sign, the 04:00 rollover) would date the
   same window two ways, and each stage would rewrite the other's days. */
test('no script keeps its own serverDay: every one imports scripts/lib/server-day.mjs', () => {
  const copies: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (at !== path.join(REPO, 'scripts', 'tests')) walk(at); continue; }
      if (!/\.(?:mjs|js|ts)$/.test(entry.name) || at === path.join(REPO, 'scripts', 'lib', 'server-day.mjs')) continue;
      if (/\b(?:function\s+serverDay\b|(?:const|let|var)\s+serverDay\s*=)/.test(fs.readFileSync(at, 'utf8'))) copies.push(at);
    }
  };
  walk(path.join(REPO, 'scripts'));
  assert.deepEqual(copies, [], `import { serverDay } from scripts/lib/server-day.mjs instead of defining one in ${copies.join(', ')}`);
  assert.match(fs.readFileSync(SYNC, 'utf8'), /import \{ serverDay \} from '\.\.\/lib\/server-day\.mjs'/);
});

/*
 * An event's store outlasts its stages, and the client says until when (rewardEndTime).
 * [Side Story] People, A People's stages closed 2026-09-30 11:00Z and its store 2026-10-07
 * 11:00Z; the home page took the event down with the stages while readers had a week of
 * shopping left. The sync records the store's close on every current event, the ones with an
 * official notice's hours too, and matches it to the run by its close.
 */
test("sync records the event store's close from the client, official-notice entries included", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-shop-test-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data/events'), { recursive: true });
    const year = new Date().getUTCFullYear() + 1;
    const range = `${year}/09/16–${year}/09/30`;
    const open = Date.UTC(year, 8, 16, 15) / 1000, close = Date.UTC(year, 8, 30, 11) / 1000, shop = Date.UTC(year, 9, 7, 11) / 1000;
    const official = { dateRange: range, note: '', startAt: new Date(open * 1000).toISOString(), endAt: new Date(close * 1000).toISOString(), timingSource: 'https://www.arknights.global/news/4635' };
    const eventFile = path.join(tmp, `data/events/events_${year}.json`);
    fs.writeFileSync(eventFile, JSON.stringify([
      { name: '[Side Story] Shop Event', global: official },
      { name: 'Closes With Stages', global: { ...official, timingSource: undefined } },
      // A rerun far from the client's run keeps no store of the original's.
      { name: 'Old Run', global: { ...official, dateRange: `${year}/03/01–${year}/03/15`, startAt: `${year}-03-01T15:00:00.000Z`, endAt: `${year}-03-15T11:00:00.000Z` } },
    ]));
    fs.writeFileSync(path.join(tmp, 'data/headhunting_banners.json'), '[]');
    for (const region of ['en', 'cn']) {
      const dir = path.join(tmp, region, 'gamedata/excel'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'activity_table.json'), JSON.stringify({ basicInfo: region === 'en' ? {
        a: { name: 'Shop Event', startTime: open, endTime: close - 1, rewardEndTime: shop - 1 },
        b: { name: 'Closes With Stages', startTime: open, endTime: close - 1, rewardEndTime: close - 1 },
        c: { name: 'Old Run', startTime: open, endTime: close - 1, rewardEndTime: shop - 1 },
      } : {} }));
      fs.writeFileSync(path.join(dir, 'gacha_table.json'), JSON.stringify({ gachaPoolClient: [] }));
    }
    const run = () => execFileSync(process.execPath, [SYNC], { cwd: tmp, env: { ...process.env, ARKPEDIA_EN: 'en', ARKPEDIA_CN: 'cn' }, encoding: 'utf8' });
    run();
    const [shopEvent, withStages, oldRun] = JSON.parse(fs.readFileSync(eventFile, 'utf8')).map((event: { global: Record<string, unknown> }) => event.global);
    assert.equal(shopEvent.shopEndAt, `${year}-10-07T11:00:00.000Z`);
    // The official notice's hours are untouched.
    assert.deepEqual([shopEvent.startAt, shopEvent.endAt, shopEvent.timingSource], [official.startAt, official.endAt, official.timingSource]);
    assert.equal('shopEndAt' in withStages, false, 'a store closing with the stages adds nothing');
    assert.equal('shopEndAt' in oldRun, false);
    const saved = fs.readFileSync(eventFile, 'utf8');
    run();
    assert.equal(fs.readFileSync(eventFile, 'utf8'), saved, 'idempotent');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
