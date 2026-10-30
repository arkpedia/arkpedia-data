import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Node scripts are plain JavaScript.
import { assertEventRewards, buildEventRewards, rewardNamer, storeFurnitureNames, storeNameTranslations } from '../build/build-event-rewards.mjs';
// @ts-expect-error Node scripts are plain JavaScript.
import { eventTitle, eventWindow } from '../lib/event-records.mjs';

/*
 * The rewards the game tables list for an event beyond its store (build-event-rewards.mjs),
 * held to a community compilation of Invitation to Wine (Global, 2022-07-29): its login event
 * gave 3 Originite Prime, 600 Orundum and 2 Headhunting Permits, and its stages 28 Originite
 * Prime on first clear. The fixture is cut from the Global tables at the pinned commit.
 */
const fixture = JSON.parse(fs.readFileSync('scripts/tests/fixtures/event-rewards-invitation-to-wine.json', 'utf8'));
type Item = { name: string; count: number; kind: string };
type Group = { kind: string; title: string; source: string; items: Item[]; days?: number; count?: number; daily?: Item[][]; rules?: string[] };

test('Invitation to Wine: the login event, the banner gift, the missions and the first clears, as the compilation counts them', () => {
  const result = buildEventRewards([fixture.event], fixture.tables, [], null);
  const event = result[fixture.event.name] as { activity: string; groups: Group[] };
  assert.equal(event.activity, 'act15side');
  const group = (kind: string) => event.groups.find(g => g.kind === kind)!;
  const count = (g: Group, name: string) => g.items.find(i => i.name === name)?.count ?? 0;

  const login = group('login');
  assert.equal(login.source, 'activity_table act25sign');
  assert.deepEqual([count(login, 'Originite Prime'), count(login, 'Orundum'), count(login, 'Headhunting Permit')], [3, 600, 2]);
  assert.equal(login.daily!.length, login.days);
  assert.equal(login.daily!.flat().filter(i => i.name === 'Orundum').reduce((n, i) => n + i.count, 0), 600, 'the days add up to the total');

  const firstClear = group('first-clear');
  assert.deepEqual([firstClear.count, count(firstClear, 'Originite Prime')], [28, 28]);

  assert.deepEqual(group('banner-gift').items.map(i => [i.name, i.count, i.kind]), [['Sing while Drinking Headhunting Permit (ten-roll)', 1, 'permit']]);
  assert.ok(group('missions').items.some(i => i.name === 'Kroos the Keen Glint' && i.kind === 'operator'));
  // A draw login is named, with its rules, and never given a made-up payout.
  assert.deepEqual(group('pray').items, []);
  assert.ok(group('pray').rules!.length > 0);
});

test('an event is matched to its own activity by name and Global start, not by a neighbour', () => {
  assert.equal(eventTitle('[Side Story – Festival] Invitation to Wine'), 'Invitation to Wine');
  // The start the build matches by (scripts/lib/event-records.mjs): the UTC-7 day, in milliseconds.
  assert.equal(eventWindow({ global: { dateRange: '2022/07/29–2022/08/12' } }, 'Global').start, Date.UTC(2022, 6, 29, 7));
  assert.equal(eventWindow({ global: { dateRange: '' } }, 'Global'), null);
  // A week off: not this event's activity, so nothing is attached.
  const late = { ...fixture.event, global: { dateRange: '2022/08/20–2022/09/01' } };
  assert.deepEqual(buildEventRewards([late], fixture.tables, [], null), {});
  // A rerun spelled "X Rerun" in the records matches the tables' "X - Rerun".
  const tables = structuredClone(fixture.tables);
  tables.activity.basicInfo.act15side.name = 'Invitation to Wine - Rerun';
  assert.ok(buildEventRewards([{ ...fixture.event, name: '[Rerun] Invitation to Wine Rerun' }], tables, [], null)['[Rerun] Invitation to Wine Rerun']);
});

