import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { cnPackSections, cnPackGroups, applyCnPacks, cnPackWindow } from '../build/cn-packs.mjs';
import { cnPackPromoCandidates } from '../lib/pack-promo.mjs';

const post = JSON.parse(fs.readFileSync(new URL('./fixtures/official-news/cn-9686.json', import.meta.url)));
const event = { name: 'Jungle Knot', cn: { timingSource: post.url, startAt: '2026-07-10T12:00:00+08:00' } };
const groups = cnPackGroups([event], [post], null, name => ({ name: name === '至纯源石' ? 'Originite Prime' : name, kind: 'material' }));

test('official CN sale keeps all eight offers, their own windows and localized contents before a client patch', () => {
  const [group] = groups[event.name];
  assert.equal(group.region, 'CN'); assert.equal(group.source, post.url);
  assert.equal(group.packs.length, 8);
  const pack = group.packs.find(p => p.name === '创生因子组合包');
  assert.equal(pack.contents.find(i => i.name === 'Originite Prime').count, 16);
  assert.equal(pack.start, '2026-07-10T04:00:00.000Z');
  assert.equal(pack.end, '2026-07-30T20:00:00.000Z');
  assert.equal(group.packs[0].end, '2026-07-23T16:00:00.000Z');
});

test('Global replaces the complete CN offer list without name matching or altering other rewards', () => {
  const global = { kind: 'packs', region: 'Global', source: 'global', packs: [{ name: 'Different Global-only pack', contents: [] }] };
  const login = { kind: 'login', region: 'CN' };
  const rewards = { [event.name]: { groups: [...groups[event.name], global, login] } };
  applyCnPacks(rewards, groups);
  assert.deepEqual(rewards[event.name].groups, [global, login]);
  const waiting = { [event.name]: { groups: [login] } };
  applyCnPacks(waiting, groups);
  assert.equal(waiting[event.name].groups.filter(g => g.kind === 'packs').length, 1);
});

test('unrelated and ambiguous event identities receive no packs; newer announcements replace older lists', () => {
  assert.deepEqual(cnPackGroups([{ name: 'Unrelated' }], [post], null), {});
  assert.deepEqual(cnPackGroups([event, { ...event, name: 'Another event' }], [post], null), {});
  const newer = { ...post, displayTime: post.displayTime + 100, lines: post.lines.map(l => l.replace('创生因子组合包', '新组合包')) };
  const result = cnPackGroups([event], [post, newer], null);
  assert(result[event.name][0].packs.some(p => p.name === '新组合包'));
  assert(!result[event.name][0].packs.some(p => p.name === '创生因子组合包'));
});

test('CN sheets cover exactly the following bracketed offers, with no outfit or foreign-host art', () => {
  const rewards = { events: { [event.name]: { groups: groups[event.name] } } };
  const candidates = cnPackPromoCandidates(rewards, () => post);
  assert.deepEqual(candidates.map(c => c.directNames.length), [2, 3, 3]);
  assert.equal(new Set(candidates.flatMap(c => c.names)).size, 8);
  assert(candidates.every(c => c.source === post.url && c.url.startsWith('https://web.hycdn.cn/')));
  assert.deepEqual(cnPackPromoCandidates(rewards, () => ({ ...post, art: post.art.map(a => ({ ...a, url: 'https://untrusted.invalid/art.png' })) })), []);
});

test('free gifts, malformed contents and unannounced windows never become paid offers', () => {
  const fixture = { displayTime: post.displayTime, title: 'Test', lines: ['一、组合包限时上架', '售卖时间：07月10日 12:00 - 07月31日 03:59', '[免费包]（免费）', '组合包内容：至纯源石*1', '[Paid]', '组合包内容：至纯源石*2、Unknown amount'] };
  assert.deepEqual(cnPackSections(fixture), []);
  const explicit = cnPackWindow('11月01日 12:00 - 2027年05月01日 11:59', Date.parse('2026-10-23') / 1000);
  assert.equal(new Date(explicit.end * 1000).toISOString(), '2027-05-01T04:00:00.000Z');
});

test('festival packs belong to the main event, not an earlier museum/mode in the same announcement', () => {
  const festival = JSON.parse(fs.readFileSync(new URL('./fixtures/official-news/cn-3046.json', import.meta.url)));
  const main = { name: 'Critical Phase Transition', cn: { dateRange: '2026/05/01–2026/05/15' } };
  const mode = { name: 'Duel Channel', cn: { dateRange: '2026/04/25–2026/05/09', timingSource: festival.url } };
  const cn = { activity: { basicInfo: { main: { name: '相变临界', startTime: Date.parse('2026-05-01T11:00:00+08:00') / 1000 } } } };
  const result = cnPackGroups([mode, main], [festival], cn);
  assert.equal(result[mode.name], undefined);
  assert.equal(result[main.name].reduce((n, g) => n + g.packs.length, 0), 25);
});

test('a Global list also removes cached CN packs when a CN post is unavailable', () => {
  const global = {kind:'packs',region:'Global',packs:[{name:'Global-only'}]};
  const rewards = {event:{groups:[{kind:'packs',region:'CN',packs:[{name:'CN-only'}]},global]}};
  applyCnPacks(rewards,{});
  assert.deepEqual(rewards.event.groups,[global]);
});

test('CN prose uses shared IDs for English ten-roll names and retains genuinely CN-only items', async () => {
  const {cnPackNamer} = await import('../build/build-event-rewards.mjs');
  const cn = {items:{items:{ten:{itemId:'ten',name:'十连寻访凭证',itemType:'TKT_GACHA_10'},new:{itemId:'new',name:'全新物品',itemType:'MATERIAL'}}}};
  const en = {items:{items:{ten:{itemId:'ten',name:'Headhunting Permit',itemType:'TKT_GACHA_10'}}}};
  const name = cnPackNamer(cn,en);
  assert.equal(name('十连寻访凭证').name,'Headhunting Permit (ten-roll)');
  assert.equal(name('全新物品').name,'全新物品');
});
