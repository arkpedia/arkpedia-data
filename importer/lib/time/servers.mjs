/** Fixed game-server time. UTC offsets never follow the reader's timezone or DST.
 * Wall-calendar dates and 04:00 game-day dates are deliberately different:
 * EN midnight is 07:00Z, while its daily rollover is 11:00Z.
 * Exact client/announcement instants take precedence over estimated opening hours.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const SERVER_TIME = Object.freeze({
  en: Object.freeze({ offset: -7, resetHour: 4, eventOpenHour: 8, timeZone: 'Etc/GMT+7' }),
  jp: Object.freeze({ offset: 9, resetHour: 4, eventOpenHour: 16, timeZone: 'Etc/GMT-9' }),
  kr: Object.freeze({ offset: 9, resetHour: 4, eventOpenHour: 16, timeZone: 'Etc/GMT-9' }),
  cn: Object.freeze({ offset: 8, resetHour: 4, eventOpenHour: 16, timeZone: 'Etc/GMT-8' }),
});
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Absolute source instants must state their timezone. */
export function parseInstant(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** A shifted view; read it with UTC getters, never host-local getters. */
export function serverCalendarTime(now, server = 'en') {
  return new Date(now.getTime() + SERVER_TIME[server].offset * HOUR_MS);
}

/** A shifted 04:00-rollover game-day view. Kept under its established caller name. */
export function toServerTime(now = new Date(), server = 'en') {
  return new Date(serverCalendarTime(now, server).getTime() - SERVER_TIME[server].resetHour * HOUR_MS);
}

export function serverDate(now, server = 'en') {
  return toServerTime(now, server).toISOString().slice(0, 10);
}

export function serverWeekday(now = new Date(), server = 'en') {
  return WEEKDAYS[toServerTime(now, server).getUTCDay()];
}

/** Server wall-clock fields back to a real instant (month is 1-based). */
export function serverInstant(year, month, day, hour, server = 'en') {
  return Date.UTC(year, month - 1, day, hour) - SERVER_TIME[server].offset * HOUR_MS;
}

/** Place a UTC-midnight calendar date at a named boundary of its owning server. */
export function serverDayBoundary(day, server = 'en', boundary = 'calendar') {
  const date = new Date(day);
  const profile = SERVER_TIME[server];
  const hour = boundary === 'reset' ? profile.resetHour : boundary === 'event' ? profile.eventOpenHour : 0;
  return serverInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, server);
}

export function serverOffsetLabel(server = 'en') {
  const { offset } = SERVER_TIME[server];
  return `UTC${offset < 0 ? '−' : '+'}${Math.abs(offset)}`;
}

/** The next reset strictly after now; at reset itself the countdown starts a full day. */
export function getNextDailyReset(now, server = 'en') {
  const local = serverCalendarTime(now, server);
  const reset = serverInstant(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), SERVER_TIME[server].resetHour, server);
  return new Date(reset > now.getTime() ? reset : reset + DAY_MS);
}

export function getNextWeeklyReset(now, server = 'en') {
  const next = getNextDailyReset(now, server);
  const weekday = toServerTime(next, server).getUTCDay();
  return new Date(next.getTime() + ((1 - weekday + 7) % 7) * DAY_MS);
}

export function serverClockAt(now, server = 'en') {
  return { clock: serverCalendarTime(now, server).toISOString().slice(11, 16), reset: getNextDailyReset(now, server).getTime(), offset: SERVER_TIME[server].offset };
}

/** Catalogue compatibility: Unix seconds and numeric UTC offset, defaulting to CN.
 * This is the wall-calendar day used by source records, not a daily-reset game day.
 */
export function serverDay(seconds, offset = SERVER_TIME.cn.offset) {
  return new Date(seconds * 1000 + offset * HOUR_MS).toISOString().slice(0, 10).replaceAll('-', '/');
}