test('an official announcement\'s packs belong to the event it announces, and to no other', () => {
  const post = JSON.parse(fs.readFileSync('scripts/tests/fixtures/official-news/4635.json', 'utf8'));
  const people = { name: '[Side Story] People, A People', global: { dateRange: '2026/09/16–2026/09/30' } };
  const other = { name: '[Side Story] Somewhere Else', global: { dateRange: '2026/09/16–2026/09/30' } };
  const empty = { activity: { basicInfo: {}, activity: {}, missionData: [] }, stages: { stages: {} }, items: { items: {} }, building: { customData: { furnitures: {}, themes: {} } }, characters: {}, skins: { charSkins: {} } };
  const result = buildEventRewards([people, other], empty, [post], null);
  assert.equal(result[other.name], undefined, 'a same-day event the post does not name gets nothing');
  const packs = (result[people.name].groups as Group[]).filter(g => g.kind === 'packs');
  assert.ok(packs.length >= 1);
  assert.equal((packs[0] as Group & { source: string }).source, 'https://www.arknights.global/news/4635');
  // A week later: not this post's event.
  assert.deepEqual(buildEventRewards([{ ...people, global: { dateRange: '2026/09/23–2026/10/07' } }], empty, [post], null), {});
});

test('a rerun shows its original run\'s missions, first clears and furniture until its own are out', () => {
  const rerun = { name: '[Rerun] Invitation to Wine Rerun', global: { dateRange: '2099/01/01–2099/01/10' } };
  const result = buildEventRewards([fixture.event, rerun], fixture.tables, [], null);
  const entry = result[rerun.name] as { inheritsFrom: string; groups: (Group & { inherited?: string })[] };
  assert.equal(entry.inheritsFrom, fixture.event.name);
  assert.deepEqual(entry.groups.map(g => g.kind).sort(), ['first-clear', 'missions']);
  assert.ok(entry.groups.every(g => g.inherited === fixture.event.name));
  // Never the original's dated sign-in or gifts: those were the original run's days.
  assert.ok(!entry.groups.some(g => g.kind === 'login' || g.kind === 'banner-gift'));
  assert.throws(() => buildEventRewards([fixture.event], fixture.tables, [], undefined), /CN tables/);
});

test('an event Global has not had yet is built from the CN tables, with Global names where Global has the item', () => {
  // The fixture's tables standing in for the CN client: the same activity, on a CN date, with Global
  // having none of it.
  const cnTables = structuredClone(fixture.tables);
  const upcoming = { name: '[Celebration] Somewhere New', global: { dateRange: '2099/01/01–2099/01/10' }, cn: { dateRange: '2022/07/29–2022/08/12' } };
  const global = { ...fixture.tables, activity: { basicInfo: {}, activity: {}, missionData: [] }, stages: { stages: {} } };
  const result = buildEventRewards([upcoming], global, [], cnTables);
  const entry = result[upcoming.name] as { region: string; groups: (Group & { region?: string })[] };
  assert.equal(entry.region, 'CN');
  assert.ok(entry.groups.length > 0 && entry.groups.every(g => g.region === 'CN'));
  assert.ok(entry.groups.find(g => g.kind === 'login')!.items.some(i => i.name === 'Orundum'), 'an item Global has is named in English');
  // A Global event already dated in the past is never built from CN.
  assert.deepEqual(buildEventRewards([{ ...upcoming, global: { dateRange: '2001/01/01–2001/01/10' } }], global, [], cnTables), {});
});

