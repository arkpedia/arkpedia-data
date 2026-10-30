#!/usr/bin/env node
/**
 * Writes data/event-rewards.json: for each event, what the game tables and the official
 * announcements say it gives beyond its store, each group with the source it came from.
 *
 * From the game tables (Global's; CN's for an event Global has not had yet, below):
 *
 *   login          a sign-in event's daily rewards (activity_table CHECKIN_ONLY /
 *                  CHECKIN_ALL_PLAYER / CHECKIN_VS), totalled and day by day
 *   banner-gift    a one-off login gift, such as the limited banner's ten-roll permit (LOGIN_ONLY)
 *   pray           a draw login (Lucky Strips, PRAY_ONLY): the table has its rules, not its payouts
 *   milestones     a mode's milestone track (Duel Channel's "Vine Program"): the points it takes,
 *                  and what its steps give
 *   missions       the event's missions (activity_table missionData, by missionGroup)
 *   first-clear    what a story event's stages give on their first clear (stage_table, dropType
 *                  COMPLETE); a mode's "stages" are not a campaign (isStoryActivity)
 *
 * From the official Global announcements (data/official-news/global, sync-official-news.mjs), each
 * section of an event's post belonging to that event:
 *
 *   packs          the packs sold for real money during the event, with their stated CONTENTS
 *   free-rolls     the limited banner's daily free roll: one a day over the section's DURATION
 *   notice         a gift, mail, free-headhunting or draw section, or a login no table details,
 *                  as the post words it (prose, never counted)
 *
 * And from building_data:
 *
 *   furniture-set  each set the event's rewards are pieces of (or its post names): every piece,
 *                  and how the game says each is obtained (event reward, furniture store)
 *
 * A rerun shows its original run's missions, first clears and furniture sets until the tables
 * carry its own: each such group is marked `inherited`, and the entry `inheritsFrom`.
 *
 * CN: an event Global has not had yet (no Global date, or one still ahead) is built from the CN
 * tables, in English where the Global tables have the item and in the CN client's words where
 * not (2026-10-03: "CN only stuff you can keep in CN till global release"); its entry and every
 * group are marked region 'CN', as is a furniture set only the CN client has. On a day the CN
 * tables come from the mirror that numbers the game's enums (cn-tables.mjs), which this reads by
 * name, no CN group can be read: the entries built from CN stay as the last run wrote them.
 *
 * Stores are not here. An event's store is data/event-stores.json (sync-event-stores.mjs, the
 * wiki's listings); the event record's own `rewards`, a one-off wiki import, is only the page's
 * fallback for an event the wiki lists no store for. Two lists here serve that fallback: storeNames
 * (its Chinese item names in English, where the Global tables have them) and storeFurniture (its
 * items that are furniture pieces).
 *
 * Which event a table activity belongs to: the event's own activity is the one whose name is the
 * event's without its "[Side Story]"-style prefix and which opens on the event's Global start (on
 * CN, the one activity of its kind opening on its CN start); a sign-in, gift or draw belongs to
 * the event an announcement names for it, else to the latest one opened by the end of its first
 * day and still running, a story event before a mode opening with it (the same grouping an
 * event's official announcement makes). Events with no date, or none the tables name, are left
 * out.
 *
 * Reads ARKPEDIA_EN (a checkout holding en/gamedata/excel; else .cache/upstream/en-gamedata) and
 * ARKPEDIA_CN (a checkout holding gamedata/excel; else .cache/upstream/cn-resource, where
 * cn-tables.mjs links the CN tables it settled on for the run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeEntities, leftoverEntity, newsSections, parseDuration, parsePacks, parseLoginDays, parseSelectorTickets, postEventName, postWindow } from './official-news.mjs';
import { eventTitle, eventWindow, isRerun } from '../lib/event-records.mjs';
import { cnTables } from '../content/pin-upstream.mjs';
import { readOfficialNews } from '../sync/sync-official-news.mjs';
import { readOfficialBulletins } from '../sync/sync-official-bulletins.mjs';
import { boardBannerItems, boardEventItems, pagePicture } from '../sync/regional-board.mjs';

const LOGIN_TYPES = new Set(['CHECKIN_ONLY', 'CHECKIN_ALL_PLAYER', 'CHECKIN_VS']);
/* The side activities an event carries beside its own: its sign-ins (LOGIN_TYPES), its one-off
   login gift (LOGIN_ONLY), its draw login (PRAY_ONLY), and the logins the tables name and date but
   give no rewards for (a festival's blessing sign-in, BLESS_ONLY; a flip-card login, FLIP_ONLY),
   whose rewards are the announcement's. None of them is ever an event's own activity. */
const SIDE_TYPES = new Set([...LOGIN_TYPES, 'LOGIN_ONLY', 'PRAY_ONLY', 'BLESS_ONLY', 'FLIP_ONLY']);
/*
 * The event kinds whose stages are a story campaign, and so give their first-clear rewards. A
 * mode's "stages" are not (Duel Channel's two entries list an Originite Prime the mode never
 * gives: its rewards are its milestones), nor are a Contingency Contract's (TYPE_ACT5D1) or
 * anything filed as DEFAULT (Reclamation Algorithm, Pinch-Out).
 */
