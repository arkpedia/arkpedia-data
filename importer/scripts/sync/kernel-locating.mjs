import { serverDay, SERVER_TIME } from '../../lib/time/servers.mjs';
/**
 * Kernel Locating banners: Global's own pool type (CN has none), named "Kernel Locating #N
 * (Global)". The bulk import of 2026-09-16 brought #1 to #12 and nothing added any after it:
 * #13 (2026/10/20–11/03) was announced in the official Global post of 2026-10-09 and missing
 * from the site, because neither the catalogue nor the recurring banners read this kind.
 *
 * Three sources, the client first:
 *   - the EN client's gacha_table: a FESCLASSIC pool is the banner, with its exact window, its
 *     pool id and its whole lineup (dynMeta.rarityPickCharDict). It ships with the client
 *     update, usually the day the banner opens;
 *   - the official Global announcement (data/official-news/global, sync-official-news.mjs): a
 *     "KERNEL LOCATING OPEN" section gives the DURATION and every operator ("★★★★★★ (2%): ...")
 *     about a week ahead, so the banner is published from it until the client carries it;
 *   - the wiki's yearly banner page: a "kernel locating" row gives the banner its number.
 *     Without one the banner takes the number after the last recorded one.
 * A banner is found again by its pool, else by its Global days, so the client takes over the
 * record the announcement made. Banners from the bulk import (no lineupSource) are history and
 * are only ever linked to their pool, never rewritten.
 */
import { newsSections, parseDuration } from '../build/official-news.mjs';
import { savedGlobalBannerNotice } from './global-client-banners.mjs';

export const kernelLocatingName = number => `Kernel Locating #${number} (Global)`;
const numberOf = name => {
  const match = /^Kernel Locating #(\d+) \(Global\)$/.exec(name ?? '');
  return match ? Number(match[1]) : null;
};
// A pool or post older than this with no record is history the bulk import left unnamed.
const CREATE_WITHIN = 30 * 86400;

/** Server days (UTC-7), as the records write global_date. */
const seconds = iso => Math.floor(Date.parse(iso) / 1000);
const daysOf = (start, end) => `${serverDay(start, SERVER_TIME.en.offset)}–${serverDay(end, SERVER_TIME.en.offset)}`;

/** Every "KERNEL LOCATING OPEN" section of the cached Global posts, newest post last:
 *  { start, end } (ISO), the 6- and 5-star names as written, and the post's address. */
export function kernelLocatingNotices(posts) {
  const notices = new Map();
  for (const post of [...posts].sort((a, b) => (a.publishTime ?? 0) - (b.publishTime ?? 0))) {
    for (const section of newsSections(post.lines ?? [])) {
      if (!/^KERNEL LOCATING OPEN\b/.test(section.title)) continue;
      const duration = parseDuration(section.lines.find(line => /^DURATION:/.test(line)));
      if (!duration?.end) continue;
      // "★★★★★★ (2%): Goldenglow / Dorothy / ..."; five stars never match the six-star line.
      const tier = stars => {
        const line = section.lines.find(text => new RegExp(`^★{${stars}}\\s*\\(`).test(text));
        return line ? line.replace(/^[^:]*:\s*/, '').split('/').map(name => name.trim()).filter(Boolean) : [];
      };
      // A later post about the same window (a correction) replaces the earlier one.
      notices.set(duration.start, { start: duration.start, end: duration.end, six: tier(6), five: tier(5), source: post.url });
    }
  }
  return [...notices.values()];
}

/** The client's whole lineup for a Kernel Locating pool, or null when it names none. */
function clientLineup(pool, characters) {
  const dict = pool.dynMeta?.rarityPickCharDict;
  const ids = tier => Array.isArray(dict?.[tier]) ? dict[tier] : null;
  const six = ids('TIER_6'), five = ids('TIER_5');
  if (!six?.length || !five?.length) return null;
  const names = list => list.map(id => characters[id]?.name);
  const [sixNames, fiveNames] = [names(six), names(five)];
  return sixNames.every(Boolean) && fiveNames.every(Boolean) ? { six: sixNames, five: fiveNames } : null;
}

/** The lineup if every name is a recorded operator of its rarity, else { problem }. */
function checkLineup(lineup, roster, recordName) {
  const six = lineup.six.map(name => recordName(name) ?? name), five = lineup.five.map(name => recordName(name) ?? name);
  const wrong = [...six.filter(name => roster.get(name) !== 6), ...five.filter(name => roster.get(name) !== 5)];
  if (!six.length || !five.length) return { problem: 'names no 6-star or no 5-star operators' };
  if (wrong.length) return { problem: `names ${wrong.join(', ')}, which no operator record of that rarity matches` };
  return { six, five };
}

/**
 * Reconciles the Kernel Locating banners in `banners` (mutated) with the client's pools, the
 * announcements and the wiki rows. Returns { additions, quarantine, changed }; quarantine
 * entries are { key, action, reason, sourceRef } for the recurring-banners stage to report.
 */
