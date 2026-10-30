/**
 * Which version of the game each region's client is on, and whether the mirror this refresh
 * reads that region's tables from has it yet: data/client-versions.json.
 *
 * Per region (en, jp, kr, cn), from the client's own version file (network_config's `hv`):
 *   - resVersion and clientVersion, the day this watcher first saw them, and the version before;
 *   - when the version is new, that version's file list (hot_update_list.json, ~3 MB, fetched
 *     once per version) reduced to a digest per top-level folder -- so the next version can say
 *     which parts of the client changed: `anon` (the game tables), `chararts` (operator art),
 *     `skinpack` (outfits)... -- and the ids of the operator art it ships, so a new version
 *     names the operators whose art arrived (`newChararts`), often a patch before release;
 *   - the version the mirror carries, read at the run's pinned commit (pin-upstream.mjs) from
 *     the first bytes of its own copy of the file list.
 *
 * A mirror behind the live client is reported (kept-previous: tonight's tables for that region
 * are the version before), overdue after MIRROR_GRACE_DAYS. A file list that cannot be read
 * leaves the digests of the version before and is asked for again the next run.
 *
 * Nothing in the file changes on a day the game does not: no "last checked" time, so a quiet
 * night writes the same bytes and publishes nothing. scripts/lib/official-endpoints.mjs says
 * what these requests are and what is kept.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { getJson, REGIONS, regionNetwork, OFFICIAL_USER_AGENT } from '../lib/official-endpoints.mjs';
import { pinnedRef } from '../content/pin-upstream.mjs';

export const CLIENT_VERSIONS = 'data/client-versions.json';
export const MIRROR_GRACE_DAYS = 2;

/* The mirror each region's tables are read from, and where it keeps its version. The Global,
   JP and KR tables come from ArknightsAssets/ArknightsGamedata, whose file list starts with the
   versionId; the CN art and fallback tables from yuanyan3060, whose `version` file is just it. */
export const MIRROR_VERSION = {
  en: { repository: 'ArknightsAssets/ArknightsGamedata', file: 'en/hot_update_list.json' },
  jp: { repository: 'ArknightsAssets/ArknightsGamedata', file: 'jp/hot_update_list.json' },
  kr: { repository: 'ArknightsAssets/ArknightsGamedata', file: 'kr/hot_update_list.json' },
  cn: { repository: 'yuanyan3060/ArknightsGameResource', file: 'version' },
};

const day = now => new Date(now).toISOString().slice(0, 10);
const RES_VERSION = /^[\w-]{10,64}$/;

/** A file list reduced to what the next version is compared with: the bundle count, one short
 *  digest per top-level folder (sha1 of its sorted name:md5 lines), and the operator-art ids. */
export function manifestDigest(list, resVersion) {
  const infos = list?.abInfos;
  if (!Array.isArray(infos) || !infos.length || infos.some(info => typeof info?.name !== 'string')) throw new Error('the file list names no bundles');
  const folders = new Map();
  const chararts = new Set();
  for (const { name, md5 } of infos) {
    const folder = name.includes('/') ? name.slice(0, name.indexOf('/')) : '(root)';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(`${name}:${md5 ?? ''}`);
    const art = name.match(/^chararts\/(char_\d+_[a-z0-9]+)/i);
    if (art) chararts.add(art[1].toLowerCase());
  }
  const digest = lines => crypto.createHash('sha1').update(lines.sort().join('\n')).digest('hex').slice(0, 12);
  return {
    resVersion,
    bundles: infos.length,
    folders: Object.fromEntries([...folders.keys()].sort().map(folder => [folder, digest(folders.get(folder))])),
    chararts: [...chararts].sort(),
  };
}

/** What changed from one digest to the next: the folders whose digest differs (added and
 *  removed ones too), and the operator art the new one ships that the old one did not. */
export function manifestChanges(before, after) {
  if (!before || !after || before.resVersion === after.resVersion) return {};
  const names = new Set([...Object.keys(before.folders ?? {}), ...Object.keys(after.folders ?? {})]);
  const changedFolders = [...names].filter(name => before.folders?.[name] !== after.folders?.[name]).sort();
  const known = new Set(before.chararts ?? []);
  const newChararts = (after.chararts ?? []).filter(id => !known.has(id));
  return { changedFolders, ...(newChararts.length ? { newChararts } : {}) };
}

/** The resVersion at the start of a mirror's file: a JSON file list's versionId, or a bare line. */
export function mirrorResVersion(text) {
  const value = String(text ?? '');
  const id = value.match(/"versionId"\s*:\s*"([^"]+)"/)?.[1] ?? value.trim().split(/\s+/)[0];
  return RES_VERSION.test(id ?? '') ? id : null;
}