export const isStoryActivity = type => /^TYPE_ACT\d+SIDE$/.test(type) || ['TYPE_ACT9D0', 'TYPE_ACT3D0', 'TYPE_ACT4D0', 'TYPE_ACT5D0', 'MINISTORY', 'TYPE_MAINSS', 'YEAR_5_GENERAL'].includes(type);
/** Where a mode keeps its milestone track (points needed -> reward), under one of these names. */
const MILESTONE_LISTS = ['milestoneList', 'mileStoneList', 'mileStoneItemList', 'milestoneData'];
// The kinds a reward is, by the table's own item type: what the page groups and icons by.
const KIND = {
  MATERIAL: 'material', CARD_EXP: 'material', GOLD: 'currency', DIAMOND: 'currency', DIAMOND_SHD: 'currency',
  TKT_GACHA: 'permit', TKT_RECRUIT: 'permit', TKT_INST_FIN: 'permit', LIMITED_TKT_GACHA_10: 'permit',
  LINKAGE_TKT_GACHA_10: 'permit', CLASSIC_TKT_GACHA: 'permit', AP_SUPPLY: 'sanity', FURN: 'furniture',
  CHAR: 'operator', CHAR_SKIN: 'outfit', ACTIVITY_ITEM: 'event-item', VOUCHER_MGACHA: 'voucher',
  ITEM_PACK: 'material',
};
const list = value => (Array.isArray(value) ? value : []);
const fold = name => String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/* A name as the tables and the event records both spell it: a rerun is "X - Rerun", "X -
   Retrospection" or "X - Retrospective" in the tables and "X Rerun" in the records, and a
   numbered run ("Trials for Navigator #3") is one name in the tables. */
