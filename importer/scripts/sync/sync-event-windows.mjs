#!/usr/bin/env node
import { SERVER_TIME } from '../../lib/time/servers.mjs';
/**
 * Reconciles the hand-maintained calendars against the game's own client data:
 *
 *   data/events/events_<year>.json   global/cn dateRange  <- activity_table.json
 *                                    global shopEndAt     <- activity_table.json rewardEndTime
 *   data/headhunting_banners.json    global_date/cn_date  <- gacha_table.json
 *
 * The events files are written by hand from announcements, so future entries
 * carry ESTIMATED dates -- and an estimate that survives past the real
 * announcement makes the home page count down to a day the game does not
 * agree with, while the stages Terminal (fed from activity_table by
 * build-content-windows.mjs) shows the truth. This is how the site said
 * "starts in 3 days" and "open now, 10 days left" about the same event.
 * Once the client ships a window, the client is right; this copies it over.
 *
 * Only entries that are CURRENT are touched: anything whose window ended more
 * than ~45 days ago is history, already correct by definition of having
 * happened, and rewriting it would churn years of files for nothing.
 *
 * A banner that carries its Global pool id (globalPoolId) takes that pool's
 * window: the id is its identity, whatever either side calls it. CN windows stay
 * matched by name, which only the client's Chinese names meet: an id would reach
 * the CN-first banners, whose hours come from official CN notices that apply()
 * does not yet recognise as outranking the mirror. Everything else is matched by
 * folded name (case, punctuation, bracketed prefixes like "[Rerun]" dropped),
 * because the calendars and the client spell the same event differently: "[Rerun] When Elegies Are Ashes Rerun" is the client's
 * "When Elegies Are Ashes - Rerun". A name that matches several client
 * windows is resolved to the one nearest the entry's existing dates, or
 * skipped with a warning when there is nothing to be near.
 *
 * Dates and exact ISO timestamps are written; calendar days remain in the SERVER's own zone -- UTC-7 for
 * global, UTC+8 for CN -- which is the convention the files already use
 * Opening hours vary with maintenance, so never infer the hour from a date.
 *
 * Runs standalone: reads the refresh pipeline's .cache/upstream checkouts
 * when they exist and fetches the four tables from the public mirrors when
 * they do not, so `node scripts/sync/sync-event-windows.mjs` works from a bare
 * clone. Re-run after regenerating the dataset, or let refresh-stage-data.sh
 * do it as its calendar step.
 */
import fs from 'fs';
import path from 'path';
import { cnTableUrl, pinnedRef } from '../content/pin-upstream.mjs';
// Unix seconds -> "YYYY/MM/DD" as the server's own calendar sees it, at the offset each call
// names (-7 Global, 8 CN): the one helper the catalogue and the CN announcements date by, so a
// window this writes and the one catalogue-model.mjs writes are one string for one day.
import { serverDay } from '../lib/server-day.mjs';

const root = process.cwd();
const EN = `${process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en'}/gamedata/excel`;
const CN = `${process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource'}/gamedata/excel`;
// At the commits this run pinned (run-stage.mjs) -- for CN, the mirror and commit the run
// settled on for every CN table -- the ones the checkouts above hold, else the branches. A
// window this changes records the URL as its timingSource.
const RAW = {
  en: `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pinnedRef('ArknightsAssets/ArknightsGamedata')}/en/gamedata/excel`,
  cn: cnTableUrl('excel'),
};

async function readTable(dir, urlBase, file) {
  const at = path.join(root, dir, file);
  if (fs.existsSync(at)) return JSON.parse(fs.readFileSync(at, 'utf-8'));
  const res = await fetch(`${urlBase}/${file}`);
  if (!res.ok) throw new Error(`${urlBase}/${file}: ${res.status}`);
  return res.json();
}

/** One spelling for both sides: lowercase, no brackets, no punctuation. */
const fold = (name) => (name || '')
  .replace(/\[[^\]]*\]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9一-鿿]+/g, '');

const DASH = '–';
const now = Math.floor(Date.now() / 1000);
const RECENT = now - 45 * 86400;

/** Parses the files' "YYYY/MM/DD–YYYY/MM/DD" (or hyphen, or spaced) into its
 *  two normalized day strings plus unix seconds of the end day. Null when the
 *  string is anything else -- including the hand-annotated history entries
 *  ("2022/11/03–2022/11/24 ; 186 days after CN"), which a sync must never
 *  rewrite: the annotation is the record. */
function parseRange(dateRange) {
  const m = (dateRange || '').split(/[–-]/).map((s) => s.trim());
  if (m.length !== 2) return null;
  const ymd = (v) => v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  const a = ymd(m[0]);
  const b = ymd(m[1]);
  if (!a || !b) return null;
  const day = (x) => `${x[1]}/${String(+x[2]).padStart(2, '0')}/${String(+x[3]).padStart(2, '0')}`;
  return { startDay: day(a), endDay: day(b), endTs: Date.UTC(+b[1], +b[2] - 1, +b[3], 23) / 1000 };
}

