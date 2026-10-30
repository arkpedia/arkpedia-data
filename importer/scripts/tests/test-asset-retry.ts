import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';
// @ts-expect-error Plain Node helper, shared with the site.
import { ASSET_RETRY_ATTEMPTS, NEXT_ASSET_URL_SOURCE, alternateAssetUrl, fetchAsset, nextAssetUrl } from '../../lib/assets/githubRetry.mjs';
// @ts-expect-error Plain Node helper.
import { readChannelPointer } from '../../lib/content/pointer.mjs';

/*
 * GitHub's raw origin sometimes answers 404 for a published file that exists, and its CDN keeps
 * that 404 for minutes per path, query string or not; another percent-encoding of the path is
 * another cache entry, and GitHub decodes it to the same file (lib/assets/githubRetry.mjs). The
 * import reads published files the way the site does, from the same helper, so it holds the
 * same rule. The site's half of this -- the inline <head> script, the browser and React cases,
 * and the guard over the site's own scripts -- stays in arkpedia-app's test-asset-retry.ts.
 */

const ROOT = process.cwd();
const COMMIT = '1a0fb7d0ae42aebb4117be86a52caf97367b4e9f';
const ICON = `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/six-star-icons/Kal'tsit%20-%20Elite%202.webp`;

test('each alternate is the same file at a different address', () => {
  const samples = [
    ICON,
    `${ICON}?v=3`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/branch-icons/%CE%B1-Fate.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-data/${COMMIT}/release/public/planner-data/Kal%2527tsit.json`,
    'https://raw.githubusercontent.com/arkpedia/arkpedia-data/live/current.json',
    `https://raw.githubusercontent.com/arkpedia/arkpedia-voice-japanese/${COMMIT}/char_002_amiya/CN_001.mp3`,
  ];
  for (const url of samples) {
    const [, query = ''] = url.split('?');
    const head = url.slice(0, url.split('?')[0].lastIndexOf('/') + 1);
    const seen = new Set([url]);
    for (let attempt = 1; attempt <= ASSET_RETRY_ATTEMPTS; attempt++) {
      const alternate = alternateAssetUrl(url, attempt);
      assert.ok(alternate, `${url} has an attempt ${attempt}`);
      assert.equal(decodeURIComponent(alternate.split('?')[0]), decodeURIComponent(url.split('?')[0]), alternate);
      assert.equal(new URL(alternate).host, 'raw.githubusercontent.com');
      // The host, the repository, the commit and the folders are never touched; nor is the query.
      assert.ok(alternate.startsWith(head), alternate);
      assert.equal(alternate.split('?')[1] ?? '', query);
      // WHATWG parsing keeps the escape (the browser sends it as written).
      assert.equal(new URL(alternate).href, alternate);
      assert.ok(!seen.has(alternate), `attempt ${attempt} of ${url} repeats an address`);
      seen.add(alternate);
      // One step from the last try is the next try: the URL itself says how far it has got.
      assert.equal(nextAssetUrl(attempt === 1 ? url : alternateAssetUrl(url, attempt - 1)!), alternate);
    }
    assert.equal(alternateAssetUrl(url, ASSET_RETRY_ATTEMPTS + 1), null);
    assert.equal(nextAssetUrl(alternateAssetUrl(url, ASSET_RETRY_ATTEMPTS)!), null, 'tries stop');
  }
  assert.equal(alternateAssetUrl(ICON, 1), `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/six-star-icons/%4Bal'tsit%20-%20Elite%202.webp`);
  assert.equal(alternateAssetUrl(ICON, 2), `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/six-star-icons/%4B%61l'tsit%20-%20Elite%202.webp`);
  // Existing escapes stay as they are: their hex letters are not counted or encoded.
  assert.equal(alternateAssetUrl(`https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/%CE%B1b.webp`, 1),
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/%CE%B1%62.webp`);
  assert.equal(alternateAssetUrl(ICON, 0), null);
});

test('only files in the arkpedia repositories on raw.githubusercontent.com are retried', () => {
  for (const url of [
    'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/404cf368572a4f346f66614612c40fd7779012b5/assets/a.png',
    'https://raw.githubusercontent.com/arkpedia/arkpedia-data/live',
    'https://example.com/arkpedia/arkpedia-image-assets/abc/a.webp',
    '/six-star-icons/Amiya.webp',
    '/api/gacha-operator/Amiya',
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/1.2`,
    '',
  ]) assert.equal(nextAssetUrl(url), null, url);
});