const key = name => fold(String(name ?? '').replace(/#\s*\d+\s*$/, '').replace(/[\s:–-]*(rerun|retrospection|retrospective)\s*$/i, ''));
/* When an event opens in a region, in seconds as the tables date their activities
   (eventWindow, scripts/lib/event-records.mjs: the client's own instant where the record has one). */
const startIn = region => event => {
  const window = eventWindow(event, region);
  return window ? window.start / 1000 : null;
};
const globalStart = startIn('Global');
const cnStart = startIn('CN');
/** Pending Global runs, including reruns, prefer their own CN activity over inheritance. */
export const awaitsGlobal = (event, now) => (globalStart(event) ?? Infinity) > now;

/** Names for a table reward: { name, count, kind, id }. */
export function rewardNamer(tables) {
  const items = tables.items?.items ?? {};
  const furniture = tables.building?.customData?.furnitures ?? {};
  const characters = tables.characters ?? {};
  const skins = tables.skins?.charSkins ?? {};
  // The cosmetics and mode pieces the item table does not hold, named as the official posts
  // word them ("Icon 'Destination'", "Home Screen UI [Poly Vision]", "Profile Theme 'Vista'").
  const meta = tables.displayMeta ?? {};
  const quoted = text => `'${String(text).replace(/^['“]|['”]$/g, '')}'`;
  const cosmetics = new Map([
    ...list(meta.playerAvatarData?.avatarList).filter(a => a.avatarItemName).map(a => [a.avatarId, `Icon ${quoted(a.avatarItemName)}`]),
    ...list(meta.homeBackgroundData?.homeBgDataList).filter(b => b.bgName).map(b => [b.bgId, `Main Menu Background ${quoted(b.bgName)}`]),
    ...list(meta.homeBackgroundData?.themeList).filter(t => t.tmName).map(t => [t.id, `Home Screen UI ${quoted(t.tmName)}`]),
    ...Object.values(meta.nameCardV2Data?.skinData ?? {}).filter(c => c.name).map(c => [c.id, `Profile Theme ${quoted(c.name)}`]),
    // charm_table as the stage pipeline reads it (drops.mjs): its charmList, or a bare list.
    ...list(tables.charms?.charmList ?? tables.charms).map(c => [c.id, c.name]),
  ]);
  // Ideal City's cart parts (ACT_CART_COMPONENT), in the activity table's carData.
  const pieces = new Map(Object.values(tables.activity?.carData?.carDict ?? {}).map(part => [part.compId, part.name]));
  return reward => {
    const { id, type } = reward;
    let name = items[id]?.name ?? cosmetics.get(id) ?? pieces.get(id);
    // A rerun's copy of an event token ("act42side_token_pacifier_rep_1") is the same item under a
    // new id, and the game names it as the original (act12side_token_coupon_rep_1 and
    // act41side_token_light_rep_1 in Global's table). Global's table gains the copy only with the
    // rerun's patch, while the rerun's missions are listed weeks before from CN's: until then it
    // takes the original's name (The Masses' Travels Rerun, 2026-10-28).
    if (!name && typeof id === 'string' && /_rep_\d+$/.test(id)) name = items[id.replace(/_rep_\d+$/, '')]?.name;
    // A piece of furniture is sometimes typed NONE (Grani's mission reward): named by its id.
    if (type === 'FURN' || (!name && furniture[id])) name = furniture[id]?.name;
    if (type === 'CHAR') name = characters[id]?.name;
    if (type === 'CHAR_SKIN') {
      const skin = skins[id];
      name = skin ? `${characters[skin.charId]?.name ?? skin.charId} / ${skin.displaySkin?.skinName ?? id}` : null;
    }
    // A ten-roll permit the table names like a single one ("Sing while Drinking Headhunting
    // Permit", LIMITED_TKT_GACHA_10) says so: it is ten pulls, not one.
    if (name && /TKT_GACHA_10$/.test(type) && !/ten-roll/i.test(name)) name = `${name} (ten-roll)`;
    return { name: name ?? id, count: reward.count, kind: KIND[type] ?? (furniture[id] ? 'furniture' : 'other'), id };
  };
}

/** Totals a list of rewards by id, in first-seen order. */
function total(rewards) {
  const byId = new Map();
  for (const reward of rewards) {
    const held = byId.get(reward.id);
    if (held) held.count += reward.count; else byId.set(reward.id, { ...reward });
  }
  return [...byId.values()];
}

/** The kind of a reward named only by its English name (a pack's CONTENTS): the item table's. */
function kindByName(tables) {
  const byName = new Map(Object.values(tables.items?.items ?? {}).map(item => [item.name, KIND[item.itemType] ?? KIND[item.classifyType] ?? null]));
  return name => byName.get(name) ?? (/headhunting permit/i.test(name) ? 'permit' : 'other');
}

const NOTICE = /GIFT|MAIL|FREE|LUCKY|SUPPLY|REWARD|COMPENSATION|STRIPS/;
const GENERIC = new Set(['login', 'event', 'events', 'sign', 'in', 'open', 'opens', 'limited', 'time', 'special', 'cumulative', 'new', 'update', 'the', 'a', 'of', 'and', 'campaign', 'now']);
/** A login's name without its generic words and years: what tells two logins apart. */
const distinctive = title => new Set(String(title ?? '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').split(/[^a-z]+/).filter(w => w.length > 2 && !GENERIC.has(w)));
const NOT_NOTICE = /PACK|LOGIN|SIGN-IN|SIGN IN|OUTFIT|HEADHUNTING OPEN|FURNITURE/;
/** A post section the event page already shows in a tab of its own: the limited banner (Banner),
 *  outfits and the Fashion Review (Skins), furniture (Furniture). The rest of an announcement that no
 *  other group takes is the event's news (NEWS_LINES). */
const SHOWN_ELSEWHERE = /HEADHUNTING OPEN|LIMITED HEADHUNTING|OUTFIT|FASHION REVIEW|FURNITURE/;
/** The most lines a news section keeps: an announcement's longest lists (a selector's pool, a
 *  Kernel Locating banner's operators) fit; a runaway parse does not fill the page. */
const NEWS_LINES = 40;

/** A namer that names an id the Global tables know in English, and any other by `fallback`'s. */
function regionalNamer(primary, fallback) {
  const english = rewardNamer(primary);
  const local = fallback ? rewardNamer(fallback) : null;
  return reward => {
    const named = english(reward);
    return named.name === reward.id && local ? local(reward) : named;
  };
}

/*
 * One region's tables: each event's own activity, the sign-ins, gifts and draws that belong to it,
 * and its missions and first clears. `match` finds an event's own activity among those opening
 * near `startOf(event)`.
 */
function tableGroups(events, tables, { startOf, match, name, region, claims = [] }) {
  const activity = tables.activity;
  const info = activity.basicInfo ?? {};
  const day = seconds => new Date(seconds * 1000).toISOString();
  const tag = region === 'CN' ? { region: 'CN' } : {};
  const src = text => (region === 'CN' ? `CN ${text}` : text);
  const own = [];
  const ownSide = new Map();
  const near = (entry, start) => Math.abs(entry.startTime - start) <= 2 * 86400;
  for (const event of events) {
    const start = startOf(event);
    if (start == null) continue;
    const opened = Object.values(info).filter(entry => near(entry, start));
    const found = match(event, opened, start);
    if (found) { own.push({ event, activity: found }); continue; }
    // An event that is a sign-in of its own ("2021 Login Event", "Lifestyle Aid"): the one
    // sign-in that opens on its start.
    // Not one an announcement claims for another event.
    const logins = opened.filter(entry => LOGIN_TYPES.has(entry.type) && Math.abs(entry.startTime - start) <= 86400
      && !claims.some(c => c.event !== event.name && Math.abs(c.start - entry.startTime) <= 86400));
    if (logins.length === 1) { own.push({ event, activity: logins[0] }); ownSide.set(logins[0].id, event); }
  }
  own.sort((a, b) => a.activity.startTime - b.activity.startTime);
  const result = {};
  const groupsOf = entry => (result[entry.event.name] ??= { activity: entry.activity.id, ...tag, groups: [] }).groups;
  // The event a side activity belongs to: the one an announcement names for a login opening then
  // (claims: { event, start }), else the latest one opened by the end of the login's first day (a
  // login opening hours before its event's stages is still that event's), and still running.
  // Either way, of two events the story event first: two announcements of the same day can both
  // mention one login (an anniversary sign-in in the side story's post and in a mode's), and a
  // story and a mode open together. Then by name, so the order the records list them in never
  // decides it.
  const storyFirst = (a, b) => Number(isStoryActivity(b.activity.type)) - Number(isStoryActivity(a.activity.type))
    || (a.event.name < b.event.name ? -1 : a.event.name > b.event.name ? 1 : 0);
  const ownerOf = side => {
    const claimed = claims.filter(c => Math.abs(c.start - side.startTime) <= 86400)
      .map(c => own.find(entry => entry.event.name === c.event)).filter(Boolean).sort(storyFirst)[0];
    if (claimed) return claimed;
    const open = own.filter(entry => entry.activity.startTime <= side.startTime + 86400 && side.startTime < entry.activity.endTime);
    const latest = Math.max(...open.map(entry => entry.activity.startTime));
    return open.filter(entry => entry.activity.startTime === latest).sort(storyFirst)[0];
  };
  const titleOf = id => activity.homeActConfig?.[id]?.actTopBarText || info[id]?.name;
  for (const side of Object.values(info).filter(entry => SIDE_TYPES.has(entry.type)).sort((a, b) => a.startTime - b.startTime)) {
    const owner = ownSide.has(side.id) ? own.find(entry => entry.activity.id === side.id) : ownerOf(side);
    if (!owner) continue;
    const base = { title: titleOf(side.id), source: src(`activity_table ${side.id}`), start: day(side.startTime), end: day(side.endTime), ...tag };
    if (LOGIN_TYPES.has(side.type)) {
      const data = activity.activity?.[side.type]?.[side.id];
      const daily = Object.values(data?.checkInList ?? {}).sort((a, b) => a.order - b.order).map(entry => list(entry.itemList).map(name));
      if (!daily.length) continue;
      groupsOf(owner).push({ kind: 'login', ...base, days: daily.length, items: total(daily.flat()), daily });
    } else if (side.type === 'LOGIN_ONLY') {
      const items = list(activity.activity?.LOGIN_ONLY?.[side.id]?.itemList).map(name);
      if (items.length) groupsOf(owner).push({ kind: 'banner-gift', ...base, items });
    } else if (side.type === 'PRAY_ONLY') {
      const rules = activity.dynActs?.[side.id];
      groupsOf(owner).push({ kind: 'pray', ...base, items: [], rules: [rules?.rule1, rules?.rule2].filter(Boolean) });
    }
  }
  for (const entry of own) {
    const id = entry.activity.id;
    // A mode's milestone track: the points it takes, and what each milestone gives.
    const data = activity.activity?.[entry.activity.type]?.[id];
    const track = MILESTONE_LISTS.map(field => data?.[field]).find(value => Array.isArray(value) && value.length);
    if (track) {
      const rewards = track.map(step => step.reward ?? step.rewardItem ?? step.item).filter(reward => reward?.id);
      const points = Math.max(...track.map(step => step.tokenNum ?? step.needPointCnt ?? 0));
      // The points are an item (milestoneItemId, milestonePointId or milestoneId by mode), the
      // track has a name of its own ("Ivy Vine Program").
      const c = data?.constData ?? {};
      const pointName = tables.items?.items?.[c.milestoneItemId ?? c.milestonePointId ?? c.milestoneId]?.name ?? null;
      const trackName = c.milestonePlanName ?? c.milestoneNameEN ?? c.milestoneName ?? 'Milestones';
      if (rewards.length) groupsOf(entry).push({ kind: 'milestones', title: `${trackName}: ${track.length} steps${points ? `, up to ${points.toLocaleString('en-US')} ${pointName ?? 'points'}` : ''}`, source: src(`activity_table ${id}`), count: track.length, points, pointName, items: total(rewards.map(name)), ...tag });
    }
    const missions = list(activity.missionData).filter(mission => mission.missionGroup === id);
    const missionRewards = total(missions.flatMap(mission => list(mission.rewards)).map(name));
    if (missionRewards.length) groupsOf(entry).push({ kind: 'missions', title: 'Event missions', source: src(`activity_table missionData ${id}`), count: missions.length, items: missionRewards, ...tag });
    // The event's stages: by their zone's activity, or by their id for an original whose stages a
    // rerun's zones have since taken over (act15side's are in act15sre's zones).
    const zones = activity.zoneToActivity ?? {};
    const stages = Object.values(tables.stages?.stages ?? {}).filter(stage => zones[stage.zoneId] === id || String(stage.stageId).startsWith(`${id}_`));
    // A stage's first-clear rewards: its COMPLETE drops, less the event's own currency.
    const firstClearOf = stage => list(stage.stageDropInfo?.displayDetailRewards).filter(reward => reward.dropType === 'COMPLETE' && reward.type !== 'ACTIVITY_ITEM');
    const firstClear = stages.flatMap(stage => firstClearOf(stage).map(reward => name({ ...reward, count: reward.count ?? 1 })));
    if (firstClear.length && isStoryActivity(entry.activity.type)) {
      groupsOf(entry).push({ kind: 'first-clear', title: 'Event stage first clears', source: src(`stage_table ${id}`), count: stages.filter(stage => firstClearOf(stage).length).length, items: total(firstClear), ...tag });
    }
  }
  return result;
}

/** Which kinds a rerun takes from its original run until its own appear: what a rerun repeats. */
const RERUN_REPEATS = new Set(['missions', 'first-clear', 'furniture-set']);

/**
 * @param cn the CN tables ({ activity, stages, items, building, characters, skins }), or null: an
 *   event Global has not had yet is built from them, in the CN client's words where Global has no
 *   name for an item (2026-10-03: "CN only stuff you can keep in CN till global release").
 */
export function buildEventRewards(events, tables, posts, cn) {
  if (!Array.isArray(posts) || cn === undefined) throw new Error('buildEventRewards needs the posts ([] for none) and the CN tables (null for none)');
  // A post cached before its entities were decoded twice keeps "&apos;" in its lines: decoded here.
  posts = posts.map(post => ({ ...post, lines: (post.lines ?? []).map(decodeEntities) }));
  const name = rewardNamer(tables);
  // The official announcements, each matched to the event it announces: the one opening on the
  // post's first DURATION whose name the post's title carries. Each login section's DURATION
  // claims the login opening then for that event.
  const dated = events.map(event => ({ event, start: globalStart(event), title: fold(eventTitle(event.name)) })).filter(entry => entry.start != null);
  const announced = posts.map(post => {
    const window = postWindow(post.lines ?? []);
    if (!window) return null;
    const start = Date.parse(window.start) / 1000;
    const named = fold(postEventName(post.title));
    const entry = dated.find(candidate => Math.abs(candidate.start - start) <= 1.5 * 86400 && named && (candidate.title.includes(named) || named.includes(candidate.title)));
    return entry ? { post, event: entry.event, sections: newsSections(post.lines ?? []), art: post.art ?? [] } : null;
  }).filter(Boolean);
  const sectionStart = section => {
    const line = section.lines.map(l => l.match(/^DURATION:\s*(.*)$/)).find(Boolean);
    const window = line && parseDuration(line[1]);
    return window ? { start: Date.parse(window.start) / 1000, end: window.end ? Date.parse(window.end) / 1000 : null } : null;
  };
  // A change to the game's sign-in system ("CUMULATIVE SIGN-IN SYSTEM UPDATE") is not a login event
  // to collect: it is news (4814, 2026-10-14).
  const isLogin = title => /LOGIN|SIGN-IN|SIGN IN/.test(title) && !/SYSTEM UPDATE/.test(title);
  const claims = announced.flatMap(({ event, sections }) => sections.filter(s => isLogin(s.title)).map(s => ({ event: event.name, start: sectionStart(s)?.start })).filter(c => c.start != null));
  // Global: its own activity has the event's name and opens on its Global start; a rerun's
  // "Retrospection" and a numbered run's "#3" are the same name.
  const result = tableGroups(events, tables, {
    startOf: globalStart, name, region: 'Global', claims,
    match: (event, opened) => {
      const title = key(eventTitle(event.name));
      // Or the end of it ("Back to Castle" for "Integrated Lookback: Back to Castle").
      return opened.find(entry => !SIDE_TYPES.has(entry.type) && key(entry.name) === title)
        ?? opened.find(entry => !SIDE_TYPES.has(entry.type) && title.length >= 6 && key(entry.name).startsWith(title))
        ?? opened.find(entry => !SIDE_TYPES.has(entry.type) && key(entry.name).length >= 8 && title.endsWith(key(entry.name)));
    },
  });
  // CN, for an event Global has not had yet (no Global date, or one still ahead): the CN tables'
  // names are Chinese, so its own activity is the one event of its kind opening on its CN start.
  if (cn) {
    const now = Date.now() / 1000;
    const pending = events.filter(event => !result[event.name] && awaitsGlobal(event, now));
    const cnResult = tableGroups(pending, cn, {
      startOf: cnStart, name: regionalNamer(tables, cn), region: 'CN',
      match: (event, opened, start) => {
        const exact = event.activityId && opened.find(entry => entry.id === event.activityId);
        if (exact) return exact;
        const candidates = opened.filter(entry => !SIDE_TYPES.has(entry.type) && !!entry.isReplicate === isRerun(event.name) && Math.abs(entry.startTime - start) <= 86400);
        return candidates.length === 1 ? candidates[0] : null;
      },
    });
    Object.assign(result, cnResult);
  }
  // Each announcement's sections, as its event's.
  const kindOf = kindByName(tables);
  // Official notice 4814 uses these English names before the Global client update. Keep
  // their existing official art while displaying the announcement's spelling.
  const announcementArt = { 'A Sealed Vow Headhunting Permit': 'A Sealed Vow Headhunting Permit (ten-roll)', 'New Model Data Terminal': 'New Information Terminal' };
  const themesNamed = new Map();
  for (const { post, event, sections, art } of announced) {
    const groups = (result[event.name] ??= { activity: null, groups: [] }).groups;
    // A post may open two sections under one heading, and two posts can word one section alike:
    // one group of each kind and title, each later section adding only the lines it does not
    // share (the output guard refuses a heading shown twice). A free roll's days are the first
    // section's, as a pack is the first pack of its name.
    const sameGroup = (kind, title) => groups.find(g => g.kind === kind && g.title === title);
    const addNotice = (title, lines) => {
      const same = sameGroup('notice', title);
      if (same) same.lines.push(...lines.filter(line => !same.lines.includes(line)));
      else groups.push({ kind: 'notice', title, source: post.url, items: [], lines });
    };
    const own = fold(eventTitle(event.name));
    // The rest of the announcement: what changes with the event besides its rewards (a Sanity limit
    // raised, a recruitment pool, a store's new redeemables, a Kernel Locating banner). Shown as the
    // official post words it, under its heading, on the event page's News tab (2026-10-14: "a News
    // section or QOL section, with all the other changes"). The event's own section is its page.
    // The post's pictures go with it, where it has them (newsArt). The one the post opens with is
    // its own (postArt). Each other one is the section's it stands in, `at` the line it stands
    // above (the end, when that is past the lines kept), or -1 when it stands right above the
    // section's heading: the post heads most sections with a title picture.
    const postArt = art.find(picture => !sections.length || picture.line <= sections[0].at)?.url;
    const sectionArt = section => {
      const next = sections[sections.indexOf(section) + 1]?.at ?? Infinity;
      return art.filter(picture => picture.line >= section.at && picture.line < next)
        .map(picture => ({ url: picture.url, at: Math.min(picture.line - section.at - 1, Math.min(section.lines.length, NEWS_LINES)) }));
    };
    const addNews = section => {
      const lines = section.lines.slice(0, NEWS_LINES);
      if (!lines.length || (own.length >= 6 && fold(section.title).includes(own)) || sameGroup('news', section.title)) return;
      const pictures = sectionArt(section);
      groups.push({ kind: 'news', title: section.title, source: post.url, ...(Number.isFinite(post.publishTime) ? { published: new Date(post.publishTime).toISOString() } : {}), items: [], lines,
        ...(pictures.length ? { art: pictures } : {}), ...(postArt ? { postArt } : {}) });
    };
    for (const section of sections) {
      const when = sectionStart(section);
      const lines = section.lines.filter(line => /^(DURATION|DETAILS|REWARDS?|NOTE|HOW TO OBTAIN):/.test(line)).slice(0, 8);
      if (isLogin(section.title) && !/PACK/.test(section.title)) {
        // A login the tables give no rewards for (a festival blessing, a flip-card login): as the
        // post words it, so it is not lost. One the tables detail is already its own group.
        // Matched by the distinctive words of its name ("COMING OF BLESSINGS LOGIN EVENT" is the
        // "Coming of Blessings Sign-In Event"); a section with none ("SPECIAL LOGIN EVENT OPEN")
        // is the banner gift opening that day. A date alone would hide a festival sign-in behind
        // the banner gift that opens with it. A post may also name a login differently from the
        // tables ("LUMINOUS DAYLIGHT" is the "May the Sunshine Still Sign-In Event"): a sign-in
        // over the same window to the hour, the same number of days where the post states one,
        // is the same; a banner gift is the same where the post names its permit. A window alone
        // never matches a banner gift: the festival blessings sign-in shares its window.
        const words = distinctive(section.title);
        const logins = groups.filter(g => g.kind === 'login' || g.kind === 'banner-gift');
        const text = section.lines.join(' ').toLowerCase();
        const stated = Number(text.match(/(?:log|sign) in (?:cumulatively )?for (\d+) days/)?.[1]) || null;
        const sameWindow = g => g.kind === 'login' && when?.end && g.start && g.end
          && Math.abs(Date.parse(g.start) / 1000 - when.start) <= 7200 && Math.abs(Date.parse(g.end) / 1000 - when.end) <= 7200
          && (stated === null || g.days === stated);
        const namesGift = g => g.kind === 'banner-gift' && g.items.some(item => text.includes(item.name.replace(/\s*\(ten-roll\)$/, '').toLowerCase()));
        const detailed = logins.some(g => sameWindow(g) || namesGift(g)) || (words.size
          ? logins.some(g => [...distinctive(g.title)].some(w => words.has(w)))
          : when && logins.some(g => g.kind === 'banner-gift' && Math.abs(Date.parse(g.start) / 1000 - when.start) <= 86400));
        if (!detailed) {
          const daily = parseLoginDays(section).map(day => day.map(item => ({ ...item, kind: item.kind ?? kindOf(item.name), id: `announcement:${item.name}`, ...(announcementArt[item.name] ? { iconName: announcementArt[item.name] } : {}) })));
          if (daily.length && daily.every(day => day.length)) groups.push({ kind: 'login', title: section.title, source: post.url, region: 'Global', ...(when ? { start: new Date(when.start * 1000).toISOString(), end: new Date(when.end * 1000).toISOString() } : {}), days: daily.length, daily, items: total(daily.flat()), description: section.lines.find(line => line.startsWith('DETAILS:'))?.replace(/^DETAILS:\s*/, '') ?? null });
          else if (section.lines.length) addNotice(section.title, section.lines);
        }
        continue;
      }
      if (/FREE (?:ROLL|HEADHUNTING|PULL)|DAILY FREE/.test(section.title) && when?.end) {
        // The limited banner's daily free roll: one a day for the window's days.
        const days = Math.round((when.end - when.start) / 86400);
        if (days > 0 && !sameGroup('free-rolls', section.title)) groups.push({ kind: 'free-rolls', title: section.title, source: post.url, days, items: [{ name: 'Daily free headhunting roll', count: days, kind: 'free-roll', id: 'free-roll' }] });
        continue;
      }
      if (/PACK/.test(section.title)) {
        const packs = parsePacks(section).map(pack => ({ ...pack, contents: pack.contents.map(item => ({ ...item, kind: kindOf(item.name) })) }));
        // "LIMITED-TIME PACKS AVAILABLE" twice: one list.
        const same = sameGroup('packs', section.title);
        if (same) {
          same.packs.push(...packs.filter(pack => !same.packs.some(p => p.name === pack.name)));
          same.tickets = { ...parseSelectorTickets(section, post.url), ...same.tickets };
        }
        else if (packs.length) groups.push({ kind: 'packs', title: section.title, source: post.url, region: 'Global', items: [], packs, tickets: parseSelectorTickets(section, post.url) });
      } else if (NOTICE.test(section.title) && !NOT_NOTICE.test(section.title)) {
        if (lines.length) addNotice(section.title, lines);
      } else if (!SHOWN_ELSEWHERE.test(section.title)) {
        addNews(section);
      }
      const set = section.title.match(/FURNITURE SET\s*[–—:-]\s*(.+)$/);
      if (set) {
        if (!themesNamed.has(event.name)) themesNamed.set(event.name, new Set());
        themesNamed.get(event.name).add(fold(set[1]));
      }
    }
  }
  // Furniture sets: the themes of the furniture an event's rewards include, or that its post names.
  // The Global names first; a set Global has not had yet in the CN client's.
  const furniture = { ...cn?.building?.customData?.furnitures, ...tables.building?.customData?.furnitures };
  const themes = { ...cn?.building?.customData?.themes, ...tables.building?.customData?.themes };
  for (const [eventName, entry] of Object.entries(result)) {
    const ids = new Set(entry.groups.flatMap(group => group.items).filter(item => item.kind === 'furniture').map(item => furniture[item.id]?.themeId).filter(Boolean));
    for (const theme of Object.values(themes)) if (themesNamed.get(eventName)?.has(fold(theme.name))) ids.add(theme.id);
    for (const themeId of ids) {
      const theme = themes[themeId];
      if (!theme) continue;
      const pieces = Object.values(furniture).filter(piece => piece.themeId === themeId).sort((a, b) => (a.sortId ?? 0) - (b.sortId ?? 0))
        .map(piece => ({ name: piece.name, id: piece.id, obtain: piece.obtainApproach ?? null, comfort: piece.comfort ?? null }));
      const global = Boolean(tables.building?.customData?.themes?.[themeId]);
      entry.groups.push({ kind: 'furniture-set', themeId, title: theme.name, source: `${global ? '' : 'CN '}building_data ${themeId}`, items: [], description: theme.desc ?? null, pieces, ...(global ? {} : { region: 'CN' }) });
    }
  }
  // A rerun repeats its original run's stages, missions and furniture: until the tables carry the
  // rerun's own, it shows the original's, marked as such. Never its store: a rerun has a store of
  // its own (tokens for the operator, other stock).
  for (const event of events.filter(e => isRerun(e.name))) {
    const title = key(eventTitle(event.name));
    const original = events.filter(e => e !== event && !isRerun(e.name) && key(eventTitle(e.name)) === title)
      .sort((a, b) => (globalStart(a) ?? cnStart(a) ?? 0) - (globalStart(b) ?? cnStart(b) ?? 0))[0];
    if (!original) continue;
    const entry = (result[event.name] ??= { activity: null, groups: [] });
    if (entry.activity) continue;
    entry.inheritsFrom = original.name;
    const have = new Set(entry.groups.map(group => group.kind));
    for (const group of result[original.name]?.groups ?? []) {
      if (RERUN_REPEATS.has(group.kind) && !have.has(group.kind)) entry.groups.push({ ...group, inherited: original.name });
    }
  }
  // A reward of none is a label the mission list carries beside the real one ("'Symphony of
  // Drums'" x0 next to the drum it names): not a reward.
  for (const { groups } of Object.values(result)) for (const group of groups) if (group.items) group.items = group.items.filter(item => item.count > 0);
  return result;
}

/* Both store helpers serve the page's fallback store, the event records' own `rewards` (the
   one-off wiki import), shown only for an event data/event-stores.json lists no store for. */

/** The event stores' item names that are furniture pieces in either client (the summary's Furniture
 *  row: the wiki import's store lists them as plain items). */
export function storeFurnitureNames(events, cn, en) {
  const pieces = new Set([...Object.values(cn.building?.customData?.furnitures ?? {}), ...Object.values(en.building?.customData?.furnitures ?? {})].map(piece => piece.name));
  const names = new Set();
  for (const event of events) {
    for (const store of Array.isArray(event.rewards) ? event.rewards : event.rewards ? [event.rewards] : []) {
      for (const item of store.items ?? []) if (pieces.has(item.name)) names.add(item.name);
    }
  }
  return [...names].sort();
}

/**
 * English names for the event stores' Chinese item names: the wiki import named some furniture
 * pieces and items as the CN client does ("“烛火之中”"). The CN and Global tables share their ids,
 * so a CN name the Global table also has becomes the Global name; one Global does not have yet
 * stays Chinese until it does (2026-10-03: CN-only content stays in CN until Global ships it).
 */
export function storeNameTranslations(events, cn, en) {
  const byCnName = new Map([
    ...Object.entries(cn.building?.customData?.furnitures ?? {}).map(([id, piece]) => [piece.name, en.building?.customData?.furnitures?.[id]?.name]),
    ...Object.entries(cn.items?.items ?? {}).map(([id, item]) => [item.name, en.items?.items?.[id]?.name]),
  ].filter(([, english]) => english));
  const names = {};
  for (const event of events) {
    for (const store of Array.isArray(event.rewards) ? event.rewards : event.rewards ? [event.rewards] : []) {
      for (const item of store.items ?? []) if (/\p{Script=Han}/u.test(item.name) && byCnName.has(item.name)) names[item.name] = byCnName.get(item.name);
    }
  }
  return names;
}

/**
 * What a reader would see as broken, failed here rather than shipped: an HTML entity left in a
 * name ("Profile Theme &apos;Vista&apos;"), a reward shown by its id ("avatar_activity_ED3"), or
 * one event showing two sections under one heading.
 */
/**
 * Global's in-game notice board (data/official-bulletins.json, sync-official-bulletins.mjs) for each
 * event's News: the board item of each headhunting banner the event opens with (linked_event), by
 * the banner's Global pool id, with its art's address (the picture is not kept) and the day the
 * board showed it. The item links to the announcement page of its title and day when there is one.
 * { event name: [board groups] }.
 */
export function boardGroups(events, banners, board) {
  const items = (board?.bulletins ?? []).filter(item => item.kind === 'banner' && item.poolId && item.image?.url);
  const pages = board?.notices ?? [];
  const names = new Set(events.map(event => event.name));
  const result = {};
  for (const banner of banners) {
    if (!banner.globalPoolId || !names.has(banner.linked_event)) continue;
    for (const item of items.filter(entry => entry.poolId === banner.globalPoolId)) {
      const page = pages.filter(notice => notice.url && notice.title === item.title && notice.date === item.displayDate);
      (result[banner.linked_event] ??= []).push({ kind: 'board', title: item.title, source: page.length === 1 ? page[0].url : '',
        published: item.displayDate, image: item.image.url, items: [] });
    }
  }
  return result;
}

/** The site's servers other than Global whose in-game boards an event's News tab shows. */
export const REGIONAL_BOARDS = ['jp', 'kr'];

/**
 * One regional server's in-game board for each event's News (JP or KR; Global's is boardGroups):
 * the items regional-board.mjs joins to the event -- its own event items, by the event's name in
 * that server's language, and the items of each headhunting banner it opens with (linked_event),
 * by the server's pool id -- from that server's regional schedule (data/regional-schedules.json,
 * which the regional-schedules stage writes before this one). Each group is tagged `server`, and
 * `name` is the site's own English name of what it is about (the event or the banner): the page
 * shows that and an English label, never the board's Japanese or Korean title, which is kept as a
 * derived fact like Global's. The picture is the board's own address (or its host's smaller copy
 * of it), left out over the size a page may load (pagePicture); no notice text is kept. { event name: [board groups] }.
 */
export function regionalBoardGroups(events, banners, schedule, board, server) {
  if (!REGIONAL_BOARDS.includes(server)) throw new Error(`regionalBoardGroups: ${server} is not a regional board`);
  const names = new Set(events.map(event => event.name));
  const pages = board?.notices ?? [];
  const byEvent = boardEventItems(schedule?.events, board);
  const result = {};
  const add = (eventName, item, name, subject) => {
    const groups = (result[eventName] ??= []);
    if (groups.some(group => group.id === item.id)) return;
    const page = pages.filter(notice => notice.url && notice.title === item.title && notice.date === item.displayDate);
    const picture = pagePicture(item);
    groups.push({ kind: 'board', server, id: item.id, subject, name, title: item.title, source: page.length === 1 ? page[0].url : '',
      published: item.displayDate, ...(picture ? { image: picture.url } : {}), items: [] });
  };
  for (const [eventName, items] of Object.entries(byEvent)) {
    if (!names.has(eventName)) continue;
    for (const item of items) add(eventName, item, eventName, 'event');
  }
  for (const banner of banners) {
    if (!names.has(banner.linked_event)) continue;
    for (const item of boardBannerItems(board, schedule?.banners?.[banner.name]?.poolId)) add(banner.linked_event, item, banner.name, 'banner');
  }
  return result;
}

export function assertEventRewards(rewards, text = JSON.stringify(rewards)) {
  // A reference the decoder would decode (official-news.mjs), not text that only looks like one.
  const entity = leftoverEntity(text);
  if (entity) throw new Error(`event-rewards: an HTML entity is left in the output: ${text.slice(Math.max(0, entity.index - 40), entity.index + entity[0].length + 20)}`);
  for (const [name, { groups }] of Object.entries(rewards)) {
    const seen = new Set();
    for (const group of groups) {
      const raw = group.items?.find(item => item.name === item.id && /_/.test(item.id));
      if (raw) throw new Error(`event-rewards: ${name} shows "${raw.id}", a reward no table names (${group.kind})`);
      // A regional board's items are told apart by their id: KR titles every event's "신규 이벤트 안내".
      const key = group.server ? `${group.kind}@${group.server}: ${group.id}` : `${group.kind}: ${group.title}`;
      if (seen.has(key)) throw new Error(`event-rewards: ${name} has two "${key}" sections`);
      seen.add(key);
    }
  }
}

async function main() {
  const root = process.cwd();
  // Each table read once, for the build and the two store helpers alike.
  const tablesIn = excel => {
    const read = file => JSON.parse(fs.readFileSync(path.join(excel, file), 'utf8'));
    return {
      activity: read('activity_table.json'), stages: read('stage_table.json'), items: read('item_table.json'),
      building: read('building_data.json'), characters: read('character_table.json'), skins: read('skin_table.json'),
      displayMeta: read('display_meta_table.json'), charms: read('charm_table.json'),
    };
  };
  const en = tablesIn(path.join(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata', 'en', 'gamedata', 'excel'));
  const cn = tablesIn(path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel'));
  const events = fs.readdirSync(path.join(root, 'data/events')).filter(file => /^events_\d+\.json$/.test(file))
    .flatMap(file => JSON.parse(fs.readFileSync(path.join(root, 'data/events', file), 'utf8')));
  const posts = readOfficialNews(root);
  const file = path.join(root, 'data/event-rewards.json');
  /* The CN groups read activity, reward and drop types by name. On a day upstream-cn fell back to
     the mirror that numbers them (cn-tables.mjs; null when run by hand, which reads the primary),
     every one would misread -- no sign-in, no first clear, every reward 'other' -- so none is
     built, and the entries built from CN stay as the last run wrote them. The names the store
     helpers read are text in either mirror. */
  const numbered = cnTables().serialization === 'numeric';
  const rewards = buildEventRewards(events, en, posts, numbered ? null : cn);
  if (numbered) {
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).events ?? {} : {};
    const byName = new Map(events.map(event => [event.name, event]));
    const now = Date.now() / 1000;
    // An entry today's build started from a Global announcement alone (its packs, its notices: no
    // activity of its own) takes its CN groups back in; this once kept only an event nothing else
    // had named today, and a CN-pending event with a post lost its missions and first clears for
    // the day. One the Global tables now build (an activity of its own) is Global's, and so is one
    // whose Global start has passed (awaitsGlobal, the CN build's own rule).
    const kept = Object.entries(previous).filter(([name, entry]) => entry.region === 'CN' && byName.has(name) && !rewards[name]?.activity && awaitsGlobal(byName.get(name), now));
    for (const [name, entry] of kept) {
      const today = rewards[name];
      if (!today) { rewards[name] = entry; continue; }
      const has = new Set(today.groups.map(group => `${group.kind}: ${group.title}`));
      rewards[name] = { ...today, activity: entry.activity, region: 'CN',
        groups: [...entry.groups.filter(group => group.region === 'CN' && !has.has(`${group.kind}: ${group.title}`)), ...today.groups] };
    }
    console.warn(`The CN tables number the game's enums today: ${kept.length} event(s) built from CN keep the last run's rewards.`);
  }
  // The in-game board's banner art, for the News tab (boardGroups): today's, in place of any an
  // entry kept from the last run carries.
  const bannerFile = path.join(root, 'data/headhunting_banners.json');
  const banners = fs.existsSync(bannerFile) ? JSON.parse(fs.readFileSync(bannerFile, 'utf8')) : [];
  // JP's and KR's (regionalBoardGroups) beside Global's, each tagged with its server.
  const boards = readOfficialBulletins(root).regions;
  const scheduleFile = path.join(root, 'data/regional-schedules.json');
  const schedules = fs.existsSync(scheduleFile) ? JSON.parse(fs.readFileSync(scheduleFile, 'utf8')).servers ?? {} : {};
  const boardByEvent = {};
  for (const [name, groups] of Object.entries(boardGroups(events, banners, boards.en))) (boardByEvent[name] ??= []).push(...groups);
  for (const server of REGIONAL_BOARDS) {
    for (const [name, groups] of Object.entries(regionalBoardGroups(events, banners, schedules[server], boards[server], server))) (boardByEvent[name] ??= []).push(...groups);
  }
  for (const entry of Object.values(rewards)) entry.groups = entry.groups.filter(group => group.kind !== 'board');
  for (const [name, groups] of Object.entries(boardByEvent)) {
    const entry = (rewards[name] ??= { activity: null, groups: [] });
    entry.groups = [...entry.groups, ...groups];
  }
  const storeNames = storeNameTranslations(events, cn, en);
  const storeFurniture = storeFurnitureNames(events, cn, en);
  const out = { storeFurniture, about: 'Rewards the game tables and official announcements list for each event beyond its store: the Global tables, the CN ones for an event Global has not had yet, and a rerun its original run\'s until its own appear (scripts/build/build-event-rewards.mjs). Generated every refresh: do not edit.', storeNames, events: rewards };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  assertEventRewards(rewards, text);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  console.log(`Event rewards: ${Object.keys(rewards).length} events, ${Object.values(rewards).reduce((n, e) => n + e.groups.length, 0)} groups.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