/* A small world of tables for the rules below: one day, two events opening on it. */
const day = Date.UTC(2026, 0, 6, 15) / 1000;
const reward = (id: string, count: number, type = 'MATERIAL') => ({ id, count, type });
const world = () => ({
  activity: {
    basicInfo: {
      actstory: { id: 'actstory', type: 'TYPE_ACT9D0', name: 'A Story', startTime: day, endTime: day + 14 * 86400 },
      actduel: { id: 'actduel', type: 'ENEMY_DUEL', name: 'Duel Channel: Vine', startTime: day, endTime: day + 21 * 86400 },
      actsign: { id: 'actsign', type: 'CHECKIN_ONLY', name: 'Limited-time Cumulative Sign-In', startTime: day - 3600, endTime: day + 14 * 86400 },
      actbless: { id: 'actbless', type: 'BLESS_ONLY', name: '2026 Festival Sign-In', startTime: day, endTime: day + 14 * 86400 },
    },
    homeActConfig: { actsign: { actTopBarText: 'Coming of Blessings Sign-In Event' } },
    activity: {
      CHECKIN_ONLY: { actsign: { checkInList: { 0: { order: 1, itemList: [reward('4003', 200, 'DIAMOND_SHD')] } } } },
      ENEMY_DUEL: { actduel: { milestoneList: [{ tokenNum: 100, reward: reward('4001', 10000, 'GOLD') }, { tokenNum: 200, reward: reward('30013', 2) }], constData: { milestonePlanName: 'Vine Program', milestoneItemId: 'duel_point' } } },
    },
    missionData: [],
    zoneToActivity: { actstory_zone1: 'actstory', actduel_zone1: 'actduel' },
  },
  stages: { stages: {
    actstory_01: { stageId: 'actstory_01', zoneId: 'actstory_zone1', stageDropInfo: { displayDetailRewards: [{ type: 'DIAMOND', id: '4002', dropType: 'COMPLETE' }] } },
    actduel_01a: { stageId: 'actduel_01a', zoneId: 'actduel_zone1', stageDropInfo: { displayDetailRewards: [{ type: 'DIAMOND', id: '4002', dropType: 'COMPLETE' }] } },
  } },
  items: { items: { 4001: { name: 'LMD' }, 4002: { name: 'Originite Prime' }, 4003: { name: 'Orundum' }, 30013: { name: 'Orirock Cube' }, duel_point: { name: 'Grand Duel Fireworks' } } },
  building: { customData: { furnitures: {}, themes: {} } }, characters: {}, skins: { charSkins: {} },
});
const story = { name: '[Side Story] A Story', global: { dateRange: '2026/01/06–2026/01/20' } };
const duel = { name: 'Duel Channel: Vine', global: { dateRange: '2026/01/06–2026/01/27' } };
const post = (title: string, sections: string[][]) => ({ title, url: 'https://example.invalid/news/1', lines: [`DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)`, ...sections.flat()] });

test('generated furniture groups retain the stable theme ID through rerun inheritance', () => {
  const tables = world();
  const id = 'furni_set_workshop';
  (tables.building.customData.themes as Record<string, object>)[id] = { id, name: 'Workshop', desc: 'Official description' };
  const rerun = { name: '[Rerun] A Story Rerun', global: { dateRange: '2027/01/06–2027/01/20' } };
  const result = buildEventRewards([story, rerun], tables, [post('SIDESTORY: A STORY OPEN', [['01 FURNITURE SET – WORKSHOP', 'DETAILS: available']])], null);
  const original = result[story.name].groups.find((group: { kind: string }) => group.kind === 'furniture-set');
  const repeated = result[rerun.name].groups.find((group: { kind: string }) => group.kind === 'furniture-set');
  assert.equal(original.themeId, id);
  assert.equal(repeated.themeId, id);
  assert.equal(repeated.inherited, story.name);
});

test('a mode\'s rewards are its milestones, never first clears its "stages" list', () => {
  const result = buildEventRewards([story, duel], world(), [], null);
  const kinds = (name: string) => (result[name].groups as Group[]).map(g => g.kind);
  assert.ok(kinds(story.name).includes('first-clear'));
  assert.ok(!kinds(duel.name).includes('first-clear'), 'Duel Channel gives no first-clear Originite Prime');
  const milestones = (result[duel.name].groups as Group[]).find(g => g.kind === 'milestones')!;
  assert.equal(milestones.title, 'Vine Program: 2 steps, up to 200 Grand Duel Fireworks');
  assert.deepEqual(milestones.items.map(i => [i.name, i.count]), [['LMD', 10000], ['Orirock Cube', 2]]);
});

