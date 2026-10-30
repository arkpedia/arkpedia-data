import { SERVER_TIME, serverInstant, parseInstant, type GameServer } from '@/lib/time/servers.mjs';
/** Explicit instants use ISO 8601 with a timezone; endAt is exclusive. */
export interface GameWindowTimes {
  startAt?: string;
  endAt?: string;
  timingSource?: string;
  /** When the event's store closes, exclusive, where it outlasts the stages: the client's
   *  rewardEndTime (scripts/sync/sync-event-windows.mjs). Absent when the store closes with
   *  the stages, and on events from before the sync recorded it. */
  shopEndAt?: string;
}

/** A calendar day as a record writes it: the year, the month (1-12) and the day of the month. */
export interface GameDay { year: number; month: number; day: number }

/**
 * The two calendar days of a recorded range, "YYYY/MM/DD–YYYY/MM/DD": an en dash or a hyphen,
 * spaces allowed around it, and an optional "; note" tail ("2022/03/17–2022/03/31; 181 days
 * after CN"), which is ignored. Null when the text is not a range or names a day that does not
 * exist (2026/02/30). Says nothing about order or time of day: parseGameWindow places the days
 * in server time, and the /schedule grid (parseDateRange) on the reader's own calendar. Both
 * read the text here, so a range one of them accepts is never one the other drops: the grid
 * once split on the dash alone and lost all 23 Global events of 2022, which carry the tail.
 */
export function parseGameRangeDays(range: string | null | undefined): { start: GameDay; end: GameDay } | null {
  const match = matchGameRange(range);
  const start = match && rangeDay(match, 1), end = match && rangeDay(match, 4);
  return start && end ? { start, end } : null;
}

function matchGameRange(range: string | null | undefined): RegExpMatchArray | null {
  return range?.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[–-]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*;.*)?$/) ?? null;
}

/** One side of a matched range (offset 1 the start, 4 the end), or null for a day that does not exist. */
function rangeDay(match: RegExpMatchArray, offset: number): GameDay | null {
  const year = +match[offset], month = +match[offset + 1], day = +match[offset + 2];
  const midnight = new Date(Date.UTC(year, month - 1, day));
  if (midnight.getUTCFullYear() !== year || midnight.getUTCMonth() !== month - 1 || midnight.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Date-only legacy records use a server-time estimate, never the host timezone.
 * Global event releases normally open at 08:00 UTC-7; routine pools at 04:00.
 * Exact announcement/client times always take precedence over those defaults.
 */
export function parseGameWindow(range: string | null | undefined, times: GameWindowTimes = {}, region: 'global' | GameServer = 'global', routinePool = false): { start: Date; end: Date } | null {
  const match = matchGameRange(range);
  const server = region === 'global' ? 'en' : region;
  const profile = SERVER_TIME[server];
  const day = (offset: number, hour: number): Date | null => {
    const date = match && rangeDay(match, offset);
    return date ? new Date(serverInstant(date.year, date.month, date.day, hour, server)) : null;
  };
  const start = times.startAt ? parseInstant(times.startAt) : day(1, routinePool ? profile.resetHour : profile.eventOpenHour);
  const end = times.endAt ? parseInstant(times.endAt) : day(4, profile.resetHour);
  return start && end && start < end ? { start, end } : null;
}

/** When an event's store closes, if after its stages (GameWindowTimes.shopEndAt); null when it
 *  closes with them. */
export function eventShopEnd(event: { end: Date; shopEndAt?: string }): Date | null {
  const at = event.shopEndAt ? Date.parse(event.shopEndAt) : NaN;
  return Number.isFinite(at) && at > event.end.getTime() ? new Date(at) : null;
}

export function windowCountdown(start: Date, end: Date, now: Date): { label: 'Starts in' | 'Ends in' | 'Ended'; remaining: number } {
  if (now < start) return { label: 'Starts in', remaining: start.getTime() - now.getTime() };
  if (now < end) return { label: 'Ends in', remaining: end.getTime() - now.getTime() };
  return { label: 'Ended', remaining: 0 };
}
