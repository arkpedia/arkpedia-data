/**
 * JP's and KR's in-game notice boards (data/official-bulletins.json, sync-official-bulletins.mjs)
 * joined to the site's events and banners, for the site in JP or KR mode: the one join both the
 * regional schedule (sync-regional-schedules.mjs, each window's `art`) and the event News tab
 * (build-event-rewards.mjs regionalBoardGroups) read, so the two cannot disagree on which item
 * is whose.
 *
 * - A banner item is its gacha pool's, by the pool id its recruit link carries (boardBannerItems):
 *   the regional window's poolId, the Global pool id with the server's code (regionalPoolId), the
 *   join #555 confirms opening days with.
 * - An event item carries no activity id and names the event in the server's own language, so it
 *   is the event's whose regional name (the window's localName, from that client's activity_table)
 *   is in the item's title or heading, folded, at least MIN_LOCAL_NAME letters long, on a day from
 *   LEAD_DAYS before the regional window opens up to its close; and only when exactly one event
 *   qualifies (boardEventItems).
 *
 * Art (boardArt) is only ever an address and a hash, never the picture: the board's own host, as
 * the poller recorded it. Kept out:
 *   - a template: a picture the board shows under more than one title (KR's generic "신규 이벤트
 *     안내" picture, one 2024 file on every event's item), or one filed months before the item
 *     (TEMPLATE_DAYS);
 *   - a picture over MAX_ART_BYTES, which a page would otherwise hotlink as its hero (KR's
 *     2026-10-09 Standard banner was 18.6 MB), unless its host serves the same picture smaller
 *     (`image.small`, which the poller asks the host for: KR's COS host re-encodes that banner as
 *     a 0.5 MB WebP of the same 1650x900). The template and filing checks stay on the original;
 *     the address and hash handed out are the smaller one's;
 *   - anything but one picture: two different ones for one subject is no answer.
 *
 * KR's board gives no event a picture of its own: every "신규 이벤트 안내" shows the one template,
 * and the notice behind it is the whole notice drawn as one tall strip. KR's own art for an event
 * is the official site's headline (www.arknights.kr, `headlines` in the board's region: the key
 * visual the site shows for its current event, named in `versionName`), which joins as one more
 * event item for the art only (headlineItems): never in the News tab, which is the board's.
 */

export const MIN_LOCAL_NAME = 3;
export const LEAD_DAYS = 21;
/** The largest picture a page may load from the board's host. Global's and JP's are 0.4-2.6 MB. */
export const MAX_ART_BYTES = 5_000_000;
/** A picture filed this many days before the item that shows it is a reused template. */
export const TEMPLATE_DAYS = 120;

const DAY = 86_400_000;
const SHA1 = /^[a-f0-9]{40}$/;
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const dayOf = text => (/^\d{4}-\d{2}-\d{2}$/.test(text ?? '') ? Date.parse(`${text}T00:00:00Z`) : NaN);
/** The day the board first showed an item: the earlier of the day it shows and the day the poller saw it. */
export const shownOn = item => [item.displayDate, item.firstSeen].filter(day => Number.isFinite(dayOf(day))).sort()[0] ?? null;

/** A Global gacha pool id as the server's client numbers it: LIMITED_EN_42_0_1 -> LIMITED_JP_42_0_1. */
export const regionalPoolId = (globalPoolId, server) => (globalPoolId ? String(globalPoolId).replace(/_EN_/, `_${String(server).toUpperCase()}_`) : null);

/** The board's banner items for one gacha pool. */
export function boardBannerItems(board, poolId) {
  if (!poolId) return [];
  return (board?.bulletins ?? []).filter(item => item.kind === 'banner' && item.poolId === poolId);
}

function plausible(window, at) {
  if (window.modeId) return false;
  const start = Date.parse(window.startAt), end = Date.parse(window.endAt);
  return Number.isFinite(start) && Number.isFinite(end) && at >= start - LEAD_DAYS * DAY && at <= end;
}

/** { event name: [board items] } for the event items that name exactly one event's regional window. */
export function boardEventItems(eventWindows, board) {
  const windows = Object.entries(eventWindows ?? {}).filter(([, window]) => fold(window.localName).length >= MIN_LOCAL_NAME);
  const result = {};
  for (const item of board?.bulletins ?? []) {
    if (item.kind !== 'event') continue;
    const at = dayOf(shownOn(item));
    if (!Number.isFinite(at)) continue;
    const text = fold(`${item.title ?? ''} ${item.heading ?? ''}`);
    const candidates = windows.filter(([, window]) => text.includes(fold(window.localName)) && plausible(window, at));
    if (candidates.length !== 1) continue;
    (result[candidates[0][0]] ??= []).push(item);
  }
  return result;
}

