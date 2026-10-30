#!/usr/bin/env node
/** Regional client facts, joined by client IDs, never by a timezone shift of Global.
 * Same immutable mirror pin as the rest of a refresh. A failed region retains its last
 * snapshot and is quarantined; an unknown regional window never borrows Global's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRef } from '../content/pin-upstream.mjs';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { buildEventFarming } from './sync-event-farming.mjs';
import { newsLines } from '../build/official-news.mjs';
import { readOfficialBulletins } from './sync-official-bulletins.mjs';
import { boardBannerItems, regionalPoolId, withBoardArt } from './regional-board.mjs';
import { serverDay, SERVER_TIME, serverInstant } from '../../lib/time/servers.mjs';

export const OUTPUT = 'data/regional-schedules.json';
const TABLES = ['activity', 'gacha', 'stage', 'zone', 'skin', 'campaign', 'climb_tower', 'crisis_v2', 'checkin', 'item', 'sandbox_perm'];
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\[[^\]]*\]|\brerun\b/gi, '').replace(/[^\p{L}\p{N}]/gu, '');
const end = seconds => seconds + (seconds % 60 === 59 ? 1 : 0);
const iso = seconds => new Date(seconds * 1000).toISOString();
const window = (start, close, source) => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(close) || start <= 0 || close <= start) return null;
  return { startAt: iso(start), endAt: iso(end(close)), timingSource: source };
};

/** A notice may move a maintenance opening, never its regional closing date. Require
 * a named record, the same regional calendar day, one unambiguous later time (<=12h).
 * Ambiguous/unreadable notices leave the client fact and its provisional provenance.
 */
export function noticeOpening(record, notices, server) {
  const original = Date.parse(record.startAt);
  const day = serverDay(original / 1000, SERVER_TIME[server].offset).split('/').map(Number);
  const times = [];
  for (const post of notices) {
    const text = `${post.title ?? ''}\n${post.lines.join('\n')}`;
    if (!fold(text).includes(fold(record.localName)) || fold(record.localName).length < 2) continue;
    const pattern = /(?:(\d{4})\s*[年년]\s*)?(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일](?:\s*\([^)]*\)|\s*（[^）]*）)?\s*(\d{1,2}):([0-5]\d)/gu;
    const candidates = new Set();
    if (server === 'en') {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      for (const m of text.matchAll(/([A-Z][a-z]+) (\d{1,2}), (\d{4}), (\d{1,2}):([0-5]\d)/g)) {
        const month = months.indexOf(m[1]) + 1;
        if (+m[3] !== day[0] || month !== day[1] || +m[2] !== day[2]) continue;
        const instant = serverInstant(+m[3], month, +m[2], +m[4], server) + +m[5] * 60000;
        if (instant >= original && instant <= original + 12 * 3600000 && instant < Date.parse(record.endAt)) candidates.add(instant);
      }
    }
    for (const m of text.matchAll(pattern)) {
      const year = m[1] ? +m[1] : new Date(post.publishTime).getUTCFullYear();
      if (year !== day[0] || +m[2] !== day[1] || +m[3] !== day[2]) continue;
      const instant = serverInstant(year, +m[2], +m[3], +m[4], server) + +m[5] * 60000;
      if (instant >= original && instant <= original + 12 * 3600000 && instant < Date.parse(record.endAt)) candidates.add(instant);
    }
    if (candidates.size === 1) times.push({ startAt: new Date([...candidates][0]).toISOString(), timingSource: post.url });
  }
  // Conflicting notices need review, not whichever feed happens to sort last.
  const starts = new Set(times.map(time => time.startAt));
  return starts.size === 1 ? { ...record, ...times[0], status: 'announced' } : record;
}

/** The in-game notice board as first-party confirmation that a banner opened (data/official-
 * bulletins.json, sync-official-bulletins.mjs): its banner item links to the pool by the
 * gacha_table id. One board date for the pool, on the regional calendar day the client opens it,
 * marks the window announced. The board gives a day and no time, so it never moves an opening
 * or a closing; a notice's exact time (noticeOpening) stands, and a board date on another day is
 * left for review. The source is the announcement page of the same title and date when there is
 * exactly one, else the board item itself.
 */
