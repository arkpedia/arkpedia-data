/* Global timing forecasts and lineup confirmation are independent. */
export { waitsForGlobal, globalBannerPreview } from './waitsForGlobal.mjs';

interface BannerWindow {
  global_date: string | null;
  cn_date: string | null;
  global_date_estimated?: boolean;
  globalForecastWithdrawn?: boolean;
  schedule_anchor?: string;
  pull_type?: string;
  globalPoolId?: string | null;
  global_window?: { timingSource?: string | null } | null;
}

interface EventWindow {
  name: string;
  cn: { dateRange: string | null };
  global: { dateRange: string | null };
}

const date = (value: string) => {
  const match = value.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return NaN;
  const [, y, m, d] = match;
  const stamp = Date.UTC(+y, +m - 1, +d);
  const parsed = new Date(stamp);
  return parsed.getUTCFullYear() === +y && parsed.getUTCMonth() === +m - 1 && parsed.getUTCDate() === +d ? stamp : NaN;
};

const range = (value: string | null) => {
  const parts = (value || '').split(/[–—]/).map(date);
  return parts.length === 2 && parts.every(Number.isFinite) && parts[1] >= parts[0] ? parts : null;
};

const format = (stamp: number) => new Date(stamp).toISOString().slice(0, 10).replace(/-/g, '/');

/** Resolve explicitly identified estimates from the shared event window while
 * retaining the banner's own CN offset and duration. Confirmed windows win. */
export function resolveBannerEventWindow<T extends BannerWindow>(banner: T, events: readonly EventWindow[]): T {
  if (!banner.global_date_estimated || !banner.schedule_anchor) return banner;
  const event = events.find(value => value.name === banner.schedule_anchor);
  const cnEvent = range(event?.cn.dateRange ?? null);
  const globalEvent = range(event?.global.dateRange ?? null);
  const cnBanner = range(banner.cn_date);
  if (!cnEvent || !globalEvent || !cnBanner) return { ...banner, global_date: null };
  const offset = globalEvent[0] - cnEvent[0];
  return { ...banner, global_date: `${format(cnBanner[0] + offset)}–${format(cnBanner[1] + offset)}` };
}

/** Calendar-style fallback for CN-only banners without a linked event window. */
export function estimateBannerFromCn<T extends BannerWindow>(banner: T, gapDays: number): T {
  if (banner.globalForecastWithdrawn) return { ...banner, global_date: null };
  if (banner.global_date) return banner;
  const cn = range(banner.cn_date);
  if (!cn) return banner;
  const offset = gapDays * 86400000;
  return {
    ...banner,
    global_date: `${format(cn[0] + offset)}–${format(cn[1] + offset)}`,
    global_date_estimated: true,
  };
}