/** The pictures (by hash) that are a board's templates rather than one subject's art. */
export function templatePictures(board) {
  const titles = new Map();
  for (const item of board?.bulletins ?? []) {
    if (!SHA1.test(item.image?.sha1 ?? '')) continue;
    const set = titles.get(item.image.sha1) ?? new Set();
    set.add(fold(`${item.title ?? ''} ${item.heading ?? ''}`));
    titles.set(item.image.sha1, set);
  }
  return new Set([...titles].filter(([, set]) => set.size > 1).map(([sha1]) => sha1));
}

const https = picture => /^https:\/\//.test(String(picture?.url ?? ''));

/**
 * The picture a page may load for an item, { url, sha1 }, or null: the item's own, on https and
 * not over MAX_ART_BYTES; else the smaller copy its host serves of it (image.small), when that one
 * is on https, hashed, and within the size.
 */
export function pagePicture(item) {
  const image = item?.image;
  if (!https(image)) return null;
  if (!(Number(image.bytes) > MAX_ART_BYTES)) return { url: image.url, sha1: image.sha1 };
  const small = image.small;
  if (!https(small) || !SHA1.test(small.sha1 ?? '') || !(Number(small.bytes) > 0) || Number(small.bytes) > MAX_ART_BYTES) return null;
  return { url: small.url, sha1: small.sha1 };
}

/**
 * The official site's headlines (a region's `headlines`, sync-official-bulletins.mjs) as event
 * items: titled by the site's own name for its headline, on the day the poller first saw it.
 */
export function headlineItems(board) {
  return (board?.headlines ?? []).filter(headline => headline?.image?.url).map(headline => ({
    id: `site:${headline.image.url}`, kind: 'event', title: headline.title ?? '', displayDate: headline.firstSeen, firstSeen: headline.firstSeen, image: headline.image,
  }));
}

function filedLongBefore(item) {
  // The board files a picture under /images/YYYYMMDD/, the official site's CMS under /YYYY/MM/DD/.
  const filed = String(item.image?.url ?? '').match(/\/images\/(\d{4})(\d{2})(\d{2})\/|\/upload\/content\/(\d{4})\/(\d{2})\/(\d{2})\//);
  const at = dayOf(shownOn(item));
  if (!filed || !Number.isFinite(at)) return false;
  const [year, month, day] = filed[1] ? filed.slice(1, 4) : filed.slice(4, 7);
  return at - Date.parse(`${year}-${month}-${day}T00:00:00Z`) > TEMPLATE_DAYS * DAY;
}

/** One subject's key art from its board items, { url, sha1 }, or null (see the rules above). */
export function boardArt(items, templates) {
  // Keyed by the original's hash, so an original and its smaller copy are one picture.
  const pictures = new Map(items
    .filter(item => SHA1.test(item.image?.sha1 ?? '') && !templates.has(item.image.sha1) && !filedLongBefore(item))
    .flatMap(item => {
      const picture = pagePicture(item);
      return picture && SHA1.test(picture.sha1 ?? '') ? [[item.image.sha1, picture]] : [];
    }));
  if (pictures.size !== 1) return null;
  const [[, { url, sha1 }]] = [...pictures];
  return { url, sha1 };
}

/**
 * The regional windows with their board art: `art` on each event and banner window the board has
 * one picture for, and none on the rest (a window from an earlier run loses an art the board no
 * longer gives). { events, banners }, new objects; the windows handed in are not changed.
 */
export function withBoardArt({ events, banners }, board) {
  // The official site's headlines join the board's items for the art (and its template check).
  const withHeadlines = { bulletins: [...(board?.bulletins ?? []), ...headlineItems(board)] };
  const templates = templatePictures(withHeadlines);
  const byEvent = boardEventItems(events, withHeadlines);
  const attach = (window, items) => {
    const { art: _old, ...rest } = window;
    const art = boardArt(items, templates);
    return art ? { ...rest, art } : rest;
  };
  return {
    events: Object.fromEntries(Object.entries(events ?? {}).map(([name, window]) => [name, attach(window, byEvent[name] ?? [])])),
    banners: Object.fromEntries(Object.entries(banners ?? {}).map(([name, window]) => [name, attach(window, boardBannerItems(board, window.poolId))])),
  };
}