export function boardOpening(record, board, server) {
  if (record.status === 'announced' || !record.poolId) return record;
  const items = boardBannerItems(board, record.poolId);
  const dates = new Set(items.map(item => item.displayDate));
  if (dates.size !== 1) return record;
  const [date] = dates;
  if (serverDay(Date.parse(record.startAt) / 1000, SERVER_TIME[server].offset).replaceAll('/', '-') !== date) return record;
  const item = items[0];
  const pages = (board.notices ?? []).filter(notice => notice.url && notice.title === item.title && notice.date === date);
  return { ...record, timingSource: pages.length === 1 ? pages[0].url : `ingame-board:${server}/${item.id}`, status: 'announced' };
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_STAMP = /([A-Z][a-z]+) (\d{1,2}), (\d{4}), (\d{1,2}):([0-5]\d)/g;

/**
 * Global's official posts list a sale as a numbered section:
 *   "10 ... NEW ARRIVALS AT THE OUTFIT STORE" (or "RE-EDITION ... AT THE OUTFIT STORE"),
 *   "DURATION: October 14, 2026, 08:00 - November 11, 2026, 03:59 (UTC-7)",
 *   then one line per outfit, "<Series> - <Outfit> for <Operator>", up to the next section.
 * An outfit is the store outfit of that operator with that name (letters and digits only, so
 * "The Spirit Farer" is "The Spirit-Farer"), else the operator's only store outfit of that series
 * (the post calls Archetto's "Glory to the Devout" "Glory of the Devout", 2026-10-14).
 */
export function englishNoticeSkinWindows(notices, skins) {
  const store = skins.filter(skin => /Outfit Store.*Originite/i.test(skin.howToObtain ?? ''));
  const groups = new Map();
  for (const post of notices) {
    const lines = post.lines ?? [];
    lines.forEach((header, at) => {
      if (!/AT THE OUTFIT STORE|AT OUTFIT STORE/i.test(header) || !/NEW ARRIVALS|RE-EDITION/i.test(header) || !/^\d{2}\s/.test(header)) return;
      const duration = lines.slice(at + 1, at + 3).find(line => /^DURATION:/i.test(line)) ?? '';
      const stamps = [...duration.matchAll(EN_STAMP)].map(m => serverInstant(+m[3], EN_MONTHS.indexOf(m[1]) + 1, +m[2], +m[4], 'en') + +m[5] * 60000);
      if (stamps.length !== 2 || stamps[1] <= stamps[0] || stamps[1] - stamps[0] > 60 * 86400000 || stamps.some(Number.isNaN)) return;
      const fresh = /NEW ARRIVALS/i.test(header);
      const startAt = new Date(stamps[0]).toISOString(), endAt = new Date(stamps[1] + 60000).toISOString();
      const key = `${post.url}/${startAt}/${endAt}/${fresh}`;
      for (const line of lines.slice(at + 1)) {
        if (/^\d{2}\s/.test(line)) break;
        const m = line.match(/^(.+?)\s+-\s+(.+)\s+for\s+(.+)$/);
        if (!m) continue;
        const [, series, outfit, operator] = m.map(fold);
        const theirs = store.filter(skin => fold(skin.model) === operator);
        let skin = theirs.find(row => fold(row.name) === outfit);
        if (!skin) {
          const bySeries = theirs.filter(row => row.series && (series.startsWith(fold(row.series)) || fold(row.series).startsWith(series)));
          if (bySeries.length === 1) skin = bySeries[0];
        }
        if (!skin) continue;
        const record = groups.get(key) ?? { event: post.title, kind: 'shop', label: fresh ? 'New outfits' : 'Returning outfits', startAt, endAt,
          skinIds: [], source: post.url, inventorySource: post.url, estimated: false, newRelease: fresh };
        record.skinIds.push(`${skin.model} / ${skin.name}`);
        groups.set(key, record);
      }
    });
  }
  return [...groups.values()].map(record => ({ ...record, skinIds: [...new Set(record.skinIds)].sort() }));
}

/** Published Japanese sale paragraphs name the exact outfit. Read the following
 * explicit sale interval, never a release association or another region's shop. Global's
 * English posts read by englishNoticeSkinWindows. */
export function noticeSkinWindows(notices, tables, skins, server) {
  if (server === 'en') return englishNoticeSkinWindows(notices, skins);
  const dates = /(?:(\d{4})[年년]\s*)?(\d{1,2})[月월]\s*(\d{1,2})[日일](?:[（(][^）)]*[）)])?\s*(\d{1,2}):([0-5]\d)/gu;
  const groups = new Map();
  for (const post of notices) for (const skin of skins) {
    const local = tables.skin.charSkins?.[skin.skinId];
    const name = local?.displaySkin?.skinName;
    if (!local?.isBuySkin || !name || !/Outfit Store.*Originite/i.test(skin.howToObtain ?? '')) continue;
    const index = post.lines.findIndex(line => line.startsWith(`「${name}」`));
    if (index < 0) continue;
    const after = post.lines.slice(index, index + 28).join('\n');
    if (!/販売期間|販売内容/.test(after)) continue;
    const stamp = [...after.matchAll(dates)].slice(0, 2).map(match => {
      const year = match[1] ? +match[1] : new Date(post.publishTime).getUTCFullYear();
      return serverInstant(year, +match[2], +match[3], +match[4], server) + +match[5] * 60000;
    });
    if (stamp.length !== 2 || stamp[1] <= stamp[0] || stamp[1] - stamp[0] > 60 * 86400000) continue;
    // Notices print the last minute, unlike client timestamps' last second.
    const startAt = new Date(stamp[0]).toISOString(), endAt = new Date(stamp[1] + 60000).toISOString();
    const debut = local.displaySkin.getTime * 1000;
    const fresh = Math.abs(debut - stamp[0]) < 12 * 3600000;
    const key = `${post.url}/${startAt}/${endAt}/${fresh}`;
    const record = groups.get(key) ?? { event: post.title, kind: 'shop', label: fresh ? 'New outfits' : 'Returning outfits', startAt, endAt,
      skinIds: [], source: post.url, inventorySource: post.url, estimated: false, newRelease: false };
    record.skinIds.push(`${skin.model} / ${skin.name}`);
    record.newRelease = fresh;
    groups.set(key, record);
  }
  return [...groups.values()].map(record => ({ ...record, skinIds: [...new Set(record.skinIds)].sort() }));
}