test('a login opening hours before its event is that event\'s, and an announcement settles a day two events share', () => {
  // The sign-in opens an hour before both, which open together: by date alone it is the story
  // event's, in whichever order the records list the two.
  const owner = (r: Record<string, { groups: Group[] }>) => Object.entries(r).find(([, v]) => v.groups.some(g => g.kind === 'login'))?.[0];
  assert.equal(owner(buildEventRewards([story, duel], world(), [], null)), story.name);
  assert.equal(owner(buildEventRewards([duel, story], world(), [], null)), story.name);
  // The story's announcement names it: it is the story's, whatever the order.
  const announced = buildEventRewards([duel, story], world(), [post('SIDESTORY: A STORY OPEN', [['01 SIDESTORY: A STORY OPEN', 'DETAILS: x'], ['02 COMING OF BLESSINGS LOGIN EVENT OPEN', 'DURATION: January 6, 2026, 07:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: log in']])], null);
  assert.equal(owner(announced), story.name);
});

test('an announced login the tables give no rewards for is kept as worded; one they detail is not repeated; free rolls are counted by day', () => {
  const result = buildEventRewards([story], world(), [post('SIDESTORY: A STORY OPEN', [
    ['01 SIDESTORY: A STORY OPEN', 'DETAILS: x'],
    ['02 COMING OF BLESSINGS LOGIN EVENT OPEN', 'DURATION: January 6, 2026, 07:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: log in'],
    ['03 2026 FESTIVAL SIGN-IN', 'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: a blessing a day'],
    ['04 LIMITED-TIME DAILY FREE ROLL EVENT OPEN', 'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: a free roll every day'],
  ])], null);
  const groups = result[story.name].groups as (Group & { lines?: string[] })[];
  const notices = groups.filter(g => g.kind === 'notice').map(g => g.title);
  assert.deepEqual(notices, ['2026 FESTIVAL SIGN-IN'], 'the festival sign-in, which no table details; not the sign-in the tables do');
  assert.deepEqual(groups.find(g => g.kind === 'free-rolls')!.items.map(i => [i.name, i.count]), [['Daily free headhunting roll', 14]]);
});

test('a login the post names differently from the tables is the same login over the same window; a festival sign-in sharing the banner gift\'s window is not', () => {
  const tables = world();
  // The sign-in table now runs exactly the post's window, for 7 days.
  tables.activity.basicInfo.actsign = { ...tables.activity.basicInfo.actsign, startTime: day, endTime: day + 14 * 86400 - 4 * 3600 - 1 };
  (tables.activity.activity.CHECKIN_ONLY.actsign as { checkInList: object }).checkInList = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { order: i + 1, itemList: [reward('4003', 100, 'DIAMOND_SHD')] }]));
  const window = 'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)';
  const result = buildEventRewards([story], tables, [post('SIDESTORY: A STORY OPEN', [
    ['01 SIDESTORY: A STORY OPEN', 'DETAILS: x'],
    ['02 LUMINOUS DAYLIGHT LIMITED-TIME LOGIN EVENT OPEN', window, 'DETAILS: During the event, players can log in for 7 days to earn the following rewards:'],
    ['03 BRIGHT NOON LIMITED-TIME LOGIN EVENT OPEN', window, 'DETAILS: During the event, players can log in for 10 days to earn the following rewards:'],
  ])], null);
  const notices = (result[story.name].groups as Group[]).filter(g => g.kind === 'notice').map(g => g.title);
  assert.deepEqual(notices, ['BRIGHT NOON LIMITED-TIME LOGIN EVENT OPEN'], 'the 7-day one is the table\'s sign-in; a 10-day one is not');
});

