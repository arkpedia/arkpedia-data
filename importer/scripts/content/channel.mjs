#!/usr/bin/env node
/**
 * The content channels: per branch of this repository that Prepare content release runs on, the
 * arkpedia-data branch its release is published to and the pointer branch whose current.json
 * names it. A site reads the pointer of its channel (lib/content/server.ts, through
 * ARKPEDIA_CONTENT_CHANNEL, which Deploy sets from the deployment's branch).
 *
 *   node scripts/content/channel.mjs --branch <branch>   the channel's settings, as lines for $GITHUB_ENV
 *
 * Only main publishes production content. Retired dev snapshots are preserved under
 * archive tags; native Worker Previews consume live content without a dev publisher.
 * Other branches fail closed instead of creating another release channel.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import channelConfig from './content-channel.cjs';

/** config/content-channels.json: { main: { dataBranch, pointer } }. */
export const CHANNELS = channelConfig.CHANNELS;

/** The channel `branch` publishes to, or an error: no other branch has one. */
export function channelFor(branch) {
  const channel = Object.hasOwn(CHANNELS, branch ?? '') ? CHANNELS[branch] : null;
  if (!channel) throw new Error(`${branch} has no content channel: Prepare content release publishes only from ${Object.keys(CHANNELS).join(' or ')}`);
  return channel;
}

/** The pointer branch a reader of the release uses (scripts/content/content-channel.cjs, which
 *  next.config.js asks too): ARKPEDIA_CONTENT_CHANNEL, else the channel of the Vercel project a
 *  Deploy build is for, else live. */
export const contentPointer = channelConfig.contentPointer;
/** The pointer a deployment of a branch reads: its channel's, else live. */
export const pointerForBranch = channelConfig.pointerForBranch;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--branch');
  const branch = at > 0 ? process.argv[at + 1] : undefined;
  const { dataBranch, pointer } = channelFor(branch);
  console.log(`ARKPEDIA_RELEASE_BRANCH=${branch}`);
  console.log(`ARKPEDIA_DATA_BRANCH=${dataBranch}`);
  console.log(`ARKPEDIA_CONTENT_POINTER=${pointer}`);
}
