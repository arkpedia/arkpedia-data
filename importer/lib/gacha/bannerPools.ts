/**
 * Each Global headhunting pool's banner name, by the game's pool id: what the pull history
 * (lib/account/pulls.ts) names a banner by. From the banner records' globalPoolId, which the
 * catalogue records as it matches a Global pool; a pool none records yet is named by the
 * Account Center's own name for it. The id map carries it (build-game-account-map.ts), and the
 * Account page fills it from the bundled records for a release compiled before it had it.
 */
export function bannerPoolNames(banners: { name?: unknown; globalPoolId?: unknown }[]): Record<string, string> {
  const pools: Record<string, string> = {};
  for (const banner of banners) {
    if (typeof banner?.globalPoolId === 'string' && /^[\w-]{1,80}$/.test(banner.globalPoolId) && typeof banner.name === 'string' && !pools[banner.globalPoolId]) pools[banner.globalPoolId] = banner.name;
  }
  return Object.fromEntries(Object.entries(pools).sort(([a], [b]) => a.localeCompare(b)));
}