/** How far a client activity's close may sit from the event's Global close and still be its run. */
const SAME_RUN_DAYS = 60;
export function eventActivity(event, english) {
  if (event.activityId && english[event.activityId]) return event.activityId;
  const name = fold(event.name);
  const close = Date.parse(event.global?.endAt ?? String(event.global?.dateRange ?? '').split(/[–—]/)[1]?.trim().replaceAll('/', '-'));
  // A rerun reuses its original's activity, and the client table holds one run of it: the
  // run it last had. Folding drops "Rerun", so "[Rerun] The Masses' Travels Rerun" (Global,
  // estimated for 2026-11) took the original's 2025 window, and JP/KR listed the rerun as over
  // (2026-10-21). The activity must be this run: closing near the event's own Global close, or,
  // for a rerun without one, not taken at all.
  const sameRun = ([, row]) => Number.isFinite(close) ? Math.abs(end(row.endTime) * 1000 - close) <= SAME_RUN_DAYS * 86400000 : !/\brerun\b/i.test(event.name);
  const rows = Object.entries(english).filter(([, row]) => fold(row.name) === name).filter(sameRun);
  if (rows.length === 1) return rows[0][0];
  const near = rows.filter(([, row]) => Number.isFinite(close) && Math.abs(end(row.endTime) * 1000 - close) < 3 * 86400000);
  return near.length === 1 ? near[0][0] : null;
}

