/*
 * New outfits on sale on Global with no confirmed window behind them.
 *
 * /skins calls an outfit "available now" only from a window in
 * data/skin-availability-windows.json, which is written by hand from the official notice:
 * the Outfit Store often outlives its event (Duel Channel: Ivy Vine closed on 7 October,
 * its outfits on 21 October), and nothing in the client says when a sale ends. Without an
 * entry, an outfit falls back to the CN projection of a later event, so the three Ivy Vine
 * outfits read "Estimated 8 Oct" for the days they were on sale, and nothing reported it.
 *
 * So each Outfit Store outfit is given the one event that released it -- the event that
 * links it, else the one its release text names, else (for a record whose text names no
 * event) the announced Global window its client date falls in -- and when that event's
 * Global window is announced (startAt and endAt, not an estimate) and open at `now`, the
 * outfit needs a window in that file that lists it and reaches the event. One that has
 * none is returned, for check-completeness to hold as a published-partial record: the
 * outfit still goes out, shown as an estimate, and the day's quarantine issue says which
 * notice to copy.
 */
const fold = name => String(name ?? '').replace(/\[[^\]]*\]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const DAY = 86_400_000;

/** The announced Global window of an event, or null for a date range, an estimate or none. */
function announcedWindow(event) {
  const global = event?.global;
  if (!global?.startAt || !global?.endAt || /estimat/i.test(global.note ?? '')) return null;
  const start = Date.parse(global.startAt), end = Date.parse(global.endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? { start, end } : null;
}

export function unconfirmedOutfitSales({ skins, events, windows, now }) {
  // Required, never defaulted: without the clock or the windows this check has no answer,
  // and a default would pass silently for whichever caller forgot one.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('unconfirmedOutfitSales needs the current time');
  if (!Array.isArray(windows)) throw new Error('unconfirmedOutfitSales needs the confirmed windows (data/skin-availability-windows.json entries)');
  const byName = new Map(events.map(event => [fold(event.name), event]));
  const announced = events.map(event => ({ event, open: announcedWindow(event) })).filter(({ open }) => open);
  const found = [];
  for (const skin of skins) {
    if (!/Outfit Store/i.test(skin.howToObtain ?? '')) continue;
    let owner = events.find(event => event.linkedSkinNames?.includes(skin.name)) ?? byName.get(fold(skin.release));
    // Only a record whose release text names no event is placed by date: a long event (a
    // six-week Stronghold season) spans many others' openings, and must not claim their outfits.
    if (!owner && Number.isFinite(skin.globalReleaseAt)) {
      // The client's getTime can precede the announced opening by the maintenance hour.
      const at = skin.globalReleaseAt * 1000;
      owner = announced.filter(({ open }) => at >= open.start - DAY && at < open.end)
        .sort((a, b) => b.open.start - a.open.start)[0]?.event;
    }
    const open = announcedWindow(owner);
    if (!open || now.getTime() < open.start || now.getTime() >= open.end) continue;
    const key = `${skin.model} / ${skin.name}`;
    const confirmed = windows.some(window => window.kind !== 'draw' && (window.skinIds ?? []).includes(key)
      && Date.parse(window.endAt) > open.start);
    if (!confirmed) found.push({ skin, event: owner, key });
  }
  return found;
}
