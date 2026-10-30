import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFreeRewards } from '../build/build-free-rewards.mjs';

/* The shapes of activity_table's dynActs (Global, 2026-10-08): the Recommended Monthly Card's
   30 days and a three-day video login. What a reader's save then ticks on those rows is the
   application's (arkpedia-app scripts/tests/test-reward-dyn-signins.ts). */
const start = 1791457200, end = 1794826799;
const info = (id: string, type: string, name: string) => ({ id, type, name, startTime: start, endTime: end, rewardEndTime: end });
const tables = (announcements = { events: {} }) => ({
  handbook: { handbookStageData: {} }, characters: {}, items: { items: {} }, missions: { missions: {}, missionGroups: {} },
  openServer: { schedule: [], dataMap: {}, constant: { firstDiamondShardMailCount: 3800 } }, checkin: { groups: {} }, shops: { shopGPDataDict: {} },
  activity: {
    activity: {},
    basicInfo: { act3access: info('act3access', 'CHECKIN_ACCESS', 'Exclusive Event'), act3video: info('act3video', 'CHECKIN_VIDEO', 'To Look Back on Terra Limited Login Event') },
    dynActs: {
      act3access: { dayCount: 30, rewardItemPerDay: [{ count: 200, id: '4003', type: 'DIAMOND_SHD' }, { count: 1, id: 'ap_supply_lt_80', type: 'AP_SUPPLY' }] },
      act3video: { checkInList: {
        0: { order: 1, itemList: [{ count: 1, id: 'voucher_a', type: 'VOUCHER_PICK' }] },
        1: { order: 2, itemList: [{ count: 1, id: 'furni_b', type: 'FURN' }] },
        2: { order: 3, itemList: [{ count: 1, id: 'theme_c', type: 'HOME_THEME' }] } } },
    },
  },
  announcements,
});
const rows = (built: { rewards: { id: string; name: string }[] }) => built.rewards.filter(row => /act3(access|video)|announcement/.test(row.id));

test('the Monthly Card check-in and a video login are built from dynActs, with the save\'s ids', () => {
  const built = rows(buildFreeRewards(tables()));
  assert.equal(built.filter(row => row.id.startsWith('free:act3access:')).length, 30);
  assert.ok(built.some(row => row.id === 'free:act3access:13' && row.name === 'Monthly Card check-in · Day 13'));
  assert.deepEqual(built.filter(row => row.id.startsWith('free:act3video:')).map(row => row.id), ['free:act3video:1', 'free:act3video:2', 'free:act3video:3']);
});

test('the official posts of the same days are those sign-ins, not second copies', () => {
  const at = (s: number) => new Date(s * 1000).toISOString();
  const announcements = { events: { '[Celebration] Critical Phase Transition': { region: 'Global', groups: [
    // As data/event-announcements.json has them: the post's totals for the whole sign-in.
    { kind: 'login', title: 'Recommended Monthly Card', start: at(start), end: at(end + 1), days: 30, region: 'Global',
      items: [{ name: 'Orundum', count: 6000, kind: 'currency', id: '4003' }, { name: 'Emergency Sanity Booster', count: 30, kind: 'sanity', id: 'ap_supply_lt_80' }] },
    { kind: 'login', title: 'To Look Back on Terra', start: at(start), end: at(end + 1), days: 3, region: 'Global',
      items: [{ name: 'Special Event Transfer Permit', count: 1, kind: 'permit', id: 'voucher_a' }, { name: 'Echoes of Recollection', count: 1, kind: 'furniture', id: 'furni_b' }, { name: 'Home Screen UI', count: 1, kind: 'other', id: '' }] },
  ] } } };
  const built = rows(buildFreeRewards(tables(announcements)));
  assert.equal(built.filter(row => row.id.startsWith('free:announcement:')).length, 0);
  assert.equal(built.length, 33);
});
