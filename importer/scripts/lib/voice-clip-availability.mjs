/**
 * Which clips a legacy voice pack really has. A legacy pack is one folder per operator in a
 * voice repository (legacy/<source commit>/<charId>/CN_xxx.mp3), recorded before the game
 * replaced the actor, and not every line was recorded then: Exusiai's legacy English folder
 * has 37 of her 38 lines and no CN_043 "Birthday". Without a per-line restriction the
 * operator page offered that line in the legacy pack and played a 404. The builder lists
 * each legacy folder at the adopted repository revision and narrows the line's
 * availablePacks to the packs that hold the file, so the page says "No recording" instead.
 *
 * An operator's current packs are left as they are: their folders are whole-game dumps, found
 * by folder (build-operator-voices.mjs's directory index), and are not listed file by file.
 * An outfit's voice set is (listFolderClips): a handful of folders per run, which says which
 * of its lines each folder records and which recordings its table gives no line at all
 * (unlistedRecordings) -- Luo Xiaohei's Elite 2 set lists 27 lines, and its folders hold 38.
 */
import { clipUrl, hasRecording } from '../../lib/operators/voiceRecording.mjs';

const FOLDER = /^https:\/\/raw\.githubusercontent\.com\/arkpedia\/(arkpedia-voice-[a-z]+)\/(?:main|[a-f0-9]{40})\/((?:current|legacy)\/.+)\/[^/]+$/;

/** A pack's repository and folder, from its template, or null. The folder is decoded
 * (current/char_311_mudrok#1): the template percent-encodes an outfit's '#'. */
export function packFolder(pack) {
  if (!pack?.audioTemplate) return null;
  const match = pack.audioTemplate.match(FOLDER);
  return match ? { repository: match[1], folder: match[2].split('/').map(decodeURIComponent).join('/') } : null;
}

/** A legacy pack's repository and folder, from its template, or null. */
export function legacyFolder(pack) {
  return pack?.status === 'legacy' ? packFolder(pack) : null;
}

/** The file a pack's template names for a line: the last segment of its address, decoded. */
export function clipFile(pack, lineId) {
  return decodeURIComponent(clipUrl(pack.audioTemplate, lineId).split('/').pop());
}

/**
 * The lines with availablePacks narrowed wherever a listed pack lacks the line's clip:
 * listed with every pack that does record it, and without the ones that do not. `listings`
 * maps a pack id to the file names in its folder; a pack it does not name is taken as
 * complete. A line every listed pack records is returned as it was.
 */
export function restrictToRecordedClips(lines, packs, listings) {
  return lines.map(line => {
    const missing = packs.filter(pack => listings.has(pack.id) && hasRecording(line, pack) && !listings.get(pack.id).has(clipFile(pack, line.id)));
    if (!missing.length) return line;
    return { ...line, availablePacks: packs.filter(pack => hasRecording(line, pack) && !missing.includes(pack)).map(pack => pack.id) };
  });
}

/**
 * The recordings in a voice set's listed folders that none of its lines plays, as Unused rows
 * shaped like the operator's own (build-operator-voices.mjs's unusedLines), each offered in the
 * packs whose folder holds it. Luo Xiaohei's Elite 2 set (char_4067_lolxh#1): its table lists
 * the 27 home-screen lines, and its folders hold all 38 clips, the in-battle and tap lines
 * recorded again but never played in the game. Only a file that names a voice line becomes a
 * row (cn_020.mp3 is CN_020): Red Countess's folders also hold her skills' sounds (fx_023.mp3
 * and the like), which are no line. `titleOf` names a row by its voice id (CN_020), or
 * returns nothing for the "Unused recording CN_020" fallback.
 */
export function unlistedRecordings(lines, packs, listings, titleOf = () => null) {
  const found = new Map();
  for (const pack of packs) {
    if (!listings.has(pack.id)) continue;
    const offered = new Set(lines.map(line => clipFile(pack, line.id)));
    for (const file of listings.get(pack.id)) {
      const match = /^cn_(\d+.*)\.mp3$/i.exec(file);
      if (!match || offered.has(file)) continue;
      const id = `CN_${match[1]}`;
      found.set(id, [...(found.get(id) ?? []), pack.id]);
    }
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, available], index) => {
    return {
      id,
      title: titleOf(id) || `Unused recording ${id}`,
      text: null,
      category: 'unused',
      status: 'unused',
      unlock: null,
      order: 2000 + index,
      availablePacks: [...new Set(available)].sort(),
    };
  });
}

/**
 * The file names in each legacy pack's folder, at the voice repository revision the release
 * adopts (data/assets/revisions.json), by the GitHub contents API. `localIndex` stands in
 * for the API ({ "<repository>/<folder>": [names] }), for tests and offline runs.
 */
