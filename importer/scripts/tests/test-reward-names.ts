import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error JavaScript importer is also run directly by the refresh job.
import { rewardNames, localizeRewards, iconFile, syncRewardNames } from '../sync/sync-reward-names.mjs';
// @ts-expect-error Node scripts are plain JavaScript.
import { eventWindow } from '../lib/event-records.mjs';

/* IDs and names copied from the live CN and EN building_data / item_table entries for
   the People, A People store (furni_ursusRoom_*), plus one furniture the EN client does
   not have yet (Critical Phase Transition) and one CN name shared by two IDs. The
   application holds what the renamed rewards then render as (arkpedia-app
   scripts/tests/test-reward-names.ts). */
const cn = {
  items: { items: { 4001: { name: '龙门币' }, dupe_a: { name: '同名家具' } } },
  building: { customData: { furnitures: {
    furni_ursusRoom_basin_01: { name: '制式木盆' },
    furni_ursusRoom_floor_01: { name: '“烛火之中”' },
    furni_rabbitCinema_stool_01: { name: '“回看”高脚凳' },
    dupe_b: { name: '同名家具' },
  } } },
};
const en = {
  items: { items: { 4001: { name: 'LMD' }, dupe_a: { name: 'Same Name A' } } },
  building: { customData: { furnitures: {
    furni_ursusRoom_basin_01: { name: 'Standard Wooden Basin' },
    furni_ursusRoom_floor_01: { name: "'V Plameni Svechi'" },
    dupe_b: { name: 'Same Name B' },
  } } },
};
const store = (items: object[]) => ({ type: 'Events Store', name: 'Snow-soaked Campfire', currency: 'Broken Poetry Verse', items });
const item = (name: string, extra: object = {}) => ({ name, type: 'material', reward_quantity: 1, stock: '1', price: 40, icon: 'white_square', ...extra });
const now = Date.parse('2026-09-23T00:00:00Z');

test('CN reward names map to official EN names by game ID only, never by guessing', () => {
  const names = rewardNames(cn, en);
  assert.equal(names.get('制式木盆'), 'Standard Wooden Basin');
  assert.equal(names.get('“烛火之中”'), "'V Plameni Svechi'");
  assert.equal(names.get('龙门币'), 'LMD');
  assert.equal(names.get('“回看”高脚凳'), null, 'not in the EN client yet');
  assert.equal(names.get('同名家具'), null, 'two IDs with different EN names');
  assert.equal(names.has('"烛火之中"'), false, 'straight quotes are not the table name');
});

test('an event is renamed once it has started on Global, keeping the CN name and the published icon', () => {
  const events: any[] = [
    { name: '[Side Story] People, A People', global: { dateRange: '2026/09/16–2026/09/30', startAt: '2026-09-16T15:00:00.000Z' },
      rewards: store([item('制式木盆'), item('“烛火之中”'), item('Headhunting Permit'), item('Infiltrator', { type: 'skin' }), item('“回看”高脚凳')]) },
    { name: '[Celebration] Critical Phase Transition', global: { dateRange: '2026/10/14–2026/10/28' }, rewards: store([item('制式木盆')]) },
    { name: 'Unannounced', global: { dateRange: null }, rewards: [store([item('制式木盆')])] },
  ];
  const published = new Set(['制式木盆.webp', '“烛火之中”.webp', 'Headhunting Permit.webp']);
  const { events: next, renamed, unknown } = localizeRewards(events, rewardNames(cn, en), published, now);
  const items = next[0].rewards.items;
  assert.deepEqual(items.map((i: any) => [i.name, i.cnName, i.iconName]), [
    ['Standard Wooden Basin', '制式木盆', '制式木盆'],
    ["'V Plameni Svechi'", '“烛火之中”', '“烛火之中”'],
    ['Headhunting Permit', undefined, undefined],
    ['Infiltrator', undefined, undefined],
    ['“回看”高脚凳', undefined, undefined],
  ]);
  assert.equal(items[0].price, 40);
  assert.equal(renamed.length, 2);
  assert.deepEqual(unknown, []);
  // Not started on Global: untouched, whatever the EN tables already hold.
  assert.equal(next[1].rewards.items[0].name, '制式木盆');
  assert.equal(next[2].rewards[0].items[0].name, '制式木盆');
  // The input is not mutated, and a second run changes nothing.
  assert.equal(events[0].rewards.items[0].name, '制式木盆');
  assert.deepEqual(localizeRewards(next, rewardNames(cn, en), published, now).events, next);
  // Once the EN-named copy is published the item shows it, and only then.
  const withEnglish = new Set([...published, iconFile('Standard Wooden Basin'), iconFile("'V Plameni Svechi'")]);
  const after = localizeRewards(next, rewardNames(cn, en), withEnglish, now).events[0].rewards.items;
  assert.deepEqual(after.slice(0, 2).map((i: any) => [i.name, i.cnName, i.iconName]),
    [['Standard Wooden Basin', '制式木盆', undefined], ["'V Plameni Svechi'", '“烛火之中”', undefined]]);
});

