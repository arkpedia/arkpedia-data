import type { GameWindowTimes } from '@/lib/schedule/gameWindow';

/*
 * The banner record and the helpers a page can run in the browser. No data here: the
 * list itself, and the art check that resolves each banner_image, are in
 * headhuntingBannerData.ts, which only server code imports. A page's browser half that
 * reached ALL_BANNERS compiled the whole deploy-time list (and the asset index behind
 * publishedArt) into its chunk; /events/[slug] and /obtain-method never rendered from
 * it, and /schedule reads the release's copy from its props.
 */

/** Where a banner's featured lineup came from, as scripts/sync/catalogue-model.mjs and
 *  sync-recurring-banners.mjs record it: the wiki's row, the six-stars the game client
 *  names (five-stars still unknown), the names on a Standard banner's art in the client
 *  (scripts/sync/banner-art-lineup.mjs), the lineup an official CN announcement names once
 *  every operator it names has a record ('announcement'), or nothing yet. 'pending' ships
 *  with empty lineup arrays until a wiki row for the banner's window names the lineup or,
 *  for an announced banner, until the operators its post names have records; such a banner
 *  carries the post's names meanwhile, in announcedLineup. Hand-kept records carry none. */
export type BannerLineupSource = 'wiki' | 'client' | 'client-art' | 'announcement' | 'pending';

/** Which name the record carries: the client's Chinese one while the wiki has none,
 *  the wiki's community English one, or the official Global one. Undefined -- every
 *  hand-kept and recurring record -- means official. Community names are shown as
 *  they are, unlabelled (maintainer decision). */
export type BannerNameStatus = 'cn-official' | 'en-unofficial' | 'en-official';

export interface HeadhuntingBanner {
  timingServer?: import('@/lib/time/servers.mjs').GameServer;
  name: string;
  /** Names the record had before the catalogue renamed it, for matching old links. */
  aliases?: string[];
  category: string;
  cn_date: string | null;
  global_date: string | null;
  global_date_estimated?: boolean;
  /** An obsolete forecast is withheld until a Global pool or announcement replaces it. */
  globalForecastWithdrawn?: boolean;
  /** Client-extracted timing is provisional until a published Global announcement. */
  globalScheduleStatus?: 'datamined' | 'announced';
  /** Forecast timing is available; Global has not confirmed its own lineup yet. */
  globalLineupPending?: boolean;
  schedule_anchor?: string;
  cnPoolId?: string;
  globalPoolId?: string;
  lineupSource?: BannerLineupSource;
  /** The name an official CN announcement gave the banner, as it writes it ("海渊巡游", "定向甄选"):
   *  the catalogue finds the record of an announced banner again by it, with its kind, so a later
   *  post that moves the window moves this record rather than adding a second one
   *  (scripts/sync/catalogue-model.mjs applyAnnouncements). Kept after the wiki renames it, and
   *  only on banners an announcement created; nothing on the site reads it. */
  announcedName?: string;
  /** The rate-ups an official CN announcement names, as it writes them, while an operator it names
   *  has no record yet (lineupSource 'pending'; scripts/sync/catalogue-model.mjs applyAnnouncements). */
  announcedLineup?: { six: string[]; five: string[]; rateUpSix: string[] };
  nameStatus?: BannerNameStatus;
  global_window?: GameWindowTimes;
  cn_window?: GameWindowTimes;
  banner_image?: string | null;
  six_stars: string[]; // for Limited banners, only the first 2 (true featured)
  rate_up_six_stars?: string[]; // Limited banners only: the remaining "off-banner rate-up" 6-stars
  five_stars: string[];
  four_stars?: string[]; // featured 4-stars -- 50% chance when a 4-star is rolled, shared 50% among everyone else
  pull_type: 'featured' | 'limited' | 'special' | 'standard' | 'kernel' | 'orienteering' | 'joint' | 'celebration' | 'unknown';
  year: number | string;
  linked_event: string | null; // computed once at scrape time against the per-year event records
}

/** A name for comparing: prefix, rerun suffix and punctuation aside; run identity is checked separately. Letters of any script stay, so
 *  an event under its Chinese name ("[Side Story] 昨日海") is not the empty string. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\brerun\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseStartDate(range: string | null | undefined): number | null {
  if (!range) return null;
  const start = range.split('–')[0];
  const m = start.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Banners sorted newest-first by Global date start, for the Gacha
 * page's banner picker. */
export function sortBannersByDate<T extends HeadhuntingBanner>(banners: readonly T[]): T[] {
  function startDate(b: HeadhuntingBanner): number {
    return parseStartDate(b.global_date || b.cn_date) || 0;
  }
  return [...banners].sort((a, b) => startDate(b) - startDate(a));
}

/** An event's Global date range as evidence for getBannerForEvent: null while it is only
 * an estimate (the note says so -- the test getEventCalendar uses for isPredicted). */
export function confirmedGlobalRange(global: { dateRange?: string | null; note?: string | null } | null | undefined): string | null {
  return /estimated|predicted/i.test(global?.note || '') ? null : global?.dateRange ?? null;
}

/** Finds the headhunting banner of a schedule event, if any -- used to show "pullable
 * operators" for that event. Only explicit evidence links the two, in order:
 *   1. The banner's persisted linked_event field (computed at scrape time and
 *      inspectable directly in the JSON).
 *   2. The same Global opening day: the one Featured or Limited banner whose Global
 *      window opens on the day the event's Global window does, and only when there is
 *      one; a banner flagged global_date_estimated is skipped. Pass null for an
 *      estimated event date (confirmedGlobalRange, or a listing's isPredicted); a test
 *      holds every page's call to that.
 * A banner the catalogue created from the CN client under its Chinese name
 * (nameStatus 'cn-official') is CN-only, so it is never matched by date either.
 *
 * Names are not compared. Banner titles are not event titles -- in the 2026-09 data no
 * event matched a banner by name -- and the old substring match on normalised names
 * matched a Chinese-named banner, which normalises to "", to every event: the day a CN
 * pool reached the client before the wiki had a row for it, that CN-only banner became
 * the headhunting banner of every Global event page that has none. */
export function getBannerForEvent(eventName: string, eventGlobalDateRange: string | null | undefined, banners: readonly HeadhuntingBanner[]): HeadhuntingBanner | null {
  const target = normalize(eventName);
  if (target) {
    const rerun = (name: string) => /\[rerun\]|\brerun\s*$/i.test(name);
    const explicitMatch = banners.find((b) => b.linked_event && rerun(b.linked_event) === rerun(eventName)
      && normalize(b.linked_event) === target
      && (!eventGlobalDateRange || !b.global_date || b.global_date_estimated
        || parseStartDate(b.global_date) === parseStartDate(eventGlobalDateRange)));
    if (explicitMatch) return explicitMatch;
  }

  // A rerun does not automatically repeat its original banner, or own an unrelated one
  // that happens to open that day. Its association needs an explicit rerun link.
  if (/\[rerun\]|\brerun\s*$/i.test(eventName)) return null;
  const eventStart = parseStartDate(eventGlobalDateRange);
  if (!eventStart) return null;
  const sameDay = banners.filter((b) => (b.pull_type === 'featured' || b.pull_type === 'limited')
    && b.nameStatus !== 'cn-official' && !b.global_date_estimated && parseStartDate(b.global_date) === eventStart);
  return sameDay.length === 1 ? sameDay[0] : null;
}