/** name -> [{start, end, rewardEnd?}] with ambiguity kept, resolved per entry. */
function windowsByName(rows, getName, getStart, getEnd, getRewardEnd = () => null) {
  const map = new Map();
  for (const r of rows) {
    const key = fold(getName(r));
    const start = getStart(r);
    const end = getEnd(r);
    if (!key || !start || !end) continue;
    // The client keeps sign-in side pools and years-long permanent pools in
    // the same lists; a "window" longer than 60 days is not an event run.
    if (end - start > 60 * 86400) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ start, end, rewardEnd: getRewardEnd(r) || null });
  }
  return map;
}

/** Client tables sometimes use the final inclusive second (03:59:59), sometimes the exclusive
 *  minute boundary: one exclusive instant, in unix seconds. */
const exclusiveEnd = (ts) => ts + (ts % 60 === 59 ? 1 : 0);

/** How far a client window may sit from the entry's own dates and still be
 *  the same run. A rerun whose pool has not shipped yet must not inherit the
 *  ORIGINAL run's window through their shared name -- "Sharpened by Flame
 *  Rerun" (est. 2026) folds to the same key as the 2023 original, and without
 *  this fence the sync copied 2023 onto it. */
const NEARBY = 120 * 86400;

function pick(cands, existingEndTs) {
  if (!cands) return null;
  if (existingEndTs == null) {
    // Filling a blank: only an unambiguous, current window will do.
    return cands.length === 1 && cands[0].end >= RECENT ? cands[0] : null;
  }
  const best = cands.slice().sort((a, b) => Math.abs(a.end - existingEndTs) - Math.abs(b.end - existingEndTs))[0];
  return Math.abs(best.end - existingEndTs) <= NEARBY ? best : null;
}

/** Curated official notices outrank third-party mirrors of the client tables. */
function isOfficialAnnouncement(source) {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:') return false;
    return (['arknights.global', 'www.arknights.global'].includes(url.hostname) && /^\/news\/\d+\/?$/.test(url.pathname))
      || (['x.com', 'twitter.com'].includes(url.hostname) && /^\/ArknightsEN\/status\/\d+\/?$/i.test(url.pathname));
  } catch { return false; }
}

/** Applies one client window to one { dateRange, note } block. Returns a log line or null. */
function apply(block, cands, offset, label, source) {
  if (!block) return null;
  const existing = block.dateRange ? parseRange(block.dateRange) : null;
  // A dateRange that parses as anything but a plain range is hand-curated
  // (annotations, footnotes) -- not this script's to touch.
  if (block.dateRange && !existing) return null;
  // History stays history: only entries still running, upcoming, or just closed.
  if (existing && existing.endTs < RECENT) return null;
  const win = pick(cands, existing?.endTs ?? null);
  if (!win) return null;
  const startDay = serverDay(win.start, offset);
  const endDay = serverDay(win.end, offset);
  const startAt = new Date(win.start * 1000).toISOString();
  // Client tables sometimes use the final inclusive second (03:59:59),
  // sometimes the exclusive minute boundary. Store one exclusive end.
  const endAt = new Date(exclusiveEnd(win.end) * 1000).toISOString();
  const sameDays = existing && existing.startDay === startDay && existing.endDay === endDay;
  if (isOfficialAnnouncement(block.timingSource) && block.startAt && block.endAt) {
    if (!sameDays || block.startAt !== startAt || block.endAt !== endAt) {
      console.warn(`${label}: mirrored client times differ from ${block.timingSource}; keeping the official announcement for review.`);
    }
    return null;
  }
  if (sameDays && block.startAt === startAt && block.endAt === endAt) return null;
  const next = sameDays ? block.dateRange : `${startDay}${DASH}${endDay}`;
  const was = block.dateRange ?? '(none)';
  Object.assign(block, { dateRange: next, startAt, endAt, timingSource: source });
  // The client shipping a window is the confirmation the estimate was waiting for.
  if (block.note && /estimat/i.test(block.note)) block.note = null;
  return `  ${label}: ${was} -> ${next}`;
}

/**
 * The event store's close, when it outlasts the stages: the client's rewardEndTime. An
 * event's shop stays open after its stages close -- [Side Story] People, A People's stages
 * closed 2026-09-30 11:00Z and its store 2026-10-07 11:00Z -- and the home page took the
 * event down with the stages, while readers still had a week of shopping (and its welfare
 * operator) left. Every current event gets it, the official-notice ones apply() leaves alone
 * included: a notice rarely states the store's close, and the client always does. Matched to
 * the run by its own close, so a rerun can never take its original's store. Returns a log
 * line or null.
 */
function applyShop(block, cands, label) {
  if (!block?.endAt || !cands) return null;
  const endTs = Date.parse(block.endAt) / 1000;
  // History stays history, as in apply().
  if (!Number.isFinite(endTs) || endTs < RECENT) return null;
  const run = cands.find((c) => Math.abs(exclusiveEnd(c.end) - endTs) <= 2 * 3600);
  if (!run?.rewardEnd) return null;
  const shopEnd = exclusiveEnd(run.rewardEnd);
  const shopEndAt = shopEnd > endTs ? new Date(shopEnd * 1000).toISOString() : null;
  if ((block.shopEndAt ?? null) === shopEndAt) return null;
  if (shopEndAt) block.shopEndAt = shopEndAt;
  else delete block.shopEndAt;
  return `  ${label}: store closes ${shopEndAt ?? 'with the stages'}`;
}

