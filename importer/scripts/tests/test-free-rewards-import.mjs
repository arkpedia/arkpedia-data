import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreeRewards } from '../build/build-free-rewards.mjs';

test('free claims use Global gifts, split daily totals, retain selectors and exclude paid beginner packages', () => {
  const item = (id, count) => ({ id, count });
  const tables = {
    handbook: { handbookStageData: { mem_a: { stageId: 'mem_a', charId: 'char_a', name: 'Trial', rewardItem: [item('4003', 200)] } } },
    characters: { char_a: { name: 'A' } }, items: { items: { '4003': { name: 'Orundum' }, selector: { name: 'Free selector' } } },
    missions: { missions: {}, missionGroups: {} }, checkin: { groups: {} }, activity: { activity: {}, basicInfo: {} }, shops: { shopGPDataDict: { GP_L_5: { displayName: 'Paid pack' }, GP_freeL_5: { displayName: 'Free pack' } } },
    openServer: { schedule: [{ id: 'starter', startTs: 0 }], dataMap: { starter: { openServerMissionData: [], checkInData: [], chainLoginData: [] } }, constant: { firstDiamondShardMailCount: 3800 }, newbieCheckInPackageList: [{ rewards: [item('4003', 999)] }] },
    announcements: { events: { Celebration: { groups: [
      { kind: 'login', title: 'Daily gift', region: 'Global', days: 30, items: [item('4003', 6000)], start: '2026-10-08T11:00:00Z', end: '2026-11-16T11:00:00Z' },
      { kind: 'login', title: 'Selector gift', region: 'Global', days: 3, items: [item('selector', 1)], start: '2026-10-08T11:00:00Z', end: '2026-11-16T11:00:00Z' },
      { kind: 'login', title: 'CN preview', region: 'CN', items: [item('4003', 999)], start: '2026-10-08T11:00:00Z', end: '2026-11-16T11:00:00Z' },
      { kind: 'packs', title: 'Paid bundle', region: 'Global', items: [item('4003', 999)], start: '2026-10-08T11:00:00Z', end: '2026-11-16T11:00:00Z' },
    ] } } },
  };
  const result = buildFreeRewards(tables);
  assert.deepEqual(result.paradox, [{ id: 'paradox:mem_a', name: 'A · Trial', amount: 200, operatorId: 'char_a' }]);
  const daily = result.rewards.filter(reward => reward.name.includes('Daily gift'));
  assert.equal(daily.length, 30);
  assert.ok(daily.every(reward => reward.rewards[0].orundum === 200 && !reward.forecast));
  assert.equal(result.rewards.filter(reward => reward.name.includes('Selector gift')).length, 1);
  assert.ok(!result.rewards.some(reward => /Paid|CN preview/.test(reward.name)));
  assert.ok(result.rewards.some(reward => reward.name === 'Free pack'));
  tables.activity = { activity: { CHECKIN_ONLY: { login: { checkInList: [{ order: 1, itemList: [item('selector', 1)] }] } } },
    basicInfo: { login: { name: 'Selector gift', startTime: Date.parse('2026-10-08T11:00:00Z') / 1000, rewardEndTime: Date.parse('2026-11-16T11:00:00Z') / 1000 - 1 } } };
  const updated = buildFreeRewards(tables);
  assert.equal(updated.rewards.filter(reward => reward.name.includes('Selector gift')).length, 1, 'client gift replaces the announcement without counting twice');
  assert.ok(updated.rewards.some(reward => reward.id === 'free:login:1'));
});
