/**
 * Which content pointer a reader of the release uses, in CommonJS so next.config.js can ask too
 * (scripts/content/channel.mjs re-exports it). ARKPEDIA_CONTENT_CHANNEL when set; else, in a
 * Deploy build, the channel of the branch the Vercel project being built follows
 * (VERCEL_PROJECT_ID, which Deploy sets for every build, looked up in config/production.json),
 * so production builds use the configured live pointer; else live.
 * lib/content/server.ts's contentChannel() writes the same rule out for the site's bundle.
 */
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { channels: CHANNELS } = require(path.join(root, 'config/content-channels.json'));
const { deployments } = require(path.join(root, 'config/production.json'));

const POINTER = /^[a-z0-9][a-z0-9-]*$/;

/** The pointer a deployment of `branch` reads: its channel's, else live. */
function pointerForBranch(branch) {
  return Object.hasOwn(CHANNELS, branch ?? '') ? CHANNELS[branch].pointer : 'live';
}

function contentPointer(env = process.env) {
  const project = env.VERCEL_PROJECT_ID ? deployments.find(deployment => deployment.vercel?.projectId === env.VERCEL_PROJECT_ID) : null;
  const value = env.ARKPEDIA_CONTENT_CHANNEL || pointerForBranch(project?.branch);
  if (!POINTER.test(value)) throw new Error(`ARKPEDIA_CONTENT_CHANNEL must be a branch name of lower-case letters, digits and dashes, not ${value}`);
  return value;
}

module.exports = { CHANNELS, contentPointer, pointerForBranch };