test('one post\'s two sections under one heading are one pack list', () => {
  const packs = (name: string) => [`${name.toUpperCase()} PACK`, 'SALES PERIOD: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', 'CONTENTS: Orundum * 1,600'];
  const result = buildEventRewards([story], world(), [post('SIDESTORY: A STORY OPEN', [
    ['01 SIDESTORY: A STORY OPEN', 'DETAILS: x'],
    ['02 LIMITED-TIME PACKS AVAILABLE', ...packs('Vista')],
    ['03 LIMITED-TIME PACKS AVAILABLE', ...packs('Moonlight')],
  ])], null);
  const groups = (result[story.name].groups as (Group & { packs?: { name: string }[] })[]).filter(g => g.kind === 'packs');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].packs!.map(pack => pack.name), ['VISTA PACK', 'MOONLIGHT PACK']);
});

test('one post\'s two notices or free rolls under one heading are one group, its lines each once', () => {
  const gift = (details: string) => ['ANNIVERSARY GIFTS', 'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', `DETAILS: ${details}`];
  const roll = ['LIMITED-TIME DAILY FREE ROLL EVENT OPEN', 'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: a free roll every day'];
  const sections = [['01 SIDESTORY: A STORY OPEN', 'DETAILS: x'], ['02 ' + gift('a gift')[0], ...gift('a gift').slice(1)], ['03 ' + gift('a second gift')[0], ...gift('a second gift').slice(1)],
    ['04 ' + roll[0], ...roll.slice(1)], ['05 ' + roll[0], ...roll.slice(1)]];
  const result = buildEventRewards([story], world(), [post('SIDESTORY: A STORY OPEN', sections)], null);
  const groups = result[story.name].groups as (Group & { lines?: string[] })[];
  assert.doesNotThrow(() => assertEventRewards(result), 'no heading twice');
  assert.deepEqual(groups.filter(g => g.kind === 'notice').map(g => [g.title, g.lines]), [['ANNIVERSARY GIFTS', [
    'DURATION: January 6, 2026, 08:00 – January 20, 2026, 03:59 (UTC-7)', 'DETAILS: a gift', 'DETAILS: a second gift']]]);
  assert.deepEqual(groups.filter(g => g.kind === 'free-rolls').map(g => g.items[0].count), [14]);
});

test('cosmetics, cart parts, charms and NONE-typed furniture are named as the official posts word them', () => {
  const name = rewardNamer({
    items: { items: {} },
    building: { customData: { furnitures: { furni_plaque: { name: 'Plaque - Sunset' } } } },
    displayMeta: {
      playerAvatarData: { avatarList: [{ avatarId: 'avatar_activity_ED3', avatarItemName: "'ALL IN!'" }, { avatarId: 'avatar_cn', avatarItemName: '“弦月”' }] },
      homeBackgroundData: { homeBgDataList: [{ bgId: 'bg_flower', bgName: 'Flowerbed' }], themeList: [{ id: 'tm_arcade_1', tmName: 'Poly Vision' }] },
      nameCardV2Data: { skinData: { nc_landscape_1: { id: 'nc_landscape_1', name: 'Vista' } } },
    },
    // charm_table's own shape (a charmList), as the stage pipeline reads it; a bare list reads too.
    charms: { charmList: [{ id: 'charm_coin_1', name: 'Gold Chip' }] },
    activity: { carData: { carDict: { durcar_soft_5_sp: { compId: 'durcar_soft_5_sp', name: "'Infinite Fist'" } } } },
  });
  const named = (id: string, type = 'NONE') => name({ id, type, count: 1 }).name;
  assert.equal(named('avatar_activity_ED3', 'PLAYER_AVATAR'), "Icon 'ALL IN!'");
  assert.equal(named('avatar_cn', 'PLAYER_AVATAR'), "Icon '弦月'");
  assert.equal(named('bg_flower', 'HOME_BACKGROUND'), "Main Menu Background 'Flowerbed'");
  assert.equal(named('tm_arcade_1', 'HOME_THEME'), "Home Screen UI 'Poly Vision'");
  assert.equal(named('nc_landscape_1', 'NAME_CARD_SKIN'), "Profile Theme 'Vista'");
  assert.equal(named('charm_coin_1', 'CHARM'), 'Gold Chip');
  assert.equal(rewardNamer({ charms: [{ id: 'charm_coin_1', name: 'Gold Chip' }] })({ id: 'charm_coin_1', type: 'CHARM', count: 1 }).name, 'Gold Chip');
  assert.equal(named('durcar_soft_5_sp', 'ACT_CART_COMPONENT'), "'Infinite Fist'");
  assert.deepEqual([named('furni_plaque'), name({ id: 'furni_plaque', type: 'NONE', count: 1 }).kind], ['Plaque - Sunset', 'furniture']);
});

