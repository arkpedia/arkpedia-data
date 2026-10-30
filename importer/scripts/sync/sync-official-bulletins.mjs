/**
 * The in-game notice boards of every region (en, jp, kr, cn), as derived facts in
 * data/official-bulletins.json: what each board announced, when, and -- for a headhunting
 * banner -- its pool id and its official art. The website news (sync-official-news.mjs,
 * sync-cn-news.mjs, sync-regional-schedules.mjs) is text; the board is what the game itself
 * shows, keyed the way the game's tables are.
 *
 * Two lists per region, both public JSON the client reads (scripts/lib/official-endpoints.mjs
 * says what these readers send and keep):
 *   - the webview board, `<prean>/api/game/bulletinList?target=Android`, and each new item's
 *     `/api/game/bulletin/<cid>`. A banner's item links into the game with
 *     `uniwebview://move?target=recruit&param1=<pool id>`, the gacha_table's id (the pool ids
 *     the banners in data/headhunting_banners.json carry). Its `bannerImageUrl` is the
 *     official art: hashed once (sha1 and size) and not kept.
 *   - the announcement list at network_config's `an` (en, jp, kr; CN's is dead, see
 *     DEAD_ANNOUNCEMENT_LISTS): id, group (ACTIVITY, SYSTEM), title and a month and day. A maintenance
 *     notice of a MAINTENANCE_REGIONS region also gets `maintenance`, the window its page
 *     announces ({ startAt, endAt }, or null for none), which the home page and its ticker show.
 *
 *   - the official site's headline (SITE_HEADLINES, KR only): the key visual the site shows for its
 *     current event and its name for it (`versionName`), kept as `headlines`, { title, image,
 *     firstSeen }, one per picture. The site shows only its current one, so every one ever seen
 *     stays, like the board's items. regional-board.mjs joins them to events for KR's own art.
 *
 * A picture over the size a page may load (MAX_ART_BYTES) is asked of its host once more, smaller
 * (SMALLER_COPIES: Tencent COS's image processing, which KR's host answers and JP's and Global's
 * ignore): the first answer that is a picture, within the size and smaller than the original, is
 * kept beside it as `image.small` ({ url, sha1, bytes }), or `small: null` for a host that has none.
 *
 * Kept per item: id, kind, title, date, link, pool id, image address and hash, and the day
 * this reader first saw it. Never the notice's text or picture. The boards hold about a dozen
 * items each, so every item ever seen stays in the file: the history cannot be read back later.
 *
 * Ids are strings with leading zeros and in no order ("0593" after "8360"), so an item is new
 * when its id is not in the file, never by comparing numbers. A day that changes nothing writes
 * nothing. GET only: one list per board, one detail per new item, one image per new banner.
 *
 * A board that cannot be read keeps its region's facts as they were (kept-previous); an item
 * whose detail cannot be read is left out and asked for again the next run (omitted-new); a
 * board whose newest item is older than STALE_DAYS has probably moved while the address the
 * client carries did not, and is reported (kept-previous) with what it still lists.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { serverInstant } from '../../lib/time/servers.mjs';
import { DEAD_ANNOUNCEMENT_LISTS, getBytes, getJson, REGIONS, regionNetwork, SITE_HEADLINES } from '../lib/official-endpoints.mjs';
import { MAX_ART_BYTES } from './regional-board.mjs';

export const OFFICIAL_BULLETINS = 'data/official-bulletins.json';
/** The newest item of a live board is days old; one older than this is a board that moved. */
export const STALE_DAYS = 45;
/** The regions whose notices are read for a maintenance window: their prose is parsed
 *  (parseMaintenance), so a region joins once its wording has been looked at. JP and KR joined on
 *  2026-10-20, from their notices of Aug-Oct 2026 (scripts/tests/test-official-bulletins.ts). */
export const MAINTENANCE_REGIONS = new Set(['en', 'jp', 'kr']);

/** Whether a notice may announce a maintenance: Global files them under SYSTEM. JP and KR list
 *  every notice under ACTIVITY, so there the title says it (メンテナンス, 점검). */
export function maybeMaintenance(region, notice) {
  if (!notice.url) return false;
  if (notice.group === 'SYSTEM') return true;
  return region !== 'en' && /メンテナンス|점검/.test(notice.title ?? '');
}

const day = now => new Date(now).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** One line: the boards break titles with a literal "\n" (and sometimes a real one). */
export const cleanTitle = title => String(title ?? '').replace(/\\n|\n/g, ' ').replace(/\s+/g, ' ').trim();

/** `uniwebview://move?target=recruit&param1=LIMITED_EN_42_0_1` -> { target, param }, or null. */
export function parseJumpLink(link) {
  const text = String(link ?? '');
  const query = text.indexOf('?');
  if (query < 0) return null;
  const params = new URLSearchParams(text.slice(query + 1));
  const target = params.get('target');
  if (!target) return null;
  const param = params.get('param1');
  return param ? { target, param } : { target };
}

/** A banner when it links to the recruit screen with a pool id; otherwise the board's category:
 *  1 event or campaign, 2 the developers' news, anything else (4, merchandise and media) other. */
export function bulletinKind(category, link) {
  if (link?.target === 'recruit' && link.param) return 'banner';
  if (Number(category) === 1) return 'event';
  if (Number(category) === 2) return 'news';
  return 'other';
}

/** The announcement list dates a notice by month and day only. A month and day ahead of the run
 *  by more than a month is last year's (a December notice still listed in January). */
export function noticeDate(month, day_, now) {
  const today = new Date(now);
  const m = Number(month), d = Number(day_);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  let year = today.getUTCFullYear();
  if (Date.UTC(year, m - 1, d) - today.getTime() > 31 * 86_400_000) year -= 1;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A notice page's address without the cache-busting `t` the list appends to it every time. */
export function stableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('t');
    return parsed.href;
  } catch {
    return String(url ?? '');
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STAMP = String.raw`(${MONTHS.join('|')})\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):([0-5]\d)`;
const WINDOW = new RegExp(String.raw`${STAMP}\s*[-–~]\s*(?:(${MONTHS.join('|')})\s+(\d{1,2}),\s*(\d{4}),?\s*)?(\d{1,2}):([0-5]\d)\s*\(UTC\s*([+\-−])\s*(\d{1,2})(?::?([0-5]\d))?\)`, 'g');

const JP_WINDOW = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[（(][^）)]*[）)]\s*(\d{1,2}):([0-5]\d)\s*[~〜～\-–]\s*(?:(\d{4})年(\d{1,2})月(\d{1,2})日\s*[（(][^）)]*[）)]\s*)?(\d{1,2}):([0-5]\d)/g;
const KR_DAY = String.raw`(?:(\d{1,2})월\s*(\d{1,2})일|(\d{1,2})\/(\d{1,2}))(?:\s*\([^)]*\))?,?\s*`;
const KR_WINDOW = new RegExp(String.raw`${KR_DAY}(\d{1,2}):([0-5]\d)\s*~\s*(?:${KR_DAY})?(\d{1,2}):([0-5]\d)`, 'g');

/** One window from its wall-clock parts, or null for one that ends before it starts or lasts
 *  over two days. A closing time with no day of its own is that day, or the next past midnight. */
