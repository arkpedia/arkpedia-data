/**
 * Where each region's game client looks for its version, files and notice board, read the way
 * the client reads it: from that region's network_config, the one address the client carries.
 * Shared by the version watcher (scripts/sync/watch-client-versions.mjs) and the notice-board
 * poller (scripts/sync/sync-official-bulletins.mjs).
 *
 * What these readers send and keep (decided 2026-10-18): anonymous GETs to the same public
 * addresses the game and its in-game webview request, a few dozen a day, under a User-Agent
 * that names the site. They keep derived facts only -- a version, a title, a date, a banner's
 * pool id, an image's address and hash -- never a copy of a notice or of a file list.
 *
 * The region keys are data/regional-schedules.json's: en (Global), jp, kr, cn.
 */

export const OFFICIAL_USER_AGENT = 'ArkpediaBot/1.0 (+https://www.arkpedia.net)';

export const REGIONS = ['en', 'jp', 'kr', 'cn'];

const NETWORK_CONFIG = {
  en: 'https://ak-conf.arknights.global/config/prod/official/network_config',
  jp: 'https://ak-conf.arknights.jp/config/prod/official/network_config',
  kr: 'https://ak-conf.arknights.kr/config/prod/official/network_config',
  cn: 'https://ak-conf.hypergryph.com/config/prod/official/network_config',
};

/* The official websites' headline: the key visual a region's site shows for its current event and
   the site's name for it. KR's site (a CMS behind www.arknights.kr) has no news of its own, and its
   in-game board shows one template picture on every event, so this is KR's own event art. One GET
   a run; the address and hash are kept (sync-official-bulletins.mjs), never the picture. */
export const SITE_HEADLINES = { kr: 'https://www.arknights.kr/api/resource/version' };

/* CN's network_config still names an announcement list (announce_meta) whose newest notice is
   from 2025-05: the board moved to the webview and the pointer stayed. Reading it would report
   a dead feed every night, so CN's notices come from its webview board alone. */
export const DEAD_ANNOUNCEMENT_LISTS = new Set(['cn']);

async function request(url, fetcher, init = {}) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { 'user-agent': OFFICIAL_USER_AGENT, ...init.headers } });
  if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

export async function getJson(url, fetcher = globalThis.fetch, init = {}) {
  return (await request(url, fetcher, init)).json();
}

export async function getBytes(url, fetcher = globalThis.fetch) {
  return Buffer.from(await (await request(url, fetcher)).arrayBuffer());
}

/**
 * A region's addresses, from its network_config: {hv} the version file, {hu} the file host,
 * {an} the in-game announcement list, {prean} the webview board's host. The config wraps its
 * settings as a JSON string under `content`, keyed by the version it names in `funcVer`.
 */
export async function regionNetwork(region, fetcher = globalThis.fetch) {
  const url = NETWORK_CONFIG[region];
  if (!url) throw new Error(`No network_config for region ${region}`);
  const wrapper = await getJson(url, fetcher);
  const config = typeof wrapper?.content === 'string' ? JSON.parse(wrapper.content) : wrapper;
  const network = config?.configs?.[config?.funcVer]?.network;
  if (!network?.hv || !network?.hu || !network?.prean) throw new Error(`${region}'s network_config names no version file, file host or webview: its layout has probably changed`);
  const android = value => String(value).replace('{0}', 'Android');
  return { hv: android(network.hv), hu: android(network.hu), an: network.an ? android(network.an) : null, prean: String(network.prean).replace(/\/+$/, '') };
}