export function listLegacyClips(packs, options) {
  return listClips(packs, legacyFolder, options);
}

/** The same for every pack, current ones too: an outfit's voice set (see the top). */
export function listFolderClips(packs, options) {
  return listClips(packs, packFolder, options);
}

/** The contents API's address for a voice folder at a revision, each segment encoded once. */
export function folderListingUrl(repository, folder, revision) {
  return `https://api.github.com/repos/arkpedia/${repository}/contents/${folder.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A voice folder's file names at a revision, by the contents API: a Set, 'absent', or the last
 * error of a folder never listed. GitHub's contents API answers 404 now and then for a folder
 * that is there -- on 2026-10-15, 11 of 198 listings of folders at the pinned revisions, a
 * different folder each round, one answering 404, 404 and then its 38 files -- and main's
 * Check failed on 140 clips it called missing. So a 404 is asked again like any other
 * failure, and a folder every answer called missing is looked up once more, by another road:
 * the git trees of the revision, walked by object id from the commit (folderTreeListing).
 * GitHub read the same folder there while its contents API kept answering 404 for it, and on
 * the same day the trees API, too, answered "Unable to read Git repository contents" (500)
 * for a tree it served a moment later. A folder is absent only when the trees say so as well.
 * The one rule for the voices stage (listClips) and the release audit (check-voice-clips.mjs).
 */
export async function fetchFolderListing(repository, folder, revision, { fetcher = fetch, token = process.env.GH_TOKEN, attempts = 3, sleep = pause, backoffMs = 2000 } = {}) {
  let last = '';
  let notFound = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(folderListingUrl(repository, folder, revision), {
        method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) {
        notFound += 1;
        last = 'HTTP 404';
      } else if (response.ok) {
        const entries = await response.json();
        if (Array.isArray(entries)) return new Set(entries.filter(entry => entry.type === 'file').map(entry => entry.name));
        last = 'not a folder';
      } else {
        last = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      }
    } catch (error) {
      last = error?.name === 'TimeoutError' ? 'timed out' : String(error?.message ?? error);
    }
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  if (notFound < attempts) return { error: last };
  const tree = await folderTreeListing(repository, folder, revision, { fetcher, token, attempts, sleep, backoffMs });
  return tree instanceof Set || tree === 'absent' ? tree : { error: `HTTP 404, and its git tree: ${tree.error}` };
}

/** One GitHub API read, asked again on any answer but a 200 (a 404 included): the body, or
 *  the last error. */
async function readApi(url, { fetcher, token, attempts, sleep, backoffMs }) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(url, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return { body: await response.json() };
      last = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    } catch (error) {
      last = error?.name === 'TimeoutError' ? 'timed out' : String(error?.message ?? error);
    }
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return { error: last };
}

/**
 * A folder's file names by the git trees API: the revision's tree, then each folder on the
 * way down by its object id. Absent only when a tree that was read has no such entry; a
 * tree never read is an error, never an absence.
 */
export async function folderTreeListing(repository, folder, revision, options) {
  const trees = `https://api.github.com/repos/arkpedia/${repository}/git/trees`;
  let tree = await readApi(`${trees}/${revision}`, options);
  for (const name of folder.split('/')) {
    if (tree.error) return tree;
    if (!Array.isArray(tree.body?.tree) || tree.body.truncated) return { error: 'the git tree was not listed whole' };
    const entry = tree.body.tree.find(item => item.path === name && item.type === 'tree');
    if (!entry) return 'absent';
    tree = await readApi(`${trees}/${entry.sha}`, options);
  }
  if (tree.error) return tree;
  if (!Array.isArray(tree.body?.tree)) return { error: 'the git tree was not listed whole' };
  return new Set(tree.body.tree.filter(item => item.type === 'blob').map(item => item.path));
}

async function listClips(packs, folderOf, { revisions, fetcher = fetch, token = process.env.GH_TOKEN, localIndex = null, sleep = pause }) {
  const listings = new Map();
  for (const pack of packs) {
    const found = folderOf(pack);
    if (!found) continue;
    const key = `${found.repository}/${found.folder}`;
    if (localIndex) {
      if (localIndex[key]) listings.set(pack.id, new Set(localIndex[key]));
      continue;
    }
    const revision = revisions[found.repository];
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error(`Missing adopted voice revision: ${found.repository}`);
    const listing = await fetchFolderListing(found.repository, found.folder, revision, { fetcher, token, sleep });
    if (listing === 'absent') throw new Error(`Voice folder ${key}: not found at ${revision}`);
    if (!(listing instanceof Set)) throw new Error(`Voice folder ${key}: ${listing.error}`);
    listings.set(pack.id, listing);
  }
  return listings;
}