export function buildRegionalSchedule({ server, tables, english, events, banners, skins, stages, contents, rewards = [], notices = [], board = null, shopOverrides = [], base }) {
  const source = table => `${base}/${table}_table.json`;
  if (Object.keys(tables.activity?.basicInfo ?? {}).length < 100 || (tables.gacha?.gachaPoolClient?.length ?? 0) < 100
    || Object.keys(tables.zone?.weeklyAdditionInfo ?? {}).length < 9 || Object.keys(tables.stage?.stages ?? {}).length < 1000) throw new Error(`Incomplete ${server} client tables`);
  const activities = Object.fromEntries(Object.entries(tables.activity.basicInfo).flatMap(([id, row]) => {
    const span = window(row.startTime, row.endTime, source('activity'));
    if (!span) return [];
    const close = end(row.rewardEndTime);
    const record = { ...span, localName: row.name, ...(close > end(row.endTime) ? { shopEndAt: iso(close) } : {}) };
    return [[id, noticeOpening(record, notices, server)]];
  }));
  const eventWindows = Object.fromEntries(events.flatMap(event => {
    const id = eventActivity(event, english.activity.basicInfo);
    return id && activities[id] ? [[event.name, { ...activities[id], activityId: id }]] : [];
  }));
  // Permanent themes have an opening, not an invented event close. A single
  // calendar-day marker lets Schedule show launch day while the mode stays permanent.
  for (const event of events.filter(event => event.modeId)) {
    const topic = tables.sandbox_perm?.basicInfo?.[event.modeId];
    if (!topic?.topicStartTime) continue;
    const startAt = iso(topic.topicStartTime);
    eventWindows[event.name] = { startAt, endAt: iso(topic.topicStartTime + 86400),
      releaseDate: serverDay(topic.topicStartTime, SERVER_TIME[server].offset), localName: topic.topicName,
      timingSource: source('sandbox_perm'), modeId: event.modeId };
  }
  const pools = new Map(tables.gacha.gachaPoolClient.map(pool => [pool.gachaPoolId, pool]));
  const bannerWindows = Object.fromEntries(banners.flatMap(banner => {
    const id = regionalPoolId(banner.globalPoolId, server);
    const pool = pools.get(id);
    if (!pool) return [];
    const span = window(pool.openTime, pool.endTime, source('gacha'));
    return span ? [[banner.name, boardOpening(noticeOpening({ ...span, poolId: id, localName: pool.gachaPoolName, status: 'datamined' }, notices, server), board, server)]] : [];
  }));
  const contentWindows = {};
  for (const id of Object.keys(contents)) {
    const activity = activities[id] ?? activities[id.replace(/_[^_]+$/, '')];
    if (activity) contentWindows[id] = [Date.parse(activity.startAt) / 1000, Date.parse(activity.endAt) / 1000];
  }
  for (const season of Object.values(tables.crisis_v2.seasonInfoDataMap ?? {})) {
    if (contents[season.seasonId]) contentWindows[season.seasonId] = [season.startTs, end(season.endTs)];
  }
  const byStage = new Map(stages.map(stage => [stage.id, stage]));
  const annihilation = (tables.campaign.campaignRotateStageOpenTimes ?? []).flatMap(row => {
    const stage = byStage.get(row.stageId);
    return stage ? [{ stageId: row.stageId, slug: stage.slug, contentId: stage.content?.id ?? null, start: row.startTs, end: end(row.endTs) }] : [];
  });
  const sss = Object.values(tables.climb_tower.seasonInfos ?? {}).map(row => ({ id: row.id, number: row.seasonNum, name: row.name, start: row.startTs, end: end(row.endTs), contentIds: row.towers ?? [], replicated: Array.isArray(row.replicatedTowers) ? row.replicatedTowers : [] }));
  const weekly = Object.fromEntries(Object.entries(tables.zone.weeklyAdditionInfo).map(([id, row]) => [id, row.daysOfWeek]));
  const forceOpen = Object.values(tables.stage.forceOpenTable ?? {}).flatMap(row => {
    const span = window(row.startTime, row.endTime, source('stage'));
    return span ? [{ ...span, contentIds: row.forceOpenList ?? [] }] : [];
  });
  const skinReleases = Object.fromEntries(skins.flatMap(skin => {
    const row = tables.skin.charSkins?.[skin.skinId];
    return row?.displaySkin?.getTime > 0 ? [[`${skin.model} / ${skin.name}`, { at: iso(row.displaySkin.getTime), localName: row.displaySkin.skinName, timingSource: source('skin') }]] : [];
  }));
  // stageValidInfo is sparse; zoneValidInfo covers permanent chapter/mode openings.
  const releases = Object.fromEntries(Object.entries(tables.zone.zoneValidInfo ?? {}).filter(([, row]) => row.startTs > 0).map(([id, row]) => [id, row.startTs]));
  const farming = buildEventFarming(tables.stage, english.item).map(drop => {
    const zone = tables.stage.stages[drop.stageId]?.zoneId;
    const activityId = tables.activity.zoneToActivity?.[zone];
    const opening = activities[activityId]?.startAt;
    return opening && opening > drop.startAt ? { ...drop, startAt: opening } : drop;
  });
  const rewardWindows = {};
  const sameItems = (reward, items) => {
    const keys = rows => JSON.stringify((Array.isArray(rows) ? rows : []).map(item => [item.id ?? item.itemId, item.count]).sort());
    return keys(reward.rewards) === keys(items ?? []);
  };
  for (const reward of rewards) {
    if (!reward.startAt && !reward.endAt) continue;
    const [, id, order] = reward.id.split(':');
    const month = tables.checkin.groups?.[id];
    if (month && sameItems(reward, [month.items[Number(order) - 1]].filter(Boolean))) {
      rewardWindows[reward.id] = window(month.signStartTime, month.signEndTime, source('checkin'));
      continue;
    }
    const act = activities[id];
    if (!act) continue;
    for (const type of ['CHECKIN_ONLY', 'CHECKIN_ALL_PLAYER', 'CHECKIN_VS', 'LOGIN_ONLY']) {
      const row = tables.activity.activity?.[type]?.[id];
      const day = Object.values(row?.checkInList ?? row?.checkInDict ?? {}).find(day => String(day.order) === order);
      const items = type === 'LOGIN_ONLY' ? row?.itemList : day?.itemList ?? day?.rewardList;
      if (sameItems(reward, items)) rewardWindows[reward.id] = { ...act, endAt: act.shopEndAt ?? act.endAt };
    }
  }
  const skinWindows = [...noticeSkinWindows(notices, tables, skins, server), ...shopOverrides.filter(row => row.server === server).map(({ server: _server, ...row }) => row)];
  // JP's and KR's own key art for their events and banners, from their in-game boards and KR's
  // official site headline (regional-board.mjs): an address and a hash on the window, which the
  // page shows in place of Global's when the site is in that server's mode. Global's comes from
  // the image repository.
  const art = board ? withBoardArt({ events: eventWindows, banners: bannerWindows }, board) : { events: eventWindows, banners: bannerWindows };
  return { farming, rewardWindows, skinWindows, sources: Object.fromEntries(TABLES.map(table => [table, source(table)])), activities, events: art.events, banners: art.banners, contents: contentWindows, weekly, forceOpen, annihilation, sss, skinReleases, releases };
}