test('the output guard stops an id shown as a name, a leftover entity and a heading shown twice', () => {
  const event = (groups: object[]) => ({ e: { activity: null, groups } });
  assert.throws(() => assertEventRewards(event([{ kind: 'login', title: 'x', items: [{ name: 'avatar_activity_ED3', id: 'avatar_activity_ED3', count: 1 }] }])), /no table names/);
  assert.throws(() => assertEventRewards(event([{ kind: 'packs', title: 'x', items: [], packs: [{ name: "Profile Theme &apos;Vista&apos;" }] }])), /HTML entity/);
  assert.throws(() => assertEventRewards(event([{ kind: 'packs', title: 'x', items: [], packs: [{ name: 'Amiya&reg; Pack' }] }])), /HTML entity/);
  // Text that only looks like one is not: no character beyond U+10FFFF, no name HTML lacks.
  assert.doesNotThrow(() => assertEventRewards(event([{ kind: 'notice', title: 'x', items: [], lines: ['R&D; &#x110000; &bogus;'] }])));
  assert.throws(() => assertEventRewards(event([{ kind: 'packs', title: 'A', items: [] }, { kind: 'packs', title: 'A', items: [] }])), /two "packs: A"/);
  assert.doesNotThrow(() => assertEventRewards(event([{ kind: 'login', title: 'x', items: [{ name: 'LMD', id: '4001', count: 1 }] }])));
});

test('a mission reward of none, the label beside the furniture it names, is not listed', () => {
  const tables = world();
  tables.activity.missionData = [{ id: 'm1', missionGroup: 'actstory', rewards: [{ type: 'FURN', id: 'furni_drum', count: 1 }, { type: 'NONE', id: "'Symphony of Drums'", count: 0 }] }] as never;
  (tables.building.customData.furnitures as Record<string, object>).furni_drum = { name: "'Symphony of Drums'" };
  const result = buildEventRewards([story], tables, [], null);
  const missions = (result[story.name].groups as Group[]).find(g => g.kind === 'missions')!;
  assert.deepEqual(missions.items.map(i => [i.name, i.count]), [["'Symphony of Drums'", 1]]);
});

test('the fallback store\'s helpers: a CN name Global names becomes its English name, one it does not stays, and a piece listed as an item is furniture', () => {
  const cn = {
    building: { customData: { furnitures: { furni_basin: { name: '制式木盆' }, furni_new: { name: '新型信息终端机' } } } },
    items: { items: { 4001: { name: '龙门币' }, cn_only: { name: '烛火之中' } } },
  };
  const en = { building: { customData: { furnitures: { furni_basin: { name: 'Standard Wooden Basin' } } } }, items: { items: { 4001: { name: 'LMD' } } } };
  const events = [{ name: 'E', rewards: [{ items: [{ name: '制式木盆' }, { name: '龙门币' }, { name: '烛火之中' }, { name: '新型信息终端机' }, { name: 'Standard Wooden Basin' }, { name: 'Orundum' }] }] }];
  assert.deepEqual(storeNameTranslations(events, cn, en), { '制式木盆': 'Standard Wooden Basin', '龙门币': 'LMD' });
  // Furniture in either client, by either name, though the import lists them as plain items.
  assert.deepEqual(storeFurnitureNames(events, cn, en), ['Standard Wooden Basin', '制式木盆', '新型信息终端机']);
});

