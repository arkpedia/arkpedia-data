import type { HeadhuntingBanner } from './headhuntingBanners';
import { dateStringValue } from './limitedRerunNotes';

/* Pure: the page's browser half uses classifyLimitedBanner, so this module must not
   reach the banner list itself. The lookups take the banners the caller already
   holds -- getStaticProps passes getAllHeadhuntingBanners() from
   headhuntingBannerData.ts, which the content export runs against the release. */

export type LimitedBannerType = 'Celebration' | 'Festival' | 'Carnival' | 'Crossover';

const KNOWN_TYPES = new Set<string>(['Celebration', 'Festival', 'Carnival', 'Crossover']);

/**
 * Which of the four Limited sub-types a banner belongs to. The type
 * lives as a bracketed prefix in the banner's own name -- e.g.
 * "[Celebration] Cremation Last Wish", "[Festival] Earthborn Metals" --
 * NOT in the `category` field, which is just the generic string
 * "limited" for every Limited banner regardless of sub-type.
 *
 * A handful of crossover-collab banners use a franchise-specific
 * bracket label instead of the generic "[Crossover]" tag (e.g.
 * "[Elite Tactical] ... Rerun" for the Rainbow Six Siege collab,
 * "[Dungeon Adventure] ..." for the Delicious in Dungeon collab), and
 * a couple of reruns have no bracket at all. Every one of these
 * observed cases in the real data is a themed crossover collab, so
 * any bracket label outside the four known ones -- and any banner
 * with no bracket at all -- defaults to Crossover rather than being
 * silently left unclassified.
 */
export function classifyLimitedBanner(banner: HeadhuntingBanner): LimitedBannerType {
  const match = banner.name.match(/^\[([^\]]+)\]/);
  if (match && KNOWN_TYPES.has(match[1])) return match[1] as LimitedBannerType;
  return 'Crossover';
}

// Duplicated from headhuntingBanners.ts's own (unexported) parseStartDate
// rather than modifying that file's exports -- same start-of-range
// parsing logic, applied to global_date specifically.
function parseGlobalStartDate(banner: HeadhuntingBanner): string | null {
  const range = banner.global_date;
  if (!range) return null;
  const start = range.split('\u2013')[0];
  const m = start.match(/^(\d{4}\/\d{1,2}\/\d{1,2})/);
  return m ? m[1] : null;
}


/**
 * An operator's Limited sub-type and the Global start date (YYYY/MM/DD) of every
 * Limited banner that features them, oldest first. Which appearance is the latest
 * past one and which an announced future one depends on the day it is read, so
 * lib/gacha/limitedRerunNotes.ts splits them at render.
 */
export interface LimitedAppearances {
  type: LimitedBannerType;
  appearances: string[];
}

/** What releases exported before `appearances` carry: the split made at their export. */
export interface ExportedLimitedSplit {
  type: LimitedBannerType;
  lastBannerDate: string | null; // most recent PAST appearance
  nextScheduledDate: string | null; // earliest known FUTURE appearance, if any -- an actually-announced rerun, not an estimate
}

export type LimitedOperatorInfo = LimitedAppearances | ExportedLimitedSplit;

/**
 * Operator name -> their Limited sub-type and every Limited banner appearance,
 * built in one pass over every Limited banner's featured lineup (both six_stars
 * slots, any off-banner rate_up_six_stars, and any featured five_stars/four_stars).
 * The type is taken from the FIRST banner an operator is found in -- reruns of the
 * same operator's original banner classify to the same sub-type in every case
 * checked against the real data, even when a rerun uses a different bracket label.
 * Crossover operators' reruns depend on external collab agreements rather than a
 * predictable internal calendar, so there's no reasonable basis for estimating one
 * the way there is for Celebration/Festival/Carnival.
 */
export function getLimitedBannerInfoLookup(banners: readonly HeadhuntingBanner[]): Record<string, LimitedAppearances> {
  const lookup: Record<string, LimitedAppearances> = {};
  const limitedBanners = banners.filter((b) => b.pull_type === 'limited');

  for (const banner of limitedBanners) {
    const type = classifyLimitedBanner(banner);
    const date = parseGlobalStartDate(banner);
    const names = [
      ...(banner.six_stars || []),
      ...(banner.rate_up_six_stars || []),
      ...(banner.five_stars || []),
      ...(banner.four_stars || []),
    ];
    for (const name of names) {
      const entry = lookup[name] ??= { type, appearances: [] };
      if (date && !entry.appearances.includes(date)) entry.appearances.push(date);
    }
  }
  for (const entry of Object.values(lookup)) entry.appearances.sort((a, b) => dateStringValue(a) - dateStringValue(b));
  return lookup;
}

/**
 * Every known Celebration banner's start date, sorted ascending
 * (oldest first), covering both past and any future/announced ones
 * in the data. Celebration reruns aren't tied to a fixed calendar date
 * the way Festival/Carnival are -- they follow the actual banner
 * schedule (roughly twice a year, but not on fixed dates), so
 * estimating a Celebration operator's next rerun means looking at
 * this real schedule directly rather than projecting a fixed date.
 */
export function getCelebrationBannerDates(banners: readonly HeadhuntingBanner[]): string[] {
  const dates: string[] = [];
  const celebrations = banners.filter((b) => b.pull_type === 'limited' && classifyLimitedBanner(b) === 'Celebration');
  for (const banner of celebrations) {
    const date = parseGlobalStartDate(banner);
    if (date) dates.push(date);
  }
  dates.sort((a, b) => dateStringValue(a) - dateStringValue(b));
  return dates;
}