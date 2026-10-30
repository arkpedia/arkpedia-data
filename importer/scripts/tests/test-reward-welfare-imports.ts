import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreeRewards } from '../build/build-free-rewards.mjs';

/*
 * Excerpts of the Global EN tables as the import reads them (ArknightsAssets/ArknightsGamedata,
 * 2026-10-21): the ids, windows and shapes are the client's own, trimmed to the rows that matter.
 * What a reader's save and roster then tick on these rows, and which of them the Reward Tracker
 * still lists, is the application's (arkpedia-app scripts/tests/test-reward-welfare-imports.ts).
 */
const item = (id: string, count: number, type = 'MATERIAL') => ({ id, count, type });
const mission = (id: string, type: string, missionGroup: string, description: string, rewards: unknown[]) => ({ id, type, missionGroup, description, rewards });
const signIn = (order: number, itemList: unknown[]) => ({ order, itemList, isDynItem: false });
const celebrationDays = [[item('LIMITED_TKT_GACHA_10_7301', 1, 'LIMITED_TKT_GACHA_10'), item('ap_supply_lt_120', 1, 'AP_SUPPLY')], [item('char_4227_gallus', 1, 'CHAR'), item('7001', 5, 'TKT_RECRUIT')]];

function tables(overrides: { missions?: Record<string, unknown> } = {}) {
  return {
    handbook: { handbookStageData: {} },
    characters: { char_4226_veen: { name: 'Viy', rarity: 'TIER_6' }, char_4223_botany: { name: 'Botani', rarity: 'TIER_5' }, char_4227_gallus: { name: 'GALLUS²', rarity: 'TIER_1' },
      char_333_sidero: { name: 'Sideroca', rarity: 'TIER_5' }, char_345_folnic: { name: 'Folinic', rarity: 'TIER_5' }, char_131_flameb: { name: 'Flamebringer', rarity: 'TIER_5' } },
    items: { items: { '4001': { name: 'LMD' }, '4003': { name: 'Orundum' }, '7001': { name: 'Recruitment Permit' } } },
    missions: { missions: overrides.missions ?? {
      main_1: mission('main_1', 'MAIN', 'main_1', 'Clear 0-1', [item('4001', 1000, 'GOLD')]),
      guide_1: mission('guide_1', 'GUIDE', 'guide_g_1', 'Pinboard 1', [item('4003', 100, 'DIAMOND_SHD')]),
      act4mainssPermanent_4: mission('act4mainssPermanent_4', 'RETRO', 'permanent_main_3_One_Day_More', 'Clear 17-12', [item('31103', 3)]),
      act4mainssPermanent_5: mission('act4mainssPermanent_5', 'RETRO', 'permanent_main_3_One_Day_More', 'Clear 17-13', [item('char_4226_veen', 1, 'CHAR')]),
    }, missionGroups: { guide_g_1: { id: 'guide_g_1', type: 'GUIDE', title: 'Phase 1', rewards: [item('7003', 1, 'TKT_GACHA')] } } },
    openServer: {
      schedule: [{ id: 'openseverTaskGroup1', startTs: 1533898800, endTs: 1733227199 }, { id: 'openseverTaskGroup2', startTs: 1733227200, endTs: 1881658799 }],
      dataMap: {
        openseverTaskGroup1: { openServerMissionData: [{ id: 'openserver_1', description: 'Clear Main Storyline0-1', rewards: [item('4003', 600)] }],
          checkInData: [{ order: 1, item: item('4001', 20000) }], chainLoginData: [{ order: 7, item: item('char_173_slchan', 1, 'CHAR') }] },
        openseverTaskGroup2: { openServerMissionData: [{ id: 'openserver_1_1', description: 'Clear Main Storyline0-1', rewards: [item('4003', 600)] }],
          checkInData: [{ order: 1, item: item('4001', 20000) }, { order: 2, item: item('4003', 200) }], chainLoginData: [{ order: 1, item: item('4001', 5000) }] },
      },
      constant: { firstDiamondShardMailCount: 3800 },
      longTermCheckInData: { groupList: [{ groupId: 'signin_1', days: 180, level: 80, rewardList: [item('4003', 600)] }] },
    },
    checkin: { groups: { signin82: { groupId: 'signin82', title: 'October', signStartTime: 1790852400, signEndTime: 1793530799, items: [item('4001', 2000), item('2001', 10), item('7001', 1)] } } },
    activity: {
      basicInfo: {
        act4mainss: { id: 'act4mainss', name: 'Critical Phase Transition', startTime: 1791979200, endTime: 1793185199, rewardEndTime: 1793789999 },
        act51side: { id: 'act51side', name: 'People, A People', startTime: 1789570800, endTime: 1790765999, rewardEndTime: 1791370799 },
        act59sign: { id: 'act59sign', name: 'Celebration Login Event', startTime: 1791979200, endTime: 1793185199, rewardEndTime: 1793185199 },
        act4d0: { id: 'act4d0', name: 'Code of Brawl', startTime: 1600000000, endTime: 1601000000, rewardEndTime: 1601500000 },
      },
      activity: {
        CHECKIN_ONLY: { act59sign: { checkInList: { 0: signIn(1, celebrationDays[0]), 1: signIn(2, celebrationDays[1]) } } },
        TYPE_ACT4D0: { act4d0: { mileStoneItemList: [{ item: item('char_131_flameb', 1, 'CHAR') }] } },
      },
      missionData: [
        mission('act4mainssActivity_1', 'ACTIVITY', 'act4mainss', 'Clear 17-2', [item('act4mainss_token', 40, 'ACTIVITY_ITEM')]),
        mission('51sideActivity_4', 'ACTIVITY', 'act51side', 'Clear PA-4', [item('char_4223_botany', 1, 'CHAR')]),
      ],
      activityTemplateMissionStyles: {
        act4mainss: { bigRewardType: 'ILLUST_CHAR_REWARD', bigRewardParamList: ['char_4226_veen', 'Clear 17-13 to obtain this Operator'] },
        permanent_main_3_One_Day_More: { bigRewardType: 'ILLUST_CHAR_REWARD', bigRewardParamList: ['char_4226_veen', 'Clear 17-13 to obtain this Operator'] },
        act51side: { bigRewardType: 'ILLUST_CHAR_REWARD', bigRewardParamList: ['char_4223_botany', 'Clear PA-4 to obtain this Operator'] },
      },
    },
    retro: {
      retroActList: {
        permanent_main_3_One_Day_More: { retroId: 'permanent_main_3_One_Day_More', linkedActId: ['act4mainss'], customActId: 'act4mainss', startTime: 1793185200, trailStartTime: -1, name: 'Critical Phase Transition' },
        permanent_sub_1_Darknights_Memoir: { retroId: 'permanent_sub_1_Darknights_Memoir', linkedActId: [], customActId: null, startTime: 1660000000, trailStartTime: 1669395600, name: 'Darknights Memoir' },
        permanent_sidestory_4_Twilight_Of_Wolumonde: { retroId: 'permanent_sidestory_4_Twilight_Of_Wolumonde', linkedActId: [], customActId: null, startTime: 1625137200, trailStartTime: 1675443600, name: 'Twilight of Wolumonde' },
      },
      // The client reuses Darknights Memoir's trail reward id for Twilight of Wolumonde's.
      retroTrailList: {
        permanent_sub_1_Darknights_Memoir: { trailStartTime: 1669395600, trailRewardList: [{ trailRewardId: 'trailReward_sub_1_1', starCount: 12, rewardItem: item('char_333_sidero', 1, 'CHAR') }, { trailRewardId: 'trailReward_sub_1_2', starCount: 20, rewardItem: item('4003', 100) }] },
        permanent_sidestory_4_Twilight_Of_Wolumonde: { trailStartTime: 1675443600, trailRewardList: [{ trailRewardId: 'trailReward_sub_1_1', starCount: 12, rewardItem: item('char_345_folnic', 1, 'CHAR') }] },
      },
    },
    shops: { shopGPDataDict: { GP_freeL_5: { displayName: 'Free pack' } } },
    eventRewards: { events: { '[Celebration] Critical Phase Transition': { activity: 'act4mainss', groups: [
      { kind: 'login', title: '2026 CELEBRATION SIGN-IN EVENT OPEN', region: 'Global', start: '2026-10-14T15:00:00.000Z', end: '2026-10-28T10:59:00.000Z', days: 2,
        items: [], daily: [[{ name: 'Emergency Sanity Concentrate', count: 1 }, { name: 'A Sealed Vow Headhunting Permit', count: 1 }], [{ name: 'Recruitment Permit', count: 5 }, { name: 'GALLUS²', count: 1 }]] },
      { kind: 'missions', title: 'Event missions', source: 'activity_table missionData act4mainss', items: [{ name: "'Factory scrip'", count: 400, kind: 'event-item', id: 'act4mainss_token' }] },
    ] }, '[Side Story] People, A People': { activity: 'act51side', groups: [] } } },
  };
}

