/**
 * A content channel's pointer (scripts/content/channel.mjs), read the way every reader of the
 * release reads it: <root>/<channel>/current.json, else, while that branch does not exist yet
 * (dev-live before the dev channel's first run publishes it), live's, so a reader never goes
 * without a release. Only a missing branch falls back -- a 404, which `read` reports as the
 * thrown error's `status`, never matched from its message -- and a channel that exists but
 * fails stays an error, never quietly main's release.
 *
 * Its readers: lib/content/server.ts (the site) and readLiveAssetPins
 * (scripts/build/adopt-release-asset-pins.mjs: prebuild's asset pins, and Deploy's asset-link
 * check after the deploy). Only the site fell back once, so arkpedia-dev's build and its
 * asset-link check failed on a channel the site read happily.
 */
export async function readChannelPointer({ root, channel, read, warn = () => {} }) {
  try {
    return await read(`${root}/${channel}/current.json`);
  } catch (error) {
    if (channel === 'live' || error?.status !== 404) throw error;
    warn(`${channel} has no pointer yet: reading live's release until it does.`);
    return read(`${root}/live/current.json`);
  }
}