async function readMirror(region, fetcher, env) {
  const { repository, file } = MIRROR_VERSION[region];
  const url = `https://raw.githubusercontent.com/${repository}/${pinnedRef(repository, env)}/${file}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': OFFICIAL_USER_AGENT, range: 'bytes=0-511' } });
  if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status} for ${url}`);
  const resVersion = mirrorResVersion(await response.text());
  if (!resVersion) throw new Error(`${url} names no version`);
  return { repository, resVersion };
}

export function readClientVersions(root) {
  const file = path.join(root, CLIENT_VERSIONS);
  if (!fs.existsSync(file)) return { version: 1, regions: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.version !== 1 || typeof data.regions !== 'object') throw new Error(`${CLIENT_VERSIONS} is not {"version":1,"regions":{...}}`);
  return data;
}

export async function watchClientVersions(root, { fetcher = globalThis.fetch, now = defaultNow(), env = process.env } = {}) {
  const today = day(now);
  const before = readClientVersions(root);
  const next = { version: 1, regions: {} };
  const problems = [], changed = [];

  for (const region of REGIONS) {
    const previous = before.regions[region] ?? null;
    let network, live;
    try {
      network = await regionNetwork(region, fetcher);
      live = await getJson(network.hv, fetcher);
      if (!RES_VERSION.test(String(live?.resVersion ?? '')) || !live?.clientVersion) throw new Error(`${network.hv} names no resVersion and clientVersion`);
    } catch (error) {
      console.warn(`${region}: ${error.message}`);
      problems.push({ key: `client-versions:${region}`, action: 'kept-previous', reason: `The ${region} client's version could not be read; the last one seen stands.` });
      if (previous) next.regions[region] = previous;
      continue;
    }

    const same = previous?.resVersion === live.resVersion;
    const entry = {
      resVersion: live.resVersion,
      clientVersion: String(live.clientVersion),
      firstSeen: same ? previous.firstSeen : today,
      ...(same ? (previous.previous ? { previous: previous.previous } : {})
        : previous ? { previous: { resVersion: previous.resVersion, clientVersion: previous.clientVersion, firstSeen: previous.firstSeen } } : {}),
    };
    if (!same) changed.push(`${region} ${previous?.resVersion ?? '(none)'} -> ${live.resVersion}`);

    // The file list, once per version: the one kept is this version's, or it is fetched.
    let manifest = previous?.manifest ?? null;
    let changes = same ? { ...(previous.changedFolders ? { changedFolders: previous.changedFolders } : {}), ...(previous.newChararts ? { newChararts: previous.newChararts } : {}) } : {};
    if (manifest?.resVersion !== live.resVersion) {
      try {
        const list = await getJson(`${network.hu}/Android/assets/${encodeURIComponent(live.resVersion)}/hot_update_list.json`, fetcher);
        if (list?.versionId && list.versionId !== live.resVersion) throw new Error(`the file list is for ${list.versionId}`);
        const fresh = manifestDigest(list, live.resVersion);
        changes = manifestChanges(manifest, fresh);
        manifest = fresh;
      } catch (error) {
        console.warn(`${region}: the ${live.resVersion} file list could not be read (asked again next run): ${error.message}`);
        problems.push({ key: `client-versions:${region}:files`, action: 'published-partial',
          reason: `The file list of the ${region} client's ${live.resVersion} could not be read; what that version changed is unknown until it can be.` });
      }
    }
    Object.assign(entry, changes);
    if (manifest) entry.manifest = manifest;

    try {
      entry.mirror = await readMirror(region, fetcher, env);
    } catch (error) {
      console.warn(`${region}: the mirror's version could not be read: ${error.message}`);
      if (previous?.mirror) entry.mirror = previous.mirror;
    }
    if (entry.mirror && entry.mirror.resVersion !== entry.resVersion) {
      problems.push({ key: `client-versions:${region}:mirror`, action: 'kept-previous', overdueAfterDays: MIRROR_GRACE_DAYS,
        reason: `The ${region} client is on ${entry.resVersion} (first seen ${entry.firstSeen}); ${entry.mirror.repository} still carries ${entry.mirror.resVersion}, so this run's ${region} tables are the version before.` });
    }
    next.regions[region] = entry;
  }

  const text = `${JSON.stringify(next, null, 1)}\n`;
  const file = path.join(root, CLIENT_VERSIONS);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  return { problems, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const stage = beginStage(root, 'client-versions');
  watchClientVersions(root).then(({ problems, changed }) => {
    for (const problem of problems) stage.add(problem);
    console.log(changed.length ? `New client versions: ${changed.join('; ')}.` : 'No client changed version.');
    stage.commit();
  }, error => {
    console.error(error);
    stage.add({ key: 'client-versions', action: 'kept-previous', reason: 'The client versions could not be read; the last ones seen stand.' });
    stage.commit();
    process.exitCode = 1;
  });
}
