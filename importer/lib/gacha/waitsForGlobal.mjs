/** Joint Operation and Orienteering forecasts can carry CN timing, but Global's own
 * pool or announcement must confirm their lineup. A forecast date is not evidence. */
export const GLOBAL_LINEUP_KINDS = new Set(['joint', 'orienteering']);

export function waitsForGlobal(banner) {
  if (!GLOBAL_LINEUP_KINDS.has(banner?.pull_type ?? '') || banner?.globalPoolId || banner?.global_window?.timingSource) return false;
  if (banner?.globalLineupPending) return true;
  // A record from before the catalogue linked pools (no CN pool either: the app's bundled
  // snapshot) dates its Global run from history, so its Global date stands; one the catalogue
  // linked to its CN pool, with no Global pool, is not in Global's client yet whatever date the
  // wiki gave it.
  return !banner?.global_date || !!banner?.cnPoolId || !!banner?.global_date_estimated;
}

/** Keep timing for forecasts without leaking CN operators, announced names or artwork.
 * Do not mutate the source record: a later Global content release supplies its lineup. */
export function globalBannerPreview(banner) {
  if (!waitsForGlobal(banner)) return banner;
  const preview = {
    ...banner,
    globalLineupPending: true,
    global_date: banner.globalForecastWithdrawn ? null : banner.global_date,
    global_date_estimated: true,
    banner_image: null,
    six_stars: [], five_stars: [], four_stars: [], rate_up_six_stars: [],
    lineupSource: 'pending',
  };
  delete preview.global_window;
  delete preview.announcedLineup;
  return preview;
}