test('on a day the CN tables number their enums, the entries built from CN stay as the last run wrote them', () => {
  // The stage itself, on tables with nothing in them: what an entry built from CN looks like
  // afterwards is all that depends on the day's CN tables.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-event-rewards-'));
  try {
    const write = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(data)); };
    const empty = { 'activity_table.json': { basicInfo: {} }, 'stage_table.json': { stages: {} }, 'item_table.json': { items: {} }, 'building_data.json': { customData: { furnitures: {}, themes: {} } },
      'character_table.json': {}, 'skin_table.json': { charSkins: {} }, 'display_meta_table.json': {}, 'charm_table.json': { charmList: [] } };
    for (const [file, data] of Object.entries(empty)) { write(`en/en/gamedata/excel/${file}`, data); write(`cn/gamedata/excel/${file}`, data); }
    const upcoming = { name: '[Side Story] Somewhere New', global: { dateRange: '2099/01/01–2099/01/10' }, cn: { dateRange: '2026/09/01–2026/09/15' } };
    write('data/events/events_2099.json', [upcoming]);
    const built = { activity: 'act99side', region: 'CN', groups: [{ kind: 'missions', title: 'Event missions', source: 'CN activity_table missionData act99side', region: 'CN', count: 1, items: [{ name: 'LMD', count: 1000, kind: 'currency', id: '4001' }] }] };
    write('data/event-rewards.json', { events: { [upcoming.name]: built } });
    const stage = (serialization: string) => {
      const run = spawnSync(process.execPath, [path.resolve('scripts/build/build-event-rewards.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env,
        ARKPEDIA_EN: path.join(root, 'en'), ARKPEDIA_CN: path.join(root, 'cn'),
        ARKPEDIA_CN_TABLES: JSON.stringify({ repository: 'yuanyan3060/ArknightsGameResource', commit: '3'.repeat(40), folder: 'gamedata', serialization }) } });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      return JSON.parse(fs.readFileSync(path.join(root, 'data/event-rewards.json'), 'utf8')).events;
    };
    assert.deepEqual(stage('numeric')[upcoming.name], built, 'kept: numbered enums would misread every group');
    // Read by name, the day's (empty) CN tables are the truth.
    assert.equal(stage('named')[upcoming.name], undefined);
    // An event an official post already names (its gifts, ahead of its Global start) has an entry
    // before the CN groups are added: it takes them back in, beside the post's own.
    const window = 'DURATION: January 1, 2099, 10:00 – January 10, 2099, 03:59 (UTC-7)';
    write('data/official-news/global/1.json', { id: 1, title: 'SIDESTORY: SOMEWHERE NEW OPEN', url: 'https://example.invalid/news/1',
      lines: [window, '01 SIDESTORY: SOMEWHERE NEW OPEN', 'DETAILS: x', '02 ANNIVERSARY GIFTS', window, 'DETAILS: a gift'] });
    const gifts = { kind: 'notice', title: 'ANNIVERSARY GIFTS', source: 'https://example.invalid/news/1', items: [], lines: [window, 'DETAILS: a gift'] };
    write('data/event-rewards.json', { events: { [upcoming.name]: built } });
    assert.deepEqual(stage('numeric')[upcoming.name], { ...built, groups: [...built.groups, gifts] }, 'kept beside the post\'s');
    assert.deepEqual(stage('numeric')[upcoming.name], { ...built, groups: [...built.groups, gifts] }, 'and the same the day after');
    assert.deepEqual(stage('named')[upcoming.name], { activity: null, groups: [gifts] });
    // An event Global has started is Global's on either day, whatever the last run built for it from
    // CN: a numbered day keeps only what a named day would build (awaitsGlobal), so the two agree.
    const launched = { name: '[Side Story] Somewhere Old', global: { dateRange: '2020/01/01–2020/01/10' }, cn: { dateRange: '2019/09/01–2019/09/15' } };
    write('data/events/events_2099.json', [upcoming, launched]);
    write('data/event-rewards.json', { events: { [upcoming.name]: built, [launched.name]: { ...built, activity: 'act98side' } } });
    const numbered = stage('numeric');
    assert.equal(numbered[launched.name], undefined, 'not kept: its Global start has passed');
    assert.deepEqual(numbered[upcoming.name], { ...built, groups: [...built.groups, gifts] }, 'the one still ahead is');
    assert.equal(stage('named')[launched.name], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('official daily sign-in totals and selector lists work before the Global patch tables arrive', () => {
  const post = JSON.parse(fs.readFileSync('scripts/tests/fixtures/official-news/4814.json', 'utf8'));
  const event = { name: '[Celebration] Critical Phase Transition', global: { dateRange: '2026/10/14–2026/10/28' } };
  const tables = { ...world(), activity: { basicInfo: {}, activity: {}, missionData: [] } };
  const result = buildEventRewards([event], tables, [post], null)[event.name];
  const login = result.groups.find((g: Group) => g.kind === 'login');
  assert.equal(login.daily.length, 10);
  assert.equal(login.items.find((i: Item) => i.name === 'Orundum').count, 600);
  assert.equal(login.items.find((i: Item) => i.name === 'LMD').count, 30000);
  assert.equal(login.items.find((i: Item) => i.name === 'New Model Data Terminal').iconName, 'New Information Terminal');
  assert.equal(login.items.find((i: Item) => i.name === 'A Sealed Vow Headhunting Permit').iconName, 'A Sealed Vow Headhunting Permit (ten-roll)');
  const packs = result.groups.find((g: Group) => g.kind === 'packs');
  assert.equal(packs.tickets['Top Operator Transfer Permit'].operators.length, 35);
  assert.equal(packs.packs.length, 16);
});

test('a pending Global rerun uses its own CN mission inventory instead of the original run', () => {
  const cn = structuredClone(fixture.tables);
  const source = cn.activity.basicInfo.act15side;
  cn.activity.basicInfo.act15side = { ...source, id: 'act15sre', isReplicate: true };
  cn.activity.missionData = cn.activity.missionData.map((m: { missionGroup: string }) => ({ ...m, missionGroup: m.missionGroup === 'act15side' ? 'act15sre' : m.missionGroup }));
  const rerun = { name: '[Rerun] Invitation to Wine Rerun', activityId: 'act15sre', global: { dateRange: '2099/01/01–2099/01/10' }, cn: fixture.event.global };
  const entry = buildEventRewards([fixture.event, rerun], fixture.tables, [], cn)[rerun.name];
  assert.equal(entry.activity, 'act15sre');
  assert.equal(entry.region, 'CN');
  assert.equal(entry.inheritsFrom, undefined);
  assert(entry.groups.some((g: {kind: string}) => g.kind === 'missions'));
  assert(entry.groups.every((g: {inherited?: string}) => !g.inherited));
});

test("a rerun's copy of an event token takes the original's name until Global's table carries the copy", () => {
  const name = rewardNamer({ items: { items: {
    act42side_token_pacifier: { name: 'Enlightened Pacifier' },
    act12side_token_coupon_rep_1: { name: "Mama John's Voucher (rerun)" },
  } } });
  assert.equal(name({ id: 'act42side_token_pacifier_rep_1', type: 'ACTIVITY_ITEM', count: 4000 }).name, 'Enlightened Pacifier', "The Masses' Travels Rerun, 2026-10-28");
  assert.equal(name({ id: 'act12side_token_coupon_rep_1', type: 'ACTIVITY_ITEM', count: 1 }).name, "Mama John's Voucher (rerun)", 'the copy\'s own name wins once the table has it');
  assert.equal(name({ id: 'act99side_token_unknown_rep_1', type: 'ACTIVITY_ITEM', count: 1 }).name, 'act99side_token_unknown_rep_1', 'an unknown original stays unnamed, and the build still refuses it');
});
