import { isOperatorReleased, type ReleaseOperator } from '@/lib/operators/operatorAvailability';
import { toServerTime } from '@/lib/time/servers.mjs';
import type { LimitedBannerType, LimitedOperatorInfo } from './limitedBannerType';

/**
 * The Obtain Method page's Limited notes ("Festival — est. 42 days until next rerun").
 *
 * Every date here is a Global calendar date, so the math is done on the game server's
 * day in UTC terms, with `now` passed in. It used to call setHours/getFullYear on the
 * host's clock during render: the UTC server render and a browser anywhere else
 * disagreed, React threw the server HTML away (errors #425/#418/#423), and the last/
 * next split was fixed at content export besides.
 */

const DAY = 86_400_000;

/** A YYYY/MM/DD calendar date as its UTC midnight: the same number on every host. Here,
 * not in limitedBannerType.ts, so the page's bundle does not pull in the banner data. */
export function dateStringValue(s: string): number {
  const [y, m, d] = s.split('/').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** The server's current day as a UTC midnight. */
function serverToday(now: number): number {
  const day = toServerTime(new Date(now));
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

function format(value: number): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from the server's today until `dateStr` (YYYY/MM/DD), never negative. */
export function daysUntil(dateStr: string, now: number): number {
  return Math.max(0, Math.ceil((dateStringValue(dateStr) - serverToday(now)) / DAY));
}

/** The next month/day strictly after the server's today, as YYYY/MM/DD. */
export function nextOccurrenceOf(month: number, day: number, now: number): string {
  const today = serverToday(now);
  const year = new Date(today).getUTCFullYear();
  let candidate = Date.UTC(year, month - 1, day);
  if (candidate <= today) candidate = Date.UTC(year + 1, month - 1, day);
  return format(candidate);
}

export function monthsSince(dateStr: string, now: number): number {
  const [y, m, d] = dateStr.split('/').map(Number);
  const today = new Date(serverToday(now));
  let months = (today.getUTCFullYear() - y) * 12 + (today.getUTCMonth() - (m - 1));
  if (today.getUTCDate() < d) months -= 1;
  return months;
}

export function addMonths(dateStr: string, monthsToAdd: number): string {
  const [y, m, d] = dateStr.split('/').map(Number);
  return format(Date.UTC(y, m - 1 + monthsToAdd, d));
}

/**
 * Celebration estimate: normally the next incoming Celebration banner. If the
 * operator hasn't been released for at least 10 months yet, that next incoming one
 * doesn't count for them -- they target the SECOND next one instead. Either way, if
 * the targeted banner isn't actually in the known schedule (not enough future dates
 * on record), the fallback is 6 months added to the most recent known Celebration
 * banner date, whether that banner has already happened or is itself a
 * future/announced one.
 */
export function estimateCelebrationRerun(releaseDate: string | null, celebrationDates: string[], now: number): string | null {
  if (celebrationDates.length === 0) return null;
  const today = serverToday(now);
  const futureDates = celebrationDates.filter((d) => dateStringValue(d) > today); // celebrationDates is already sorted ascending
  const tooNew = releaseDate ? monthsSince(releaseDate, now) < 10 : false;
  const targetIndex = tooNew ? 1 : 0; // "next" vs "second next"
  if (futureDates.length > targetIndex) return futureDates[targetIndex];
  const lastKnown = celebrationDates[celebrationDates.length - 1]; // sorted ascending -- last entry is the most recent known, past or future
  return addMonths(lastKnown, 6);
}

/** An operator's most recent past Limited appearance and earliest announced future
 * one, split at the server's today (a banner starting today counts as past). A
 * release exported before `appearances` existed carries the split made at its export. */
export function limitedBannerSplit(info: LimitedOperatorInfo, now: number): { type: LimitedBannerType; lastBannerDate: string | null; nextScheduledDate: string | null } {
  if (!('appearances' in info)) return info;
  const today = serverToday(now);
  let lastBannerDate: string | null = null, nextScheduledDate: string | null = null;
  for (const date of info.appearances) {
    if (dateStringValue(date) > today) { if (!nextScheduledDate || dateStringValue(date) < dateStringValue(nextScheduledDate)) nextScheduledDate = date; }
    else if (!lastBannerDate || dateStringValue(date) > dateStringValue(lastBannerDate)) lastBannerDate = date;
  }
  return { type: info.type, lastBannerDate, nextScheduledDate };
}

/** The note under a Limited operator's card, or null for none. */
export function limitedOperatorNote(
  op: ReleaseOperator,
  info: LimitedOperatorInfo | undefined,
  celebrationBannerDates: string[],
  now: number,
): string | null {
  if (!info) return null;
  const { type, nextScheduledDate } = limitedBannerSplit(info, now);

  // An actually-announced future banner appearance always wins over an estimate,
  // regardless of type -- this is real data, not a guess. But it's only a RERUN if
  // the operator has already been released before -- for an operator whose own
  // release date hasn't happened yet, this incoming banner is their debut, not a
  // return appearance, and labeling it "rerun" would be wrong.
  if (nextScheduledDate) {
    const label = isOperatorReleased(op, now) ? 'scheduled rerun' : 'release';
    return `${type} — ${daysUntil(nextScheduledDate, now)} days until ${label}`;
  }

  // Crossover reruns depend on external collab agreements, not a predictable
  // internal calendar -- there's no reasonable basis to estimate one the way there
  // is for Celebration/Festival/Carnival, so this deliberately shows no countdown
  // rather than a misleading guess.
  if (type === 'Crossover') return type;

  // Festival always estimates to the next occurrence of July 17, Carnival to the
  // next occurrence of January 17 -- fixed calendar dates, not derived from any
  // operator's own history.
  if (type === 'Festival') return `${type} — est. ${daysUntil(nextOccurrenceOf(7, 17, now), now)} days until next rerun`;
  if (type === 'Carnival') return `${type} — est. ${daysUntil(nextOccurrenceOf(1, 17, now), now)} days until next rerun`;

  // Celebration: based on the real banner schedule, not a fixed date -- see
  // estimateCelebrationRerun.
  const releaseDate = op.characterInfo?.['Release Date'] || null;
  const estimated = estimateCelebrationRerun(releaseDate, celebrationBannerDates, now);
  if (!estimated) return type;
  return `${type} — est. ${daysUntil(estimated, now)} days until next rerun`;
}