function windowFrom(start, end, endHasDay) {
  if (!endHasDay && end <= start) end += 86_400_000;
  if (end <= start || end - start > 2 * 86_400_000) return null;
  return `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;
}

/**
 * The maintenance window a notice page announces, { startAt, endAt } as ISO instants, or null. A
 * page naming two different windows, or none, gives null. Only this derived window is kept.
 *  - Global (en) puts it as "July 30, 2026, 08:00-08:10 (UTC-7)" (or with the closing day spelled
 *    out), once in the first sentence and again under "Maintenance Date and Time".
 *  - JP as "2026年10月14日（水）10:00 ~ 16:00", in Japan server time (lib/time/servers.mjs).
 *  - KR as "10월 14일 (수) 10:00 ~ 16:00" or "8/20 (목) 16:00 ~ 17:00", in Korea time and with no
 *    year: the year is the notice's own (`date`, from the list), or the next one for a window
 *    that would otherwise fall months before the notice.
 * A KR "resource update" says it happens without maintenance (점검 없이) and gives null.
 */
export function parseMaintenance(html, region, date) {
  const text = String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  const windows = new Set();
  if (region === 'jp') {
    if (!/メンテナンス/.test(text)) return null;
    for (const m of text.matchAll(JP_WINDOW)) {
      const at = (year, month, day, hour, minute) => serverInstant(Number(year), Number(month), Number(day), Number(hour), 'jp') + Number(minute) * 60_000;
      const window = windowFrom(at(m[1], m[2], m[3], m[4], m[5]), at(m[6] ?? m[1], m[7] ?? m[2], m[8] ?? m[3], m[9], m[10]), Boolean(m[6]));
      if (window) windows.add(window);
    }
  } else if (region === 'kr') {
    if (!/점검/.test(text) || /점검\s*없이/.test(text) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
    const noticeAt = Date.parse(`${date}T00:00:00Z`);
    for (const m of text.matchAll(KR_WINDOW)) {
      const month = Number(m[1] ?? m[3]), day = Number(m[2] ?? m[4]);
      let year = Number(date.slice(0, 4));
      if (Date.UTC(year, month - 1, day) < noticeAt - 60 * 86_400_000) year += 1;
      const endMonth = m[7] ?? m[9], endDay = m[8] ?? m[10];
      const at = (mo, d, hour, minute) => serverInstant(year, Number(mo), Number(d), Number(hour), 'kr') + Number(minute) * 60_000;
      const window = windowFrom(at(month, day, m[5], m[6]), at(endMonth ?? month, endDay ?? day, m[11], m[12]), Boolean(endMonth));
      if (window) windows.add(window);
    }
  } else {
    if (!/maintenance/i.test(text)) return null;
    for (const m of text.matchAll(WINDOW)) {
    const offset = (m[11] === '+' ? 1 : -1) * (Number(m[12]) * 60 + Number(m[13] ?? 0)) * 60_000;
    const at = (month, day, year, hour, minute) => Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute)) - offset;
    const window = windowFrom(at(m[1], m[2], m[3], m[4], m[5]), at(m[6] ?? m[1], m[7] ?? m[2], m[8] ?? m[3], m[9], m[10]), Boolean(m[6]));
    if (window) windows.add(window);
    }
  }
  if (windows.size !== 1) return null;
  const [startAt, endAt] = [...windows][0].split('/');
  return { startAt, endAt };
}

/** A bulletin record from the board's list item and its detail. */
export function bulletinRecord(item, detail, firstSeen) {
  const link = parseJumpLink(detail?.jumpLink);
  const kind = bulletinKind(item.category ?? detail?.category, link);
  const heading = cleanTitle(detail?.header);
  const imageUrl = String(detail?.bannerImageUrl ?? '').trim();
  return {
    id: String(item.cid),
    kind,
    category: Number(item.category ?? detail?.category),
    title: cleanTitle(item.title ?? detail?.title),
    ...(heading ? { heading } : {}),
    displayDate: String(item.displayTime ?? detail?.displayTime ?? ''),
    ...(link ? { link } : {}),
    ...(kind === 'banner' ? { poolId: link.param } : {}),
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
    firstSeen,
  };
}

/** The queries a picture's host is asked for the same picture smaller, in order: the same size as
 *  WebP, then 1600 pixels wide. A host without image processing answers with the original. */
export const SMALLER_COPIES = ['imageMogr2/format/webp', 'imageMogr2/thumbnail/1600x/format/webp'];

/** Whether bytes are a picture a page can show: JPEG, PNG, WebP or GIF, by their first bytes. */
export function isPicture(bytes) {
  const b = Buffer.from(bytes ?? []);
  if (b.length < 12) return false;
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    || /^GIF8[79]a$/.test(b.toString('latin1', 0, 6));
}

/** The site's headline from its answer: { title, url }. The 16:9 still of its trailer (videoImage)
 *  is the key visual alone; `image`, the page's hero, has the site's side strip drawn in. */
export function siteHeadline(data) {
  const title = cleanTitle(data?.versionName);
  const url = String(data?.videoImage || data?.image || '').trim();
  if (!title || !/^https:\/\//.test(url)) throw new Error('the official site names no headline with a picture: its layout has probably changed');
  return { title, url };
}

const byDateThenId = date => (a, b) => (date(b) ?? '').localeCompare(date(a) ?? '') || b.firstSeen.localeCompare(a.firstSeen) || a.id.localeCompare(b.id);

function listedBulletins(response, region) {
  const list = response?.data?.list;
  if (!Array.isArray(list) || list.some(item => typeof item?.cid !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(item?.displayTime ?? '')))) {
    throw new Error(`${region}'s webview board lists no items with their ids and dates: its layout has probably changed`);
  }
  return list;
}