const [actEn, actCn, gachaEn, gachaCn] = await Promise.all([
  readTable(EN, RAW.en, 'activity_table.json'),
  readTable(CN, RAW.cn, 'activity_table.json'),
  readTable(EN, RAW.en, 'gacha_table.json'),
  readTable(CN, RAW.cn, 'gacha_table.json'),
]);

const acts = (t) => Object.values(t.basicInfo || {});
const enActs = windowsByName(acts(actEn), (a) => a.name, (a) => a.startTime, (a) => a.endTime, (a) => a.rewardEndTime);
const cnActs = windowsByName(acts(actCn), (a) => a.name, (a) => a.startTime, (a) => a.endTime);
const enPools = windowsByName(gachaEn.gachaPoolClient || [], (p) => p.gachaPoolName, (p) => p.openTime, (p) => p.endTime);
const cnPools = windowsByName(gachaCn.gachaPoolClient || [], (p) => p.gachaPoolName, (p) => p.openTime, (p) => p.endTime);
/** A pool's window by its id, as the one candidate; null for an id the table lacks. */
const poolById = (rows) => {
  const byId = new Map(rows.filter((p) => p.gachaPoolId && p.openTime && p.endTime).map((p) => [p.gachaPoolId, [{ start: p.openTime, end: p.endTime }]]));
  return (id) => (id && byId.get(id)) || null;
};
const enPoolById = poolById(gachaEn.gachaPoolClient || []);

/* --- events_<year>.json ------------------------------------------------------ */

let changed = 0;
for (const file of fs.readdirSync(path.join(root, 'data', 'events')).filter((f) => /^events_\d{4}\.json$/.test(f))) {
  const at = path.join(root, 'data', 'events', file);
  const rows = JSON.parse(fs.readFileSync(at, 'utf-8'));
  const log = [];
  for (const e of rows) {
    const key = fold(e.name);
    const line = apply(e.global, enActs.get(key), SERVER_TIME.en.offset, `${e.name} [global]`, `${RAW.en}/activity_table.json`);
    const cnLine = apply(e.cn, cnActs.get(key), SERVER_TIME.cn.offset, `${e.name} [cn]`, `${RAW.cn}/activity_table.json`);
    // After apply(), so an event whose window the client just shipped gets its store too.
    const shopLine = applyShop(e.global, enActs.get(key), `${e.name} [global]`);
    if (line) log.push(line);
    if (cnLine) log.push(cnLine);
    if (shopLine) log.push(shopLine);
  }
  if (log.length) {
    fs.writeFileSync(at, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`${file}:`);
    for (const l of log) console.log(l);
    changed += log.length;
  }
}

/* --- headhunting_banners.json ------------------------------------------------ */

const bannersAt = path.join(root, 'data', 'headhunting_banners.json');
const banners = JSON.parse(fs.readFileSync(bannersAt, 'utf-8'));
const bannerLog = [];
for (const b of banners) {
  // "Returned From A Pyre Rerun" is the pool the client calls "Returned From A
  // Pyre" -- a rerun banner reuses its original's pool name, so match both.
  const keys = [fold(b.name), fold(b.name).replace(/rerun$/, '')];
  const enCands = enPoolById(b.globalPoolId) ?? keys.map((k) => enPools.get(k)).find(Boolean);
  const cnCands = keys.map((k) => cnPools.get(k)).find(Boolean);
  // The banner file keeps bare strings rather than {dateRange, note} blocks;
  // wrap and unwrap so apply() serves both shapes.
  const g = { ...b.global_window, dateRange: b.global_date ?? null, note: null };
  const c = { ...b.cn_window, dateRange: b.cn_date ?? null, note: null };
  // The named Global announcement can open after the client's maintenance window.
  // The banner reconciler runs immediately before this stage and resolves it.
  const gl = b.globalScheduleStatus === 'announced' ? null : apply(g, enCands, SERVER_TIME.en.offset, `${b.name} [global]`, `${RAW.en}/gacha_table.json`);
  const cl = apply(c, cnCands, SERVER_TIME.cn.offset, `${b.name} [cn]`, `${RAW.cn}/gacha_table.json`);
  if (gl) { b.global_date = g.dateRange; b.global_window = { startAt: g.startAt, endAt: g.endAt, timingSource: g.timingSource }; bannerLog.push(gl); }
  if (cl) { b.cn_date = c.dateRange; b.cn_window = { startAt: c.startAt, endAt: c.endAt, timingSource: c.timingSource }; bannerLog.push(cl); }
}
if (bannerLog.length) {
  fs.writeFileSync(bannersAt, `${JSON.stringify(banners, null, 2)}\n`);
  console.log('headhunting_banners.json:');
  for (const l of bannerLog) console.log(l);
  changed += bannerLog.length;
}

console.log(changed ? `${changed} window(s) reconciled against the client data` : 'Every current window already matches the client data');
