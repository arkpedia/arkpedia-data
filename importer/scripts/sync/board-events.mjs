/**
 * Global's in-game notice board (data/official-bulletins.json, sync-official-bulletins.mjs) for
 * the event records: the day an event was announced, and its official key art.
 *
 * A board's event item carries no activity id, only a title ("Critical Phase Transition Open"),
 * sometimes a heading, the day it was shown and its image. So an item is matched to an event by
 * name and day, and anything that is not one event for certain is left unmatched:
 *   - the event's name (without its [Type] prefix, and without a trailing "Rerun" for a rerun's
 *     item) is in the item's title or heading, folded, and at least MIN_NAME letters long;
 *   - the item's day is plausible for it: within LEAD_DAYS before a confirmed Global window up to
 *     its close, or, for an event Global has no confirmed dates for, after its CN opening;
 *   - exactly one event qualifies.
 * An event's items then give (boardEvents):
 *   - `announced`, the first day any of them was on the board: the earlier of the day the board
 *     shows and the day the poller first saw it (the poller started on 2026-10-18, after the
 *     board had shown some items for days);
 *   - `image`, the key art, when its items show one picture (by hash) and only one.
 *
 * applyBoardEvents writes what is new into the records it is handed:
 *   - an event with no Global dates yet gets the note ANNOUNCED instead of "Global release
 *     unannounced". Its fields are the record's own (no new field: the published props are the
 *     shape pages read, see test-previous-release-props.ts), and an estimated window's note,
 *     written by hand, is never touched;
 *   - an event poster in the image repository's event-poster/ folder (or none yet) is planned
 *     from the board's image ({ path, boardImage: { url, sha1 } }), which the publisher
 *     (publish-catalogue-assets.py) takes ahead of the wiki's EN upload of the same art, and in
 *     place of the CN art the file may hold until then. A poster at a pinned address is the
 *     record's own choice and left alone.
 */
import { fold, safeName } from './catalogue-model.mjs';

export const MIN_NAME = 6;
export const LEAD_DAYS = 21;
const DAY = 86_400_000;
const ANNOUNCED = /^Announced on Global's in-game notice board on \d{4}-\d{2}-\d{2}; dates to follow\.$/;
export const announcedNote = day => `Announced on Global's in-game notice board on ${day}; dates to follow.`;

const unprefixed = name => String(name ?? '').replace(/^\s*\[[^\]]*\]\s*/, '');
const days = range => (String(range ?? '').match(/\d{4}\/\d{2}\/\d{2}/g) ?? []).map(day => Date.parse(`${day.replaceAll('/', '-')}T00:00:00Z`));
const estimated = event => /estimat|predict|not officially confirmed/i.test(event.global?.note ?? '');
const shownOn = item => [item.displayDate, item.firstSeen].filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day ?? '')).sort()[0] ?? null;

/** The folded names an item may name an event by. */
function names(event) {
  const base = unprefixed(event.name);
  return [...new Set([base, base.replace(/\s+Rerun$/i, '')].map(fold))].filter(name => name.length >= MIN_NAME);
}

function plausible(event, at) {
  if (event.modeId) return false;
  const [start, end] = days(event.global?.dateRange);
  if (event.global?.dateRange && !estimated(event)) return Number.isFinite(start) && at >= start - LEAD_DAYS * DAY && at <= (Number.isFinite(end) ? end : start) + DAY;
  const [cnStart] = days(event.cn?.dateRange);
  return Number.isFinite(cnStart) && at > cnStart;
}

/** { event name: { announced, items: [ids], image? } } for the board items matched to one event each. */
export function boardEvents(events, board) {
  const matched = new Map();
  for (const item of board?.bulletins ?? []) {
    if (item.kind !== 'event') continue;
    const day = shownOn(item);
    if (!day) continue;
    const text = fold(`${item.title ?? ''} ${item.heading ?? ''}`);
    const at = Date.parse(`${day}T00:00:00Z`);
    const candidates = events.filter(event => names(event).some(name => text.includes(name)) && plausible(event, at));
    if (candidates.length !== 1) continue;
    const name = candidates[0].name;
    matched.set(name, [...(matched.get(name) ?? []), { item, day }]);
  }
  return Object.fromEntries([...matched].map(([name, rows]) => {
    const pictures = new Map(rows.filter(({ item }) => item.image?.url && /^[a-f0-9]{40}$/.test(item.image.sha1 ?? '')).map(({ item }) => [item.image.sha1, item.image.url]));
    const [image] = pictures.size === 1 ? [...pictures].map(([sha1, url]) => ({ url, sha1 })) : [];
    return [name, { announced: rows.map(row => row.day).sort()[0], items: rows.map(row => row.item.id).sort(), ...(image ? { image } : {}) }];
  }));
}

/** Notes the announced events and plans their key art; returns the media entries and what changed. */
export function applyBoardEvents(events, board) {
  const found = boardEvents(events, board);
  const media = [], announced = [];
  for (const event of events) {
    const match = found[event.name];
    if (!match) continue;
    if (event.global && !event.global.dateRange && (event.global.note === 'Global release unannounced' || ANNOUNCED.test(event.global.note ?? ''))) {
      const note = announcedNote(match.announced);
      if (event.global.note !== note) announced.push(event.name);
      event.global = { ...event.global, note };
    }
    if (!match.image) continue;
    if (event.poster && !String(event.poster).startsWith('/event-poster/')) continue;
    event.poster ??= `/event-poster/${safeName(unprefixed(event.name))}.webp`;
    media.push({ path: event.poster.slice(1), boardImage: match.image });
  }
  return { media, announced };
}

/**
 * Banner key art from Global's board. A banner item (kind 'banner') names the pool it opens
 * (poolId), which is a record's globalPoolId, and shows the banner's key art: the picture the
 * wiki later uploads as "EN <banner> banner.png". Planned ({ path, boardImage }) only for a record
 * whose picture is missing. An Orienteering's or a Joint Operation's CN art is retired in the image
 * repository until Global carries it, and nothing brought Global's back: Orienteering #7 ran on
 * Global from 2026-10-28 with no picture while the board showed its art. The publisher builds the
 * file from the board and lifts its retirement (publish-catalogue-assets.py). A picture already
 * published is left alone; a pool two records claim, or none, plans nothing.
 */
export function boardBannerMedia(banners, board, published) {
  const media = [];
  for (const item of board?.bulletins ?? []) {
    if (item.kind !== 'banner' || !item.poolId || !item.image?.url || !/^[a-f0-9]{40}$/.test(item.image.sha1 ?? '')) continue;
    const records = banners.filter(banner => banner.globalPoolId === item.poolId);
    if (records.length !== 1) continue;
    const art = records[0].banner_image;
    if (!String(art ?? '').startsWith('/headhunting-banner-images/') || published.has(art.slice(1))) continue;
    media.push({ path: art.slice(1), boardImage: { url: item.image.url, sha1: item.image.sha1, ...(Number.isInteger(item.image.bytes) ? { bytes: item.image.bytes } : {}) } });
  }
  return media;
}