test('a Chinese reward name in neither CN table is reported rather than renamed', () => {
  const typo = [{ name: '[Side Story] People, A People', global: { startAt: '2026-09-16T15:00:00.000Z' }, rewards: store([item('"烛火之中"')]) }];
  const result = localizeRewards(typo, rewardNames(cn, en), new Set(), now);
  assert.deepEqual(result.unknown, ['[Side Story] People, A People: "烛火之中"']);
  assert.equal(result.events[0].rewards.items[0].name, '"烛火之中"');
  // Not yet on Global, a CN-only name is expected and is nobody's error.
  assert.deepEqual(localizeRewards([{ ...typo[0], global: { dateRange: '2027/01/17–2027/02/06' } }], rewardNames(cn, en), new Set(), now).unknown, []);
});

test('the sync renames what it can and keeps a name in neither CN table, reporting it instead of failing the run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-rewards-'));
  try {
    // The sync refuses tables this small as truncated, so pad them to the live sizes.
    const padded = (rows: Record<string, { name: string }>) => ({ ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`pad_${i}`, { name: `pad ${i}` }])), ...rows });
    const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(value)); };
    for (const [region, tables] of [['cn', cn], ['en', en]] as const) {
      write(`${region}/item_table.json`, { items: padded(tables.items.items) });
      write(`${region}/building_data.json`, { customData: { furnitures: padded(tables.building.customData.furnitures) } });
    }
    write('data/assets/external-asset-index.json', { files: ['material-icons/制式木盆.webp'] });
    write('data/events/events_2026.json', [{ name: '[Side Story] People, A People', global: { startAt: '2026-09-16T15:00:00.000Z' }, rewards: store([item('制式木盆'), item('"烛火之中"')]) }]);
    const { renamed, unknown } = syncRewardNames(root, path.join(root, 'cn'), path.join(root, 'en'), now);
    assert.deepEqual([renamed, unknown], [['[Side Story] People, A People: 制式木盆 -> Standard Wooden Basin'], ['[Side Story] People, A People: "烛火之中"']]);
    const items = JSON.parse(fs.readFileSync(path.join(root, 'data/events/events_2026.json'), 'utf8'))[0].rewards.items;
    assert.deepEqual(items.map((i: any) => i.name), ['Standard Wooden Basin', '"烛火之中"']);
    const { entries } = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8'));
    assert.deepEqual(entries.map((e: any) => [e.key, e.stage, e.action, e.firstSeen]), [['reward:[Side Story] People, A People: "烛火之中"', 'reward-names', 'kept-previous', '2026-09-23']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Global start is the client window when known, else the announced UTC−7 day', () => {
  // The window localizeRewards reads (scripts/lib/event-records.mjs).
  assert.equal(eventWindow({ global: { startAt: '2026-09-16T15:00:00.000Z', dateRange: '2026/09/16–2026/09/30' } }, 'Global').start, Date.parse('2026-09-16T15:00:00.000Z'));
  assert.equal(eventWindow({ global: { dateRange: '2026/10/14–2026/10/28' } }, 'Global').start, Date.parse('2026-10-14T07:00:00.000Z'));
  assert.equal(eventWindow({ global: { dateRange: null } }, 'Global'), null);
  assert.equal(iconFile('Chimed "Tapestry"/Rack?'), 'Chimed TapestryRack.webp');
});