test('the Python scripts run the same rule (scripts/palettes/github_retry.py)', (t) => {
  const seeds = [
    ICON, `${ICON}?v=3`, `${ICON}#top`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/branch-icons/%CE%B1-Fate.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/%4bal%25tsit.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/100%.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-skin-assets/${COMMIT}/five-star-skins/Kal%27tsit%20-%20Base.webp`,
    'https://raw.githubusercontent.com/arkpedia/arkpedia-data/live/current.json',
    'https://raw.githubusercontent.com/arkpedia/arkpedia-data/live',
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/1.2`,
    'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/main/a.png',
    '/six-star-icons/Amiya.webp',
  ];
  // Every seed and every encoding it leads to.
  const corpus = seeds.flatMap((seed) => {
    const chain = [seed];
    for (let next = nextAssetUrl(seed); next; next = nextAssetUrl(next)) chain.push(next);
    return chain;
  });
  const program = "import json, sys\nsys.path.insert(0, 'scripts/palettes')\nfrom github_retry import next_asset_url\nprint(json.dumps([next_asset_url(url) for url in json.loads(sys.argv[1])]))";
  let out: string;
  try {
    out = execFileSync('python3', ['-I', '-c', program, JSON.stringify(corpus)], { cwd: ROOT, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('no python3 here'); return; }
    throw error;
  }
  assert.deepEqual(JSON.parse(out), corpus.map((url) => nextAssetUrl(url)));
  assert.ok(corpus.length > seeds.length + 20, 'not vacuous: the chains were walked');
});

/*
 * nextAssetUrl used to be compiled from NEXT_ASSET_URL_SOURCE with `new Function`, which a
 * Workers isolate refuses; it is written out instead (lib/assets/githubRetry.mjs). This is the
 * check that keeps the two from drifting now that the compilation is gone: the inline script's
 * own text, compiled, must answer exactly as the function does on every address a chain reaches.
 */
test('the written-out rule agrees with the inline script source on every address', () => {
  const COMMIT = 'a'.repeat(40);
  const reference = new vm.Script(`(${NEXT_ASSET_URL_SOURCE})`).runInNewContext() as (url: string) => string | null;
  const seeds = [
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/event-poster/Ato%20Rerun.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/Kal'tsit%20-%20Base.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/%4bal%25tsit.webp`,
    `https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/${COMMIT}/x/%E6%98%8E%E6%97%A5.webp?x=1#y`,
    'https://raw.githubusercontent.com/arkpedia/arkpedia-data/live/current.json',
    'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/main/a.png',
    '/six-star-icons/Amiya.webp',
  ];
  const corpus = seeds.flatMap((seed) => {
    const chain = [seed];
    for (let next = nextAssetUrl(seed); next; next = nextAssetUrl(next)) chain.push(next);
    return chain;
  });
  assert.ok(corpus.length > seeds.length + 8, 'not vacuous: the chains were walked');
  for (const url of corpus) assert.equal(nextAssetUrl(url), reference(url), url);
});

test('fetchAsset asks again at the next encoding after a 404 or a failed request, and stops after the attempts', async () => {
  const original = globalThis.fetch;
  try {
    const asked: string[] = [];
    let answers: (number | 'network')[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const answer = answers.shift() ?? 200;
      if (answer === 'network') throw new TypeError('Failed to fetch');
      return new Response(answer === 404 ? '404: Not Found' : 'ok', { status: answer });
    }) as typeof fetch;

    answers = [404, 'network'];
    const response = await fetchAsset(ICON);
    assert.equal(response.status, 200);
    assert.deepEqual(asked, [ICON, alternateAssetUrl(ICON, 1), alternateAssetUrl(ICON, 2)]);

    asked.length = 0; answers = [404, 404, 404, 404, 404];
    assert.equal((await fetchAsset(ICON)).status, 404, 'a file really missing is reported as before');
    assert.equal(asked.length, ASSET_RETRY_ATTEMPTS + 1);

    // A 404, then requests that fail outright: still a 404, so a caller's fallback on a missing
    // file (a channel's pointer, lib/content/pointer.mjs) runs, as it would without retries.
    asked.length = 0; answers = [404, 'network', 'network', 'network'];
    const confirmed = await fetchAsset(ICON);
    assert.equal(confirmed.status, 404);
    assert.equal(asked.length, ASSET_RETRY_ATTEMPTS + 1);
    asked.length = 0; answers = ['network', 404, 'network', 'network'];
    assert.equal((await fetchAsset(ICON)).status, 404);
    asked.length = 0; answers = ['network', 'network', 'network', 'network'];
    await assert.rejects(fetchAsset(ICON), /Failed to fetch/, 'with no answer at all, the failure itself');

    asked.length = 0; answers = [404];
    assert.equal((await fetchAsset('/medal-catalogue.json')).status, 404);
    assert.equal(asked.length, 1, 'any other address is fetched once');

    asked.length = 0; answers = [500];
    assert.equal((await fetchAsset(ICON)).status, 500, 'only a 404 is retried');
    assert.equal(asked.length, 1);

    asked.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => { asked.push(String(input)); throw new DOMException('The operation timed out.', 'TimeoutError'); }) as typeof fetch;
    await assert.rejects(fetchAsset(ICON), /timed out/);
    assert.equal(asked.length, 1, 'a timeout is not retried: one signal bounds every try');
  } finally {
    globalThis.fetch = original;
  }
});


test("a channel with no pointer still falls back to live's when a retry of its 404 fails outright", async () => {
  const root = 'https://raw.githubusercontent.com/arkpedia/arkpedia-data';
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    if (decodeURIComponent(url) === `${root}/live/current.json`) return new Response('{"live":true}');
    if (decodeURIComponent(url) !== `${root}/dev-live/current.json`) throw new Error(`unexpected ${url}`);
    if (asked.filter((each) => decodeURIComponent(each).includes('/dev-live/')).length === 1) return new Response('404: Not Found', { status: 404 });
    throw new TypeError('fetch failed');
  };
  // lib/content/release.ts's read(): the status rides on the error.
  const read = async (url: string) => {
    const response = await fetchAsset(url, {}, { fetcher });
    if (!response.ok) throw Object.assign(new Error(`Content HTTP ${response.status}: ${url}`), { status: response.status });
    return Buffer.from(await response.arrayBuffer());
  };
  const pointer = await readChannelPointer({ root, channel: 'dev-live', read });
  assert.equal(pointer.toString(), '{"live":true}');
});

