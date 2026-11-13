/** Announcement-specific art must never leak another event's dates or prices. */
export function packArtKey(source, name) { return `${source}::${name}`; }

export function resolvePackArt(art, source, name) {
  const promo = art[packArtKey(source, name)];
  if (typeof promo === 'string' && promo) return { path: promo, layout: 'promo' };
  const fallback = art[name];
  return typeof fallback === 'string' && fallback ? { path: fallback, layout: 'icon' } : null;
}
