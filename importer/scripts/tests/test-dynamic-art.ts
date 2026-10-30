import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { REPOSITORY, dynamicArtFromManifest, emptyDynamicArt, readDynamicArt, writeDynamicArt } from '../sync/sync-dynamic-art.mjs';

/*
 * Animated outfit art: the stage that says which artwork has a Spine model, reading the asset
 * repository's manifest at the commit it was read at (data/dynamic-art.json). How the pages
 * read those pointers, name and play a model's animations, and keep all of it off a page that
 * does not ask for it, is held by arkpedia-app's scripts/tests/test-dynamic-art.ts.
 */

const COMMIT = 'a'.repeat(40);
const HOSHIGUMA_E2 = 'models/char_1044_hsgma2_2/0123456789ab/model.json';
const FUGUE = 'models/char_113_cqbw_epoque_7/ba9876543210/model.json';
const raw = (file: string, commit = COMMIT) => `https://raw.githubusercontent.com/arkpedia/arkpedia-l2d-assets/${commit}/${file}`;

test('the stage turns the manifest into pointers pinned to the commit it was read at', () => {
  const { data, skipped } = dynamicArtFromManifest({
    schemaVersion: 1, server: 'en', resVersion: '25-09-30-12-00-00-abcdef',
    models: { 'char_113_cqbw@epoque#7': FUGUE, 'char_1044_hsgma2#2': HOSHIGUMA_E2 },
  }, COMMIT);
  assert.deepEqual(skipped, []);
  assert.deepEqual(data, {
    schemaVersion: 1, repository: 'arkpedia/arkpedia-l2d-assets', commit: COMMIT,
    models: { 'char_1044_hsgma2#2': raw(HOSHIGUMA_E2), 'char_113_cqbw@epoque#7': raw(FUGUE) },
  });
});

test('a broken manifest entry is skipped, a manifest that is not one fails the stage', () => {
  const { data, skipped } = dynamicArtFromManifest({
    schemaVersion: 1,
    models: {
      'char_1044_hsgma2#2': HOSHIGUMA_E2,
      'not a skin': HOSHIGUMA_E2,
      'char_002_amiya#1': '../../etc/passwd',
      'char_003_kalts#1': 'models/char_003_kalts_1/0123456789ab/skeleton.skel',
      'char_010_chen#2': null,
    },
  }, COMMIT);
  assert.deepEqual(Object.keys(data.models), ['char_1044_hsgma2#2']);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.some((line: string) => line.startsWith('not a skin: not a skin id')));
  assert.throws(() => dynamicArtFromManifest({ schemaVersion: 2, models: {} }, COMMIT), /schemaVersion/);
  assert.throws(() => dynamicArtFromManifest({ schemaVersion: 1 }, COMMIT), /no models/);
  assert.throws(() => dynamicArtFromManifest([], COMMIT), /not an object/);
  assert.throws(() => dynamicArtFromManifest({ schemaVersion: 1, models: {} }, 'main'), /Not a commit/);
});

/** A stand-in for GitHub: the API's answer for the branch head, then the raw host's, at any
 *  encoding of the manifest's address (a raw 404 is asked again at the others,
 *  lib/assets/githubRetry.mjs). `manifest.statuses` answers the manifest's requests in turn. */
function github(head: { status: number; sha?: string }, manifest: { status: number; body?: string; statuses?: number[] }) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    if (url === `https://api.github.com/repos/${REPOSITORY}/commits/main`) {
      return new Response(head.sha ? JSON.stringify({ sha: head.sha }) : '{}', { status: head.status });
    }
    if (decodeURIComponent(url) === raw('manifest.json', head.sha)) {
      const status = manifest.statuses?.shift() ?? manifest.status;
      return new Response(status === 200 ? manifest.body ?? '' : '404: Not Found', { status });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetch, asked };
}

test('the stage reads the manifest at main\'s commit, and a repository with none yet has no models', async () => {
  const live = github({ status: 200, sha: COMMIT }, { status: 200, body: JSON.stringify({ schemaVersion: 1, models: { 'char_1044_hsgma2#2': HOSHIGUMA_E2 } }) });
  const read = await readDynamicArt({ fetch: live.fetch });
  assert.deepEqual(read.data.models, { 'char_1044_hsgma2#2': raw(HOSHIGUMA_E2) });
  // GET only: the commit from the API, then the manifest at that commit, nothing at the moving branch.
  assert.deepEqual(live.asked, [`https://api.github.com/repos/${REPOSITORY}/commits/main`, raw('manifest.json')]);

  // GitHub's false 404 (two in a row here) is not "no manifest": the other encodings of its
  // address are asked, and the one that answers is read.
  const falseNotFound = github({ status: 200, sha: COMMIT }, { status: 200, statuses: [404, 404], body: JSON.stringify({ schemaVersion: 1, models: { 'char_1044_hsgma2#2': HOSHIGUMA_E2 } }) });
  assert.deepEqual((await readDynamicArt({ fetch: falseNotFound.fetch })).data.models, { 'char_1044_hsgma2#2': raw(HOSHIGUMA_E2) });
  assert.equal(falseNotFound.asked.length, 4);

  // While the asset PR is open, main has no manifest.json (404 at every address): no models,
  // and the stage succeeds.
  const missing = github({ status: 200, sha: COMMIT }, { status: 404 });
  const noManifest = await readDynamicArt({ fetch: missing.fetch });
  assert.equal(missing.asked.length, 5, 'the head, then the manifest at its own address and three others');
  assert.deepEqual(noManifest.data, { schemaVersion: 1, repository: 'arkpedia/arkpedia-l2d-assets', commit: null, models: {} });
  assert.deepEqual(noManifest.data, emptyDynamicArt());
  // A repository with no commit at all (GitHub answers 409).
  assert.deepEqual((await readDynamicArt({ fetch: github({ status: 409 }, { status: 404 }).fetch })).data, emptyDynamicArt());

  // Anything else fails the stage, which then keeps yesterday's file.
  await assert.rejects(readDynamicArt({ fetch: github({ status: 503 }, { status: 404 }).fetch }), /HTTP 503/);
  await assert.rejects(readDynamicArt({ fetch: github({ status: 200, sha: 'main' }, { status: 404 }).fetch }), /names no commit/);
  await assert.rejects(readDynamicArt({ fetch: github({ status: 200, sha: COMMIT }, { status: 500 }).fetch }), /HTTP 500/);
  await assert.rejects(readDynamicArt({ fetch: github({ status: 200, sha: COMMIT }, { status: 200, body: '<html>' }).fetch }), /not JSON/);
});

test('the stage writes the data file only when it changed, and is a stage of the daily refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-dynamic-art-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    assert.equal(writeDynamicArt(root, emptyDynamicArt()), true);
    assert.equal(writeDynamicArt(root, emptyDynamicArt()), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/dynamic-art.json'), 'utf8')), emptyDynamicArt());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.match(fs.readFileSync('scripts/sync/refresh-stage-data.sh', 'utf8'), /^stage dynamic-art -- node scripts\/sync\/sync-dynamic-art\.mjs$/m);
});
