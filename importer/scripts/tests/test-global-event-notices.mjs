import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventNoticeWindow, reconcileGlobalEventNotices, applyAnnouncedENWindows } from '../sync/global-event-notices.mjs';
import { unpublishedNews, dispatchPlan } from '../content/client-version-dispatch.mjs';

const post = JSON.parse(fs.readFileSync(new URL('./fixtures/official-news/5092.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-11-12T09:00:00Z');
const event = () => ({ name: '[Side Story – Crossover] Thunder in the Azure Dream', activityId: 'act50side',
  global: { dateRange: '2026/11/16–2026/11/30', note: 'ESTIMATED Global date, not officially confirmed' } });
const banner = () => ({ name: 'Hunters of the Umbral Wilds', pull_type: 'limited', global_date: '2026/11/16–2026/11/30', global_date_estimated: true });

test('official crossover notice separates stage, banner and shop deadlines before any client pool exists', () => {
  const events = [event()], banners = [banner()];
  assert.equal(reconcileGlobalEventNotices({events, banners, posts: [post], now}).length, 2);
  assert.deepEqual(events[0].global, { dateRange: '2026/11/16–2026/11/30', note: null, startAt: '2026-11-16T15:00:00.000Z',
    endAt: '2026-11-30T11:00:00.000Z', shopEndAt: '2026-12-07T11:00:00.000Z', timingSource: post.url });
  assert.equal(banners[0].global_date_estimated, false);
  assert.equal(banners[0].global_window.endAt, '2026-11-30T11:00:00.000Z');
  assert.equal(banners[0].globalScheduleStatus, 'announced');
  assert.equal(banners[0].globalPoolId, undefined);
  assert.deepEqual(reconcileGlobalEventNotices({events, banners, posts: [post], now}), []);
  const enEvents = {}, enBanners = {};
  applyAnnouncedENWindows(enEvents, enBanners, events, banners);
  assert.equal(enEvents[events[0].name].status, 'announced');
  assert.equal(enBanners[banners[0].name].endAt, events[0].global.endAt);
});

test('rerun stage heading is distinct from its encompassing duration and named store', () => {
  const rerun = JSON.parse(fs.readFileSync(new URL('./fixtures/official-news/5045.json', import.meta.url), 'utf8'));
  assert.equal(eventNoticeWindow(rerun).endAt, '2026-11-15T11:00:00.000Z');
  assert.equal(eventNoticeWindow(rerun).shopEndAt, '2026-11-19T11:00:00.000Z');
});

test('ambiguous names, unrelated runs and malformed stage times never confirm estimates', () => {
  const events = [event(), event()], issues = [];
  reconcileGlobalEventNotices({events, banners: [], posts: [post], now, onProblem: (_, reason) => issues.push(reason)});
  assert.match(events[0].global.note, /ESTIMATED/);
  assert.match(issues[0], /Ambiguous/);
  const broken = structuredClone(post);
  const index = broken.lines.findIndex(line => line.startsWith('Phase 1'));
  broken.lines[index + 1] = 'DURATION: unreadable';
  assert.equal(eventNoticeWindow(broken), null);
  const old = event(); old.global.dateRange = '2025/11/16–2025/11/30';
  reconcileGlobalEventNotices({events: [old], banners: [], posts: [post], now});
  assert.match(old.global.note, /ESTIMATED/);
  const unofficial = {...post, url: 'https://example.com/news/5092'};
  assert.deepEqual(reconcileGlobalEventNotices({events: [event()], banners: [banner()], posts: [unofficial], now}), []);
});

test('new official news starts an import without a game patch, with busy and retry guards', () => {
  const base = {live: {}, mirrors: {}, published: {regions: {}}, news: [5092], busy: false, last: null, now: new Date(now)};
  assert.equal(dispatchPlan(base).dispatch, true);
  assert.equal(dispatchPlan({...base, news: []}).dispatch, false);
  assert.equal(dispatchPlan({...base, busy: true}).dispatch, false);
  const last = {at: new Date(now - 2 * 3600000).toISOString(), versions: {}, news: [5092]};
  assert.equal(dispatchPlan({...base, last}).dispatch, false);
  assert.equal(dispatchPlan({...base, last, news: [5093]}).dispatch, true);
  assert.equal(dispatchPlan({...base, last: {...last, at: new Date(now - 1800000).toISOString()}, news: [5093]}).dispatch, false);
});

test('news discovery compares first-party recent event IDs and fails closed without a baseline', async () => {
  const rows = [{id: 5092, type: 'event', publishTime: now - 1000}, {id: 5091, type: 'event', publishTime: now - 1000},
    {id: 1, type: 'event', publishTime: now - 30 * 86400000}, {id: 3, type: 'notice', publishTime: now - 1000}];
  const fetcher = async () => ({ok: true, json: async () => ({code: 0, data: {rows}})});
  assert.deepEqual(await unpublishedNews(fetcher, () => [{name: '5091.json'}], 'main', new Date(now)), [5092]);
  await assert.rejects(unpublishedNews(fetcher, () => [], 'main', new Date(now)), /baseline unavailable/);
  await assert.rejects(unpublishedNews(async () => ({ok: false, status: 503}), () => [], 'main', new Date(now)), /503/);
});
