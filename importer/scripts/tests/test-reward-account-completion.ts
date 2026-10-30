import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreeRewards } from '../build/build-free-rewards.mjs';

/*
 * The reward catalogue a release carries, from one table of every kind the Reward Tracker
 * imports a claim for: both beginner programmes, a sign-in milestone, a monthly sign-in, two
 * event sign-ins, a login gift and a free level-up pack. The application resolves an imported
 * save against these rows (arkpedia-app scripts/tests/test-reward-account-completion.ts).
 */
const beginnerPrograms = [{ id: 'old', startTs: 100 }, { id: 'current', startTs: 200 }];
const item = { id: '4003', count: 100 };
const days = [{ order: 1, itemList: [item] }, { order: 2, itemList: [item] }];
const info = (name: string) => ({ name, startTime: 1, rewardEndTime: 9999 });
const built = buildFreeRewards({ handbook: { handbookStageData: {} }, characters: {}, items: { items: { '4003': { name: 'Orundum' } } },
  missions: { missions: {}, missionGroups: {} },
  openServer: { schedule: beginnerPrograms, dataMap: { old: { openServerMissionData: [{ id: 'old_task', description: 'Old programme mission', rewards: [item] }],
    checkInData: days.map(day => ({ order: day.order, item })), chainLoginData: days.map(day => ({ order: day.order, item })) }, current: { openServerMissionData: [{ id: 'current_task', description: 'Replacement mission', rewards: [item] }],
    checkInData: days.map(day => ({ order: day.order, item })), chainLoginData: days.map(day => ({ order: day.order, item })) } },
    constant: { firstDiamondShardMailCount: 3800 }, longTermCheckInData: { groupList: [{ groupId: 'milestone', days: 30, level: 10, rewardList: [item] }] } },
  checkin: { groups: { signin_test: { groupId: 'signin_test', title: 'Monthly', items: [item, item], signStartTime: 1, signEndTime: 9999 } } },
  activity: { activity: { CHECKIN_ONLY: { event_a: { checkInList: days } }, CHECKIN_ALL_PLAYER: { event_b: { checkInList: days } }, LOGIN_ONLY: { gift: { itemList: [item] } } },
    basicInfo: { event_a: info('A'), event_b: info('B'), gift: info('Gift') } },
  shops: { shopGPDataDict: { GP_freeL_5: { displayName: 'Free pack' } } } } as never);

test('every kind of claim the tracker imports has a row, each under the id the save names it by', () => {
  assert.deepEqual(built.rewards.map(row => row.id), ['free:current_task', 'free:current:checkInData:1', 'free:current:checkInData:2',
    'free:current:chainLoginData:1', 'free:current:chainLoginData:2', 'free:welcome-mail', 'free:milestone',
    'free:signin_test:1', 'free:signin_test:2', 'free:event_a:1', 'free:event_a:2', 'free:event_b:1', 'free:event_b:2', 'free:gift', 'free:GP_freeL_5']);
  assert.equal(built.rewards.find(row => row.id === 'free:milestone')?.name, '30 sign-in days · Doctor Lv.10');
  assert.equal(built.rewards.find(row => row.id === 'free:welcome-mail')?.rewards[0].count, 3800);
});

test('the older beginner programme is kept beside the default collection, never in it', () => {
  assert(!built.rewards.some(row => row.id.startsWith('free:old:')), 'older readers still receive only the current default collection');
  assert.deepEqual(built.beginnerRewards.map(row => row.id), ['free:old_task', 'free:old:checkInData:1', 'free:old:checkInData:2',
    'free:old:chainLoginData:1', 'free:old:chainLoginData:2']);
  assert.deepEqual(built.beginnerRewards[0].beginner, { id: 'old', startTs: 100, current: false });
});

test('a Paradox Simulation is built for every operator the handbook lists a stage for', () => {
  const ids = ['done', 'unlocked', 'played', 'pass', 'bad', 'unknown', 'null', 'story'];
  const paradox = buildFreeRewards({ handbook: { handbookStageData: Object.fromEntries(ids.map(id => [id,
    { stageId: `mem_${id}`, charId: `char_${id}`, name: id, rewardItem: [{ id: '4003', count: 200 }] }])) }, characters: {}, items: { items: {} },
    missions: { missions: {}, missionGroups: {} }, openServer: { schedule: [], dataMap: {}, constant: { firstDiamondShardMailCount: 3800 } }, checkin: { groups: {} },
    activity: { activity: {}, basicInfo: {} }, shops: { shopGPDataDict: {} } } as never).paradox;
  assert.deepEqual(paradox.map((row: { id: string }) => row.id), ids.map(id => `paradox:mem_${id}`).sort());
  assert.deepEqual(paradox[0], { operatorId: 'char_bad', id: 'paradox:mem_bad', name: 'char_bad · bad', amount: 200 });
});