test('welfare operators come from the tables that give them: event missions, permanent missions, Record Restoration', () => {
  const built = buildFreeRewards(tables());
  const welfare = Object.fromEntries(built.rewards.filter(row => row.group === 'Welfare operators').map(row => [row.id, row]));
  // Viy: no event mission gives her; the permanent mission act4mainssPermanent_5 does, from the event's start, with no end.
  const viy = welfare['free:act4mainssPermanent_5'];
  assert.equal(viy?.name, 'Viy · Event missions (permanent): Clear 17-13');
  assert.equal(viy.event, 'Critical Phase Transition');
  assert.equal(viy.startAt, 1791979200 * 1000);
  assert.equal(viy.endAt, undefined);
  // ...and says so: a permanent mission, whose event closes on 2026-10-28 (basicInfo endTime).
  assert.deepEqual([viy.source, viy.eventEndAt], ['retro', (1793185199 + 1) * 1000]);
  assert.equal(viy.href, `/events/${encodeURIComponent('[Celebration] Critical Phase Transition')}`);
  assert.deepEqual(viy.rewards.map(reward => [reward.id, reward.rarity]), [['char_4226_veen', 6]]);
  // A side story's operator: its missions, while its stages are open.
  const botani = welfare['free:51sideActivity_4'];
  assert.equal(botani?.name, 'Botani · Event missions: Clear PA-4');
  assert.deepEqual([botani.startAt, botani.endAt, botani.source], [1789570800 * 1000, (1790765999 + 1) * 1000, 'event']);
  // Record Restoration, keyed by story as well as reward: the two share trailReward_sub_1_1.
  assert.equal(welfare['free:trail:permanent_sub_1_Darknights_Memoir:trailReward_sub_1_1']?.name, 'Sideroca · Record Restoration: 12 stars');
  assert.equal(welfare['free:trail:permanent_sub_1_Darknights_Memoir:trailReward_sub_1_1'].source, 'trail');
  assert.equal(welfare['free:trail:permanent_sidestory_4_Twilight_Of_Wolumonde:trailReward_sub_1_1']?.name, 'Folinic · Record Restoration: 12 stars');
  assert.ok(!Object.keys(welfare).some(id => id.includes('trailReward_sub_1_2')), 'only the operator of a trail is a welfare row');
  // An event's own data (milestones): manual, while its stages were open.
  assert.equal(welfare['free:welfare:act4d0:char_131_flameb']?.name, 'Flamebringer · Event rewards');
  assert.equal(welfare['free:welfare:act4d0:char_131_flameb'].source, 'extra');
  // A sign-in's operator stays a day of its sign-in, not a second welfare row.
  assert.ok(!Object.values(welfare).some(row => row.rewards.some(reward => reward.id === 'char_4227_gallus')));
});

