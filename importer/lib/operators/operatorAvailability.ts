import { serverDayBoundary } from '@/lib/time/servers.mjs';
export type ReleaseOperator = {
  releaseAt?: string;
  /** Until when the debut lasts (Operator.availableUntil). */
  availableUntil?: string;
  characterInfo?: Record<string, string> | null;
  /** Only a fallback for placeholder records that have no release date. */
  isFuture?: boolean | null;
};
const DAY = 86_400_000;

/** Global release dates are UTC-7 calendar dates, never the viewer's midnight.
 * Without a confirmed hour, wait until that calendar day has passed before
 * calling an operator released. Do not invent a precise opening time. */
export function operatorRelease(op: ReleaseOperator): { at: number; dayStart: number; exact: boolean } | null {
  if (op.releaseAt && /(?:Z|[+-]\d{2}:\d{2})$/i.test(op.releaseAt)) {
    const at = Date.parse(op.releaseAt);
    if (Number.isFinite(at)) return { at, dayStart: at, exact: true };
  }
  const raw = op.characterInfo?.['Release Date']?.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const day = match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) : Date.parse(`${raw} UTC`);
  if (!Number.isFinite(day)) return null;
  const date = new Date(day);
  if (match && (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3])) return null;
  const dayStart = serverDayBoundary(day, 'en', 'calendar');
  return { at: dayStart + DAY, dayStart, exact: false };
}

/** Two weeks, for an operator whose debut has no known end (or a release from before the
 *  records carried one). */
const NEW_WINDOW_DAYS = 14;

/**
 * Whether an operator reads as newly available ("Now Available" on the roster): released, and
 * its debut still running -- the banner it came on, or an event operator's event stages
 * (Operator.availableUntil). It counted two weeks from the release, and so still named the
 * People, A People operators after its banner and stages closed (2026-09-30).
 */
export function isDebutAvailable(op: ReleaseOperator, now: number): boolean {
  const release = operatorRelease(op);
  if (!release || now < release.at) return false;
  const until = op.availableUntil ? Date.parse(op.availableUntil) : NaN;
  if (Number.isFinite(until)) return now < until;
  return now - release.at <= NEW_WINDOW_DAYS * DAY;
}

export function operatorReleaseLabel(op: ReleaseOperator, now: number): string | null {
  const release = operatorRelease(op);
  if (!release || now >= release.at) return null;
  if (!release.exact && now >= release.dayStart) return 'Releases today';
  const remaining = (release.exact ? release.at : release.dayStart) - now;
  if (remaining < 3_600_000) return `In ${Math.ceil(remaining / 60_000)}m`;
  if (remaining < DAY) return `In ${Math.ceil(remaining / 3_600_000)}h`;
  const days = Math.ceil(remaining / DAY);
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * One release-state decision for every operator surface.
 *
 * Exact Global timestamps win, date-only legacy records keep the conservative
 * UTC-7 safeguard above, and `isFuture` is consulted only when neither exists.
 * That prevents a manually stored flag or calendar date from making an operator
 * playable before the confirmed Global release instant.
 *
 * `now` is required: a defaulted clock let the content export freeze its own
 * moment into page data (/enemies, /schedule, the colour palette), which then
 * stayed wrong until the next release. Pass the request's or the reader's time.
 */
export function isOperatorReleased(op: ReleaseOperator, now: number): boolean {
  return isReleasedAt(releaseMarker(op), now);
}

/**
 * The part of an operator's release state that does not depend on the clock, for
 * page data that is exported once and judged per request. `releasedAt` is the
 * instant isOperatorReleased switches (null without a usable date), and
 * `isFuture` is the flag it falls back to then.
 */
export interface ReleaseMarker { releasedAt: number | null; isFuture?: true }

export function releaseMarker(op: ReleaseOperator): ReleaseMarker {
  const release = operatorRelease(op);
  if (release) return { releasedAt: release.at };
  return op.isFuture === true ? { releasedAt: null, isFuture: true } : { releasedAt: null };
}

/**
 * The planner's operators as the reader sees them: every operator the export offers, the ones
 * not on Global yet marked cnOnly. Planning an operator's materials before Global has them is
 * what the planner is for, and kukki's site offered them (it hid only placeholders); this one
 * kept Global-released operators alone, so nineteen CN operators -- Closure, Viy, Kal'tsit -
 * Esperanta, the Persona 3 crossover -- could not be added after the switch on 2026-09-30.
 * Read from the release markers the export already carries, so the content release in use,
 * which main's code compiles, needs nothing new: a field added to the export reached neither
 * site until main shipped it. Every operator reaches CN first, so not on Global yet is CN only.
 * An operator without art or build data is still left out where the page's export decides that.
 */
export function plannerOperators<T extends Partial<ReleaseMarker>>(ops: T[], now: number): (T & { cnOnly?: true })[] {
  return ops.map((op) => (isReleasedAt(op, now) ? op : { ...op, cnOnly: true as const }));
}

/** isOperatorReleased for a marker. A payload from before markers existed has none,
 * and was already filtered to released operators when it was exported. */
export function isReleasedAt(marker: Partial<ReleaseMarker> | undefined, now: number): boolean {
  if (!marker || marker.releasedAt === undefined) return true;
  if (marker.releasedAt !== null) return now >= marker.releasedAt;
  return marker.isFuture !== true;
}