async function json(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export async function regionalNotices(server, fetcher, now) {
  if (server === 'en') return [];
  const recent = now - 60 * 86400000;
  if (server === 'jp') {
    const body = await json('https://www.arknights.jp/api/resource/news/list?index=1&size=30&type=latest', fetcher);
    if (!Array.isArray(body.data?.rows)) throw new Error('Invalid JP notice list');
    const rows = body.data.rows.filter(row => row.publishTime >= recent);
    const result = [];
    for (const row of rows) {
      const post = (await json(`https://www.arknights.jp/api/resource/news/detail?id=${row.id}`, fetcher)).data;
      if (typeof post?.content !== 'string') throw new Error('Invalid JP notice');
      result.push({ url: `https://www.arknights.jp/news/${row.id}`, title: post.title, publishTime: post.publishTime, lines: newsLines(post.content) });
    }
    return result;
  }
  const body = await json('https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/29703924/menus/3/articles?page=1&pageSize=30', fetcher);
  if (!Array.isArray(body.result?.articleList)) throw new Error('Invalid KR notice list');
  const result = [];
  for (const { item } of body.result.articleList) {
    if (item?.menuId !== 3 || item.writeDateTimestamp < recent || !Number.isSafeInteger(item.articleId)) continue;
    const post = (await json(`https://article.cafe.naver.com/gw/v4/cafes/29703924/articles/${item.articleId}`, fetcher)).result?.article;
    if (post?.menu?.id !== 3 || typeof post.contentHtml !== 'string') throw new Error('Invalid KR notice');
    result.push({ url: `https://cafe.naver.com/f-e/cafes/29703924/articles/${item.articleId}`, title: item.subject, publishTime: item.writeDateTimestamp, lines: newsLines(post.contentHtml) });
  }
  return result;
}

export async function syncRegionalSchedules(root, { fetcher = globalThis.fetch, now = defaultNow().getTime() } = {}) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const at = path.join(root, OUTPUT);
  const previous = fs.existsSync(at) ? read(OUTPUT) : { version: 1, servers: {} };
  const stage = beginStage(root, 'regional-schedules', now);
  const events = fs.readdirSync(path.join(root, 'data/events')).filter(name => /^events_\d{4}.json$/.test(name)).flatMap(name => read(`data/events/${name}`));
  const rewards = read('data/free-rewards.json').rewards;
  const shopOverrides = read('config/regional-shop-windows.json').entries;
  const banners = read('data/headhunting_banners.json'), skins = read('data/skins.json'), contents = read('data/stages-content.json');
  const stages = fs.readdirSync(path.join(root, 'data/stages')).filter(name => name.endsWith('.json')).map(name => read(`data/stages/${name}`));
  const pin = pinnedRef('ArknightsAssets/ArknightsGamedata');
  if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error('Regional schedules require a pinned upstream commit');
  const load = async server => {
    const bases = {
      en: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pin}/en/gamedata/excel`,
      jp: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pin}/jp/gamedata/excel`,
      kr: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pin}/kr/gamedata/excel`,
    };
    const base = bases[server];
    if (!base) throw new Error('Unsupported regional client');
    const tables = Object.fromEntries(await Promise.all(TABLES.map(async table => {
      const file = path.join(root, '.cache/regional-tables', pin, server, `${table}_table.json`);
      if (fs.existsSync(file)) return [table, JSON.parse(fs.readFileSync(file, 'utf8'))];
      const value = await json(`${base}/${table}_table.json`, fetcher);
      fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, JSON.stringify(value));
      return [table, value];
    })));
    return { base, tables };
  };
  const english = (await load('en')).tables;
  const boards = readOfficialBulletins(root).regions;
  const servers = { ...previous.servers };
  for (const server of ['en', 'jp', 'kr']) {
    try {
      const { base, tables } = server === 'en' ? { tables: english, base: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pin}/en/gamedata/excel` } : await load(server);
      let notices = [];
      try {
        const news = path.join(root, 'data/official-news/global');
        notices = server === 'en' ? (fs.existsSync(news) ? fs.readdirSync(news).filter(file => /^\d+\.json$/.test(file)).map(file => JSON.parse(fs.readFileSync(path.join(news, file), 'utf8'))) : []) : await regionalNotices(server, fetcher, now);
      }
      catch (error) {
        console.warn(`${server} notices: ${error.message}`);
        stage.add({ key: `${server}:notices`, reason: 'Regional official notices could not be read; prior announcement overrides are retained.', action: 'kept-previous' });
      }
      const next = buildRegionalSchedule({ server, tables, english, events, banners, skins, stages, contents, rewards, notices, board: server === 'en' ? null : boards[server], shopOverrides, base });
      // A notice-feed outage or old notice leaving the bounded list cannot undo its confirmed opening.
      for (const kind of ['activities', 'events', 'banners']) for (const [id, old] of Object.entries(previous.servers?.[server]?.[kind] ?? {})) {
        const row = next[kind][id];
        if (old.status === 'announced' && row && row.endAt === old.endAt && row.status !== 'announced') next[kind][id] = { ...row, startAt: old.startAt, timingSource: old.timingSource, status: old.status };
      }
      // Preserve confirmed historical shops after their notice leaves the bounded feed.
      const keys = new Set(next.skinWindows.map(row => `${row.source}/${row.startAt}/${row.endAt}`));
      next.skinWindows.push(...(previous.skinParserVersion === 2 ? previous.servers?.[server]?.skinWindows ?? [] : []).filter(row => !keys.has(`${row.source}/${row.startAt}/${row.endAt}`)));
      servers[server] = next;
      console.log(`${server}: ${Object.keys(next.events).length} event windows, ${Object.keys(next.banners).length} banners, ${Object.keys(next.weekly).length} daily rotations`);
    } catch (error) {
      console.warn(`${server}: ${error.message}`);
      stage.add({ key: `${server}:tables`, reason: 'Regional client tables are unavailable or incomplete; no Global schedule was substituted.', action: servers[server] ? 'kept-previous' : 'omitted-new' });
    }
  }
  if (!servers.jp || !servers.kr) throw new Error('Initial JP/KR schedules are required');
  // Preserve published EN notices too: the client opening can be maintenance
  // preloading. The existing reconciler will retain this first-party correction.
  for (const file of fs.readdirSync(path.join(root, 'data/events')).filter(file => /^events_\d{4}\.json$/.test(file))) {
    const records = read(`data/events/${file}`);let changed = false;
    for (const event of records) {
      const time = servers.en?.events?.[event.name];
      if (!time || time.status !== 'announced' || event.modeId || Date.parse(time.endAt) < now - 45 * 86400000 || !event.global) continue;
      if (/^https:\/\/(?:www\.)?arknights\.global\/news\//.test(event.global.timingSource ?? '')) continue;
      event.global = { ...event.global, startAt: time.startAt, endAt: time.endAt,
        dateRange: `${serverDay(Date.parse(time.startAt) / 1000, SERVER_TIME.en.offset)}–${serverDay(Date.parse(time.endAt) / 1000, SERVER_TIME.en.offset)}`,
        timingSource: time.timingSource, note: null };changed = true;
    }
    if (changed) fs.writeFileSync(path.join(root, 'data/events', file), `${JSON.stringify(records, null, 2)}\n`);
  }
  fs.writeFileSync(at, `${JSON.stringify({ version: 1, skinParserVersion: 2, servers })}\n`);stage.commit();
  return servers;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) syncRegionalSchedules(process.cwd()).catch(error => { console.error(error);process.exitCode = 1; });