/* A story restored without a trail (retro_table haveTrail false), as Global has since Ending a
   Grand Overture: the restored story reopens its event's missions, so the event's operator is
   obtainable for good from the restore date (I Portatori dei Velluti, restored 2026-05-21). */
function restoredTables(restore: { haveTrail?: boolean; startTime: number }) {
  const base = tables();
  return {
    ...base,
    characters: { ...base.characters, char_1502_crosly: { name: 'Crownslayer', rarity: 'TIER_6' } },
    activity: {
      ...base.activity,
      basicInfo: { ...base.activity.basicInfo,
        act38side: { id: 'act38side', name: 'I Portatori dei Velluti', startTime: 1746000000, endTime: 1747306799, rewardEndTime: 1747900000 },
        act38sre: { id: 'act38sre', name: 'I Portatori dei Velluti - Rerun', startTime: 1777800000, endTime: 1779015599, rewardEndTime: 1779600000 } },
      missionData: [...base.activity.missionData,
        mission('38sideActivity_5', 'ACTIVITY', 'act38side', 'Clear PV-5', [item('char_1502_crosly', 1, 'CHAR')]),
        mission('38sreActivity_5', 'ACTIVITY', 'act38sre', 'Clear PV-5', [item('char_1502_crosly', 1, 'CHAR')])],
    },
    retro: { ...base.retro, retroActList: { ...base.retro.retroActList,
      permanent_sidestory_28_i_portatori_dei_velluti: { retroId: 'permanent_sidestory_28_i_portatori_dei_velluti', type: 'SIDESTORY', linkedActId: ['act38side', 'act38sre'],
        trailStartTime: -1, name: 'I Portatori dei Velluti', customActId: null, ...restore } } },
  };
}

test('a story restored without a trail gets its event\'s operator one row, from the restore date', () => {
  const built = buildFreeRewards(restoredTables({ haveTrail: false, startTime: 1779361200 }));
  const rows = built.rewards.filter(row => row.group === 'Welfare operators' && row.rewards.some(reward => reward.id === 'char_1502_crosly'));
  const restored = rows.filter(row => row.id.startsWith('free:restore:'));
  // One row for the story, from the event's own mission, not one per linked event.
  assert.deepEqual(restored.map(row => row.id), ['free:restore:permanent_sidestory_28_i_portatori_dei_velluti:38sideActivity_5']);
  assert.deepEqual([restored[0].name, restored[0].source, restored[0].startAt, restored[0].endAt, restored[0].event],
    ['Crownslayer · Record Restoration: Clear PV-5', 'trail', 1779361200 * 1000, undefined, 'I Portatori dei Velluti']);
  // The two event runs keep their own rows, closed.
  assert.deepEqual(rows.filter(row => row.source === 'event').map(row => row.id).sort(), ['free:38sideActivity_5', 'free:38sreActivity_5']);
});