export function reconcileKernelLocating({ banners, gachaTable, characters, notices, wikiRows, roster, recordName, clientSource, now = Date.now() }) {
  const nowSeconds = Math.floor(now / 1000);
  const additions = [], quarantine = [];
  let changed = false;
  const isLocating = banner => numberOf(banner.name) != null;
  const rows = (wikiRows ?? []).filter(row => row.type === 'kernel locating' && /^\d+$/.test(row.no ?? ''));
  const wikiNumber = start => {
    const day = serverDay(start, SERVER_TIME.en.offset);
    const row = rows.find(cell => String(cell.start ?? '').startsWith(day));
    return row ? Number(row.no) : null;
  };
  const nextNumber = () => Math.max(0, ...banners.filter(isLocating).map(banner => numberOf(banner.name))) + 1;
  const byDays = days => banners.find(banner => isLocating(banner) && banner.global_date === days);

  /** Publishes `lineup` on `banner` from `source`, unless a better source already did. */
  const RANK = { pending: 0, wiki: 1, announcement: 2, client: 3 };
  const setLineup = (banner, lineup, source, sourceRef) => {
    if ((RANK[banner.lineupSource] ?? -1) >= RANK[source] && banner.six_stars?.length) return;
    const checked = checkLineup(lineup, roster, recordName);
    if (checked.problem) {
      quarantine.push({ key: `banner:${banner.name}`, action: 'published-partial', sourceRef,
        reason: `${banner.name} is published without its operators: the ${source === 'announcement' ? 'announcement' : source} ${checked.problem}.` });
      return;
    }
    Object.assign(banner, { six_stars: checked.six, five_stars: checked.five, lineupSource: source });
    changed = true;
  };
  const create = (number, start, end, window) => {
    const name = kernelLocatingName(number);
    const banner = {
      name, category: 'kernel', cn_date: null, global_date: daysOf(start, end), global_date_estimated: false,
      global_window: window, banner_image: `/headhunting-banner-images/${name.replace('#', '')}.webp`,
      year: Number(serverDay(start, SERVER_TIME.en.offset).slice(0, 4)), four_stars: [], five_stars: [], rate_up_six_stars: [], six_stars: [],
      pull_type: 'kernel', linked_event: null, lineupSource: 'pending',
    };
    banners.push(banner);
    additions.push(name);
    changed = true;
    return banner;
  };

  // The client's pools first: whatever they say about a window wins.
  const pools = (gachaTable.gachaPoolClient ?? []).filter(pool => pool.gachaRuleType === 'FESCLASSIC' && pool.openTime && pool.endTime)
    .sort((a, b) => a.openTime - b.openTime);
  for (const pool of pools) {
    const days = daysOf(pool.openTime, pool.endTime);
    // By its pool, else its days, else an announced record no pool holds yet whose window the
    // pool's overlaps: a post a day off the client must not leave a second banner behind.
    const overlaps = record => {
      const [start, end] = [Date.parse(record.global_window?.startAt ?? ''), Date.parse(record.global_window?.endAt ?? '')];
      return start < pool.endTime * 1000 && pool.openTime * 1000 < end;
    };
    let banner = banners.find(record => record.globalPoolId === pool.gachaPoolId) ?? byDays(days)
      ?? banners.find(record => isLocating(record) && !record.globalPoolId && record.lineupSource && overlaps(record));
    const window = { startAt: new Date(pool.openTime * 1000).toISOString(),
      endAt: new Date((pool.endTime + (pool.endTime % 60 === 59 ? 1 : 0)) * 1000).toISOString(), timingSource: clientSource };
    if (!banner) {
      if (pool.openTime < nowSeconds - CREATE_WITHIN) continue;
      banner = create(wikiNumber(pool.openTime) ?? nextNumber(), pool.openTime, pool.endTime, window);
    }
    if (!banner.globalPoolId) { banner.globalPoolId = pool.gachaPoolId; changed = true; }
    // History from the bulk import keeps its record; only what this importer added follows the client.
    if (!banner.lineupSource) continue;
    // By where the timing came from, not the address: the client's carries the commit each
    // run pins, and rewriting it every night would make every night a new release.
    const fromClient = /\/ArknightsGamedata\/[^/]+\/en\/gamedata\/excel\/gacha_table\.json$/.test(banner.global_window?.timingSource ?? '');
    if (!savedGlobalBannerNotice(banner, pool) && (!fromClient || banner.global_date !== days)) {
      Object.assign(banner, { global_date: days, global_date_estimated: false, global_window: window });
      if (banner.globalScheduleStatus === 'announced') banner.globalScheduleStatus = 'datamined';
      changed = true;
    }
    const lineup = clientLineup(pool, characters);
    if (lineup) setLineup(banner, lineup, 'client', clientSource);
  }

  // Then the announcements for windows the client does not carry yet.
  for (const notice of notices) {
    const start = seconds(notice.start), end = seconds(notice.end);
    if (end < nowSeconds || start < nowSeconds - CREATE_WITHIN) continue;
    const days = daysOf(start, end);
    // By its days, else the Kernel Locating whose window the post's overlaps (the client may
    // have moved it a day): one window is one banner.
    let banner = byDays(days) ?? banners.find(record => isLocating(record)
      && Date.parse(record.global_window?.startAt ?? '') < Date.parse(notice.end) && Date.parse(notice.start) < Date.parse(record.global_window?.endAt ?? ''));
    if (!banner) banner = create(wikiNumber(start) ?? nextNumber(), start, end, { startAt: notice.start, endAt: notice.end, timingSource: notice.source });
    if (!banner.lineupSource) continue;
    setLineup(banner, notice, 'announcement', notice.source);
  }

  // A wiki row names an operator lineup too: the last resort for a banner still pending.
  for (const banner of banners) {
    if (banner.lineupSource !== 'pending') continue;
    const row = rows.find(cell => Number(cell.no) === numberOf(banner.name));
    const split = names => String(names ?? '').split(',').map(name => name.trim()).filter(Boolean);
    if (row) setLineup(banner, { six: split(row.operators1), five: split(row.operators2) }, 'wiki', null);
    if (banner.lineupSource === 'pending' && !quarantine.some(entry => entry.key === `banner:${banner.name}`)) {
      quarantine.push({ key: `banner:${banner.name}`, action: 'published-partial', sourceRef: banner.global_window?.timingSource ?? null,
        reason: `${banner.name} is published without its operators, which the client, the announcement or the wiki's yearly banner page supplies.` });
    }
  }
  return { additions, quarantine, changed };
}
