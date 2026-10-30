import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreeRewards } from '../build/build-free-rewards.mjs';

/*
 * The Reward Tracker's Beginner rewards, out of the Global open_server_table: both programmes'
 * ids, windows and sign-in days as the client has them (ArknightsAssets/ArknightsGamedata,
 * 2026-10-21). What a reader's save then ticks on these rows is the application's
 * (arkpedia-app scripts/tests/test-reward-beginner-imports.ts).
 */
const item = (id: string, count: number, type = 'MATERIAL') => ({ id, count, type });
const openServer = {
  schedule: [{ id: 'openseverTaskGroup1', startTs: 1533898800, endTs: 1733227199 }, { id: 'openseverTaskGroup2', startTs: 1733227200, endTs: 1881658799 }],
  dataMap: {
    openseverTaskGroup1: {
      openServerMissionGroup: { id: 'openseverTaskGroup1', type: 'OPENSERVER', missionIds: ['openserver_1', 'openserver_2', 'openserver_3', 'openserver_4'] },
      openServerMissionData: ['Clear Main Storyline0-1', 'Own at least 1 Lv.2 Control Center', 'Clear Main Storyline1-12', 'Player reaches Lv.8']
        .map((description, index) => ({ id: `openserver_${index + 1}`, description, rewards: [item('4003', 600, 'DIAMOND_SHD')] })),
      checkInData: [{ order: 1, item: item('4001', 5000, 'GOLD') }, { order: 14, item: item('4001', 50000, 'GOLD') }],
      chainLoginData: [{ order: 1, item: item('4003', 600, 'DIAMOND_SHD') }, { order: 7, item: item('char_173_slchan', 1, 'CHAR') }],
    },
    openseverTaskGroup2: {
      openServerMissionGroup: { id: 'openseverTaskGroup2', type: 'OPENSERVER', missionIds: ['openserver_1_1', 'openserver_2_1', 'openserver_3_1', 'openserver_4_1'] },
      openServerMissionData: ['Clear Main Storyline0-1', 'Player reaches Lv.8', 'Clear Main Storyline1-12', 'Own a Lv.2 Control Center']
        .map((description, index) => ({ id: `openserver_${index + 1}_1`, description, rewards: [item('4003', 600, 'DIAMOND_SHD')] })),
      checkInData: [{ order: 1, item: item('4001', 20000, 'GOLD') }, { order: 2, item: item('2003', 20, 'CARD_EXP') }],
      chainLoginData: [{ order: 7, item: item('voucher_item_4pick1_5301', 1, 'VOUCHER_PICK') }],
    },
  },
  constant: { firstDiamondShardMailCount: 3800 },
};
const built = buildFreeRewards({
  handbook: { handbookStageData: {} }, missions: { missions: {}, missionGroups: {} }, checkin: { groups: {} }, openServer,
  items: { items: { '4001': { name: 'LMD' }, '4003': { name: 'Orundum' } } }, shops: { shopGPDataDict: {} },
  characters: { char_173_slchan: { name: 'Cliffheart', rarity: 'TIER_5' } }, activity: { activity: {}, basicInfo: {}, missionData: [] },
} as never);

test('the current beginner programme is the default collection, the older one kept beside it', () => {
  assert.deepEqual(built.rewards.map(row => row.id), ['free:openserver_1_1', 'free:openserver_2_1', 'free:openserver_3_1', 'free:openserver_4_1',
    'free:openseverTaskGroup2:checkInData:1', 'free:openseverTaskGroup2:checkInData:2', 'free:openseverTaskGroup2:chainLoginData:7', 'free:welcome-mail']);
  assert.deepEqual(built.beginnerRewards.map(row => row.id), ['free:openserver_1', 'free:openserver_2', 'free:openserver_3', 'free:openserver_4',
    'free:openseverTaskGroup1:checkInData:1', 'free:openseverTaskGroup1:checkInData:14', 'free:openseverTaskGroup1:chainLoginData:1', 'free:openseverTaskGroup1:chainLoginData:7']);
  // Each row carries the programme it belongs to, with the window the account's registration is read against.
  for (const row of [...built.rewards, ...built.beginnerRewards]) {
    if (row.id === 'free:welcome-mail') { assert.equal(row.beginner, undefined); continue; }
    assert.equal(row.beginner.current, row.beginner.id === 'openseverTaskGroup2');
    assert.equal(row.group, 'Beginner rewards');
  }
  assert.deepEqual(built.rewards[0].beginner, { id: 'openseverTaskGroup2', startTs: 1733227200, endTs: 1881658799, current: true });
});

test('a sign-in day is named by its order and an operator day carries her rarity', () => {
  const day = (id: string) => [...built.rewards, ...built.beginnerRewards].find(row => row.id === id);
  assert.equal(day('free:openseverTaskGroup1:checkInData:14')?.name, 'Cumulative sign-in · Day 14');
  assert.equal(day('free:openseverTaskGroup2:chainLoginData:7')?.name, 'Consecutive sign-in · Day 7');
  assert.deepEqual(day('free:openseverTaskGroup1:chainLoginData:7')?.rewards, [{ id: 'char_173_slchan', rarity: 5, name: 'Cliffheart', count: 1 }]);
  // The welcome mail is the constant, not a day of either programme.
  assert.deepEqual(day('free:welcome-mail')?.rewards, [{ id: '4003', name: 'Orundum', count: 3800, orundum: 3800 }]);
});