test('a restored story whose operator no rule reads stops the build', () => {
  // A trail still to come (Path of Life's opens 2026-12-11) waits for the table to list it.
  assert.doesNotThrow(() => buildFreeRewards(restoredTables({ haveTrail: true, startTime: 1779361200 })));
  // Restored without a trail but with no restore date: no row could be made, so the run fails.
  assert.throws(() => buildFreeRewards(restoredTables({ haveTrail: false, startTime: -1 })),
    /Record Restoration without a welfare row: permanent_sidestory_28_i_portatori_dei_velluti restores act38side, act38sre/);
});

test('an operator the event mission page features without a row stops the build', () => {
  const { act4mainssPermanent_5: _viy, ...missions } = tables().missions.missions as Record<string, unknown>;
  assert.throws(() => buildFreeRewards(tables({ missions })), /Welfare operator without a row: char_4226_veen featured by act4mainss/);
});

test('an official post of the client sign-in under its own title is that sign-in, not a second one', () => {
  const built = buildFreeRewards(tables());
  const signIns = built.rewards.filter(row => row.group === 'Event sign-in and gifts');
  assert.deepEqual(signIns.map(row => row.id), ['free:act59sign:1', 'free:act59sign:2']);
  // Another post (other counts) still has its rows.
  const other = tables();
  other.eventRewards.events['[Celebration] Critical Phase Transition'].groups[0].daily![1] = [{ name: 'Orundum', count: 600 }];
  assert.equal(buildFreeRewards(other).rewards.filter(row => row.id.startsWith('free:announcement:')).length, 2);
});

test('welfare operators come from an event\'s missions, Global only', () => {
  const start = Date.parse('2026-09-16T08:00:00Z') / 1000; const end = Date.parse('2026-09-30T03:59:59Z') / 1000;
  // The Global tables: act51side's missions give Botani. A CN-only event's operator is in no Global
  // table, so an event-rewards entry naming one adds nothing.
  const result = buildFreeRewards({
    handbook: { handbookStageData: {} }, missions: { missions: {}, missionGroups: {} }, checkin: { groups: {} },
    openServer: { schedule: [{ id: 'starter', startTs: 0 }], dataMap: {}, constant: { firstDiamondShardMailCount: 1 } },
    items: { items: {} }, shops: { shopGPDataDict: {} },
    characters: { char_4223_botany: { name: 'Botani', rarity: 'TIER_5' }, char_4215_buddy: { name: 'Buddy', rarity: 3 } },
    activity: { activity: {}, basicInfo: { act51side: { name: 'People, A People', startTime: start, endTime: end, rewardEndTime: end + 7 * 86400 } },
      missionData: [{ id: '51sideActivity_4', type: 'ACTIVITY', missionGroup: 'act51side', description: 'Clear PA-4', rewards: [{ type: 'CHAR', id: 'char_4223_botany', count: 1 }] },
        { id: '51sideActivity_5', type: 'ACTIVITY', missionGroup: 'act51side', description: 'Clear PA-5', rewards: [{ type: 'GOLD', id: '4001', count: 1000 }] }] },
    eventRewards: { events: {
      '[Side Story] People, A People': { activity: 'act51side', groups: [{ kind: 'missions', title: 'Event missions', items: [
        { name: 'Botani', count: 1, kind: 'operator', id: 'char_4223_botany' }, { name: 'LMD', count: 1000, kind: 'currency', id: '4001' }] }] },
      '[Crossover] CN only': { activity: 'act50side', region: 'CN', groups: [{ kind: 'missions', items: [{ name: 'Buddy', count: 1, kind: 'operator', id: 'char_4215_buddy' }] }] },
    } },
  });
  // The row the Reward Tracker's filters then work over (arkpedia-app test-reward-stage-filters.ts).
  assert.deepEqual(result.rewards.filter((reward) => reward.group === 'Welfare operators'), [{ id: 'free:51sideActivity_4', group: 'Welfare operators', name: 'Botani · Event missions: Clear PA-4',
    rewards: [{ id: 'char_4223_botany', rarity: 5, name: 'Botani', count: 1 }], startAt: start * 1000, endAt: (end + 1) * 1000,
    event: 'People, A People', href: '/events/%5BSide%20Story%5D%20People%2C%20A%20People', source: 'event', forecast: false }]);
});