function listedNotices(response, region) {
  const list = response?.announceList;
  if (!Array.isArray(list) || list.some(item => typeof item?.announceId !== 'string')) {
    throw new Error(`${region}'s announcement list names no notices: its layout has probably changed`);
  }
  return list;
}

const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');

/** The same picture smaller from its host (SMALLER_COPIES), { url, sha1, bytes }, or null when the
 *  host serves none. A failed request throws, and the picture is asked again the next run. */
async function smallerCopy(image, fetcher, pause) {
  for (const query of SMALLER_COPIES) {
    const url = `${image.url}${image.url.includes('?') ? '&' : '?'}${query}`;
    const bytes = await getBytes(url, fetcher);
    await pause();
    if (isPicture(bytes) && bytes.length <= MAX_ART_BYTES && bytes.length < image.bytes) return { url, sha1: sha1(bytes), bytes: bytes.length };
  }
  return null;
}

export function readOfficialBulletins(root) {
  const file = path.join(root, OFFICIAL_BULLETINS);
  if (!fs.existsSync(file)) return { version: 1, regions: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.version !== 1 || typeof data.regions !== 'object') throw new Error(`${OFFICIAL_BULLETINS} is not {"version":1,"regions":{...}}`);
  return data;
}

/**
 * Reads every region's boards into the file. Returns { problems: [{ key, action, reason }],
 * added: { region: count } }; writes the file only when what it says changed.
 */
