/**
 * config/asset-folders.json against what each asset repository actually publishes.
 *
 * lib/content/urls.ts and next.config.js both map a root-relative /<folder>/... path to a
 * repository by that list. A folder a repository gains that the list lacks passes through
 * unmapped -- a 404, or the deploy's own copy -- and a folder listed under the wrong
 * repository asks the wrong one. The lists used to be typed out twice, with nothing tying
 * them to each other or to the repositories.
 */

/** Paths each repository publishes that no /<folder>/ route serves directly. */
const UNROUTED = new Set(['originals', 'variants']);

/** The top-level folders a repository's asset-manifest.json lists, as the site routes them. */
export function manifestFolders(manifest) {
  return [...new Set(Object.keys(manifest?.files ?? {}).filter(file => file.includes('/')).map(file => file.split('/')[0]))]
    .filter(folder => !UNROUTED.has(folder)).sort();
}

/*
 * The two kinds of disagreement between the config and the manifests ({ repository: manifest }),
 * each a list of { repository, folder, problem }. `missing`, a folder the config maps that the
 * repository does not publish, breaks every page that links into it. `unmapped`, a folder the
 * repository publishes that the config does not map, links nowhere yet: no page of this code
 * asks for it. The image repositories are shared by main and dev, so a folder whose mapping
 * went to dev first is unmapped on main, and on 2026-10-02 that alone (story-map/) failed main's
 * content release two nights running. What each caller does with them is folderVerdict's.
 */
export function folderDriftByKind(config, manifests) {
  const unmapped = [], missing = [];
  for (const [repository, manifest] of Object.entries(manifests)) {
    const listed = new Set(config[repository] ?? []);
    const published = manifestFolders(manifest);
    for (const folder of published) if (!listed.has(folder)) unmapped.push({ repository, folder, problem: `${repository} publishes ${folder}/, which config/asset-folders.json does not map` });
    for (const folder of listed) if (!published.includes(folder)) missing.push({ repository, folder, problem: `config/asset-folders.json maps ${folder}/ to ${repository}, which publishes no such folder` });
  }
  return { unmapped, missing };
}

/*
 * Who runs check-published-assets.mjs, and what an unmapped folder does to each. A missing
 * folder fails every one of them.
 *   check       Check's `npm run check:published-assets`, no flag: an unmapped folder fails too,
 *               so a PR that bumps the pins past a folder this code does not map says so.
 *   quarantine  the release job's Validate step (--quarantine): held as a published-partial
 *               entry in data/quarantine.json, which test-asset-folders.ts accepts in its place.
 *   adopting    update-asset-revisions.mjs (--adopting), every stage that moves the pins
 *               (asset-revisions, catalogue-assets, staged-art) and a hand bump alike: let
 *               through. Adopting a pin needs no mapping, and the strict check there threw the
 *               day's pins away over a folder dev had mapped first -- the freeze #180 meant to
 *               lift. It writes no entry: Validate's --quarantine run, later in the same job,
 *               holds what is still unmapped then.
 */
export const FOLDER_MODES = { '': 'check', '--quarantine': 'quarantine', '--adopting': 'adopting' };

/** The mode check-published-assets.mjs's arguments ask for, or an error naming the usage. */
export function folderMode(argv) {
  const flag = argv.join(' ');
  if (!Object.hasOwn(FOLDER_MODES, flag)) throw new Error(`usage: check-published-assets.mjs [${Object.keys(FOLDER_MODES).filter(Boolean).join(' | ')}] (not ${flag})`);
  return FOLDER_MODES[flag];
}

/** What a mode does with folderDriftByKind's rows: { fail, hold, allow }, each a list of rows. */
export function folderVerdict({ unmapped, missing }, mode) {
  if (!Object.values(FOLDER_MODES).includes(mode)) throw new Error(`Unknown folder check mode: ${mode}`);
  return {
    fail: [...missing, ...(mode === 'check' ? unmapped : [])],
    hold: mode === 'quarantine' ? unmapped : [],
    allow: mode === 'adopting' ? unmapped : [],
  };
}