export async function syncOfficialBulletins(root, { fetcher = globalThis.fetch, now = defaultNow(), pause = () => new Promise(resolve => setTimeout(resolve, 300)) } = {}) {
  const today = day(now);
  const before = readOfficialBulletins(root);
  const next = { version: 1, regions: {} };
  const problems = [], added = {};

  for (const region of REGIONS) {
    const previous = before.regions[region] ?? { bulletins: [], notices: [] };
    const bulletins = new Map((previous.bulletins ?? []).map(record => [record.id, record]));
    const notices = new Map((previous.notices ?? []).map(record => [record.id, record]));
    added[region] = 0;
    let network;
    try {
      network = await regionNetwork(region, fetcher);
    } catch (error) {
      console.warn(error.message);
      problems.push({ key: `official-bulletins:${region}`, action: 'kept-previous', reason: `The ${region} client's network_config could not be read; its notice boards keep what they last said.` });
      next.regions[region] = previous;
      continue;
    }

    try {
      const listed = listedBulletins(await getJson(`${network.prean}/api/game/bulletinList?target=Android`, fetcher), region);
      for (const item of listed) {
        if (bulletins.has(item.cid)) continue;
        try {
          const detail = (await getJson(`${network.prean}/api/game/bulletin/${encodeURIComponent(item.cid)}`, fetcher))?.data;
          if (!detail || String(detail.cid) !== item.cid) throw new Error('the detail names another item');
          bulletins.set(item.cid, bulletinRecord(item, detail, today));
          added[region]++;
        } catch (error) {
          console.warn(`${region} bulletin ${item.cid} could not be read: ${error.message}`);
          problems.push({ key: `official-bulletins:${region}:${item.cid}`, action: 'omitted-new',
            reason: `The ${region} in-game notice "${cleanTitle(item.title)}" (${item.cid}) could not be read; it is left out until it can be.` });
        } finally {
          await pause();
        }
      }
      const newest = listed.map(item => item.displayTime).sort().at(-1);
      if (newest && daysBetween(newest, today) > STALE_DAYS) {
        problems.push({ key: `official-bulletins:${region}:stale`, action: 'kept-previous',
          reason: `The ${region} in-game board's newest notice is from ${newest}: the board has probably moved, and its notices stop at that day.` });
      }
    } catch (error) {
      console.warn(error.message);
      problems.push({ key: `official-bulletins:${region}:board`, action: 'kept-previous', reason: `The ${region} in-game board could not be read; its notices stay as they were.` });
    }

    const headlines = new Map((previous.headlines ?? []).map(record => [record.image?.url, record]));
    if (SITE_HEADLINES[region]) {
      try {
        const { title, url } = siteHeadline((await getJson(SITE_HEADLINES[region], fetcher))?.data);
        if (!headlines.has(url)) {
          headlines.set(url, { title, image: { url }, firstSeen: today });
          added[region]++;
        }
      } catch (error) {
        console.warn(`${region} official site: ${error.message}`);
        problems.push({ key: `official-bulletins:${region}:site`, action: 'kept-previous', reason: `The ${region} official site's headline could not be read; the headlines seen before stay.` });
      } finally {
        await pause();
      }
    }

    // Art hashed once: a record with an address and no hash is new, or one whose image failed.
    for (const [label, record] of [...[...bulletins.values()].map(record => [`bulletin ${record.id}`, record]), ...[...headlines.values()].map(record => [`site headline "${record.title}"`, record])]) {
      if (!record.image?.url) continue;
      try {
        if (!record.image.sha1) {
          const bytes = await getBytes(record.image.url, fetcher);
          record.image = { url: record.image.url, sha1: sha1(bytes), bytes: bytes.length };
          await pause();
        }
        if (record.image.bytes > MAX_ART_BYTES && record.image.small === undefined) record.image.small = await smallerCopy(record.image, fetcher, pause);
      } catch (error) {
        console.warn(`${region} ${label}'s image could not be hashed (asked again next run): ${error.message}`);
        await pause();
      }
    }

    if (network.an && !DEAD_ANNOUNCEMENT_LISTS.has(region)) {
      try {
        const listed = listedNotices(await getJson(network.an, fetcher), region);
        for (const item of listed) {
          if (notices.has(item.announceId)) continue;
          const date = noticeDate(item.month, item.day, now);
          notices.set(item.announceId, { id: item.announceId, group: String(item.group ?? ''), title: cleanTitle(item.title),
            ...(date ? { date } : {}), ...(item.webUrl ? { url: stableUrl(item.webUrl) } : {}), firstSeen: today });
          added[region]++;
        }
        // A maintenance notice's window, read once, and again while it is still to come or under
        // way (a notice can move it). A page that names no window keeps `null`.
        if (MAINTENANCE_REGIONS.has(region)) {
          for (const notice of notices.values()) {
            if (!maybeMaintenance(region, notice)) continue;
            if ('maintenance' in notice && !(notice.maintenance && Date.parse(notice.maintenance.endAt) > new Date(now).getTime())) continue;
            try {
              notice.maintenance = parseMaintenance((await getBytes(notice.url, fetcher)).toString('utf8'), region, notice.date);
            } catch (error) {
              console.warn(`${region} notice ${notice.id} could not be read for a maintenance window (asked again next run): ${error.message}`);
            } finally {
              await pause();
            }
          }
        }
        const newest = listed.map(item => noticeDate(item.month, item.day, now)).filter(Boolean).sort().at(-1);
        if (newest && daysBetween(newest, today) > STALE_DAYS) {
          problems.push({ key: `official-bulletins:${region}:announcements-stale`, action: 'kept-previous',
            reason: `The ${region} in-game announcement list's newest notice is from ${newest}: the list has probably moved.` });
        }
      } catch (error) {
        console.warn(error.message);
        problems.push({ key: `official-bulletins:${region}:announcements`, action: 'kept-previous', reason: `The ${region} in-game announcement list could not be read; its notices stay as they were.` });
      }
    }

    next.regions[region] = {
      bulletins: [...bulletins.values()].sort(byDateThenId(record => record.displayDate)),
      notices: [...notices.values()].sort(byDateThenId(record => record.date)),
      ...(headlines.size ? { headlines: [...headlines.values()].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.image.url.localeCompare(b.image.url)) } : {}),
    };
  }

  const text = `${JSON.stringify(next, null, 1)}\n`;
  const file = path.join(root, OFFICIAL_BULLETINS);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  return { problems, added };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const stage = beginStage(root, 'official-bulletins');
  syncOfficialBulletins(root).then(({ problems, added }) => {
    for (const problem of problems) stage.add(problem);
    console.log(`Official notice boards: ${REGIONS.map(region => `${region} +${added[region] ?? 0}`).join(', ')}${problems.length ? `; ${problems.length} problem(s)` : ''}.`);
    stage.commit();
  }, error => {
    console.error(error);
    stage.add({ key: 'official-bulletins', action: 'kept-previous', reason: 'The official notice boards could not be read; the facts kept from earlier runs stand.' });
    stage.commit();
    process.exitCode = 1;
  });
}
