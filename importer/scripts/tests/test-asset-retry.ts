import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import {
  ASSET_RETRY_ATTEMPTS, NEXT_ASSET_URL_SOURCE, alternateAssetUrl, assetAudioUrl, assetRetryScript, fetchAsset, nextAssetUrl, retryAssetAudioOnNextPress,
} from '../../lib/assets/assetRetry';
import { readChannelPointer } from '../../lib/content/pointer.mjs';

/*
 * GitHub's raw origin sometimes answers 404 for a published file that exists, and its CDN keeps
 * that 404 for minutes per path, query string or not; another percent-encoding of the path is
 * another cache entry, and GitHub decodes it to the same file (lib/assets/assetRetry.ts). These
 * hold the rule to that, the <head> script to retrying every <img> with it, and every fetch()
 * of a published file to the shared helper.
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

test('the rule runs as written in every browser: ES5, from one source', () => {
  for (const source of [NEXT_ASSET_URL_SOURCE, assetRetryScript()]) {
    assert.doesNotMatch(source, /=>|\b(?:let|const|class)\s|`|\?\.|\?\?/, 'ES5 only');
  }
  assert.ok(assetRetryScript().includes(NEXT_ASSET_URL_SOURCE.replace(/^\s+/gm, '')), 'the <head> script runs the same rule');
  // It parses as a script on its own.
  new vm.Script(assetRetryScript());
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

class FakeElement {
  nodeName: string;
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  private attributes = new Map<string, string>();
  constructor(nodeName: string, attributes: Record<string, string> = {}) {
    this.nodeName = nodeName;
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  append(child: FakeElement) { child.parentNode = this; this.children.push(child); return child; }
}
class FakeImage extends FakeElement {
  complete = true;
  naturalWidth = 0;
  currentSrc = '';
  constructor(attributes: Record<string, string>) { super('IMG', attributes); }
  get src() { return this.getAttribute('src') ?? ''; }
  set src(value: string) { this.setAttribute('src', value); }
}

/** The <head> script, run against a document of `images`; `fail` dispatches an image's
 *  error event and says whether it reached the listeners after the script's. */
function page(images: FakeImage[]) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const document = { images, documentElement: new FakeElement('HTML'), addEventListener(type: string, listener: (event: unknown) => void) { (listeners[type] ??= []).push(listener); } };
  let observed: ((records: unknown[]) => void) | null = null;
  class MutationObserver {
    constructor(callback: (records: unknown[]) => void) { observed = callback; }
    observe(target: unknown, options: { childList?: boolean; subtree?: boolean }) { assert.equal(target, document.documentElement); assert.ok(options.childList && options.subtree); }
  }
  const context: Record<string, unknown> = { document, WeakSet, MutationObserver };
  context.window = context;
  vm.runInNewContext(assetRetryScript(), context);
  return {
    /** Put `node` in the page, as React does once it has built it. */
    insert(node: FakeElement & { nodeType?: number; getElementsByTagName?: (name: string) => FakeElement[] }) {
      node.nodeType = 1;
      node.getElementsByTagName = () => node.children.filter((child) => child.nodeName === 'IMG');
      observed!([{ addedNodes: [node] }]);
    },
    fail(img: FakeImage): boolean {
      let stopped = false;
      const event = { target: img, stopImmediatePropagation() { stopped = true; } };
      for (const listener of listeners.error ?? []) { listener(event); if (stopped) return false; }
      return true;
    },
    loaded() { for (const listener of listeners.DOMContentLoaded ?? []) listener({}); },
  };
}

test('the <head> script points a failed <img> at the next encoding, and lets the last failure through', () => {
  const img = new FakeImage({ src: ICON });
  const { fail } = page([]);
  const tried = [ICON];
  for (let attempt = 1; attempt <= ASSET_RETRY_ATTEMPTS; attempt++) {
    img.currentSrc = img.src;
    assert.equal(fail(img), false, `attempt ${attempt} is pending: the component's onError must not see it`);
    assert.equal(img.src, alternateAssetUrl(ICON, attempt));
    tried.push(img.src);
  }
  img.currentSrc = img.src;
  assert.equal(fail(img), true, 'the last failure reaches the component');
  assert.equal(img.src, tried.at(-1));
  assert.equal(new Set(tried).size, ASSET_RETRY_ATTEMPTS + 1);

  // An earlier address's failure arriving while the retry loads is not the last.
  const pending = new FakeImage({ src: ICON });
  pending.currentSrc = ICON;
  fail(pending);
  pending.complete = false;
  assert.equal(fail(pending), false);
  assert.equal(pending.src, alternateAssetUrl(ICON, 1), 'and starts no second retry');

  const elsewhere = new FakeImage({ src: 'https://i.ytimg.com/vi/x/hqdefault.jpg' });
  elsewhere.currentSrc = elsewhere.src;
  assert.equal(fail(elsewhere), true);
  assert.equal(elsewhere.src, 'https://i.ytimg.com/vi/x/hqdefault.jpg');
});

test('inside a <picture>, every candidate moves on, whichever the browser tried', () => {
  const avif = (w: number) => ICON.replace('six-star-icons', `variants/avif/${w}`).replace('.webp', '.avif');
  const picture = new FakeElement('PICTURE');
  const source = picture.append(new FakeElement('SOURCE', { srcset: `${avif(320)} 320w, ${avif(640)} 640w` }));
  const img = picture.append(new FakeImage({ src: ICON })) as FakeImage;
  img.currentSrc = avif(640);
  const { fail } = page([]);
  assert.equal(fail(img), false);
  assert.equal(source.getAttribute('srcset'), `${alternateAssetUrl(avif(320), 1)} 320w, ${alternateAssetUrl(avif(640), 1)} 640w`);
  assert.equal(img.src, alternateAssetUrl(ICON, 1));
});

test('images already broken when it starts, or by DOMContentLoaded, are retried too', () => {
  const early = new FakeImage({ src: ICON });
  const svg = new FakeImage({ src: ICON.replace('.webp', '.svg') });
  const fine = new FakeImage({ src: ICON });
  fine.naturalWidth = 180;
  const images = [early, svg, fine];
  const { loaded } = page(images);
  assert.equal(early.src, alternateAssetUrl(ICON, 1));
  assert.equal(svg.src, ICON.replace('.webp', '.svg'), 'an SVG may have no intrinsic size');
  assert.equal(fine.src, ICON);
  const late = new FakeImage({ src: ICON });
  images.push(late);
  loaded();
  assert.equal(late.src, alternateAssetUrl(ICON, 1));
});

test('an image that failed before React put it in the page is retried when it is put in', () => {
  const { insert } = page([]);
  const card = new FakeElement('DIV');
  const icon = card.append(new FakeImage({ src: ICON })) as FakeImage;
  const loading = card.append(new FakeImage({ src: ICON })) as FakeImage;
  loading.complete = false;
  insert(card);
  assert.equal(icon.src, alternateAssetUrl(ICON, 1));
  assert.equal(loading.src, ICON, 'one still loading is left to its error event');
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

test('a clip that failed to load is asked for at the next encoding on the next press, never from an await', () => {
  const clip = `https://raw.githubusercontent.com/arkpedia/arkpedia-voice-japanese/${COMMIT}/char_002_amiya/CN_001.mp3`;
  assert.equal(assetAudioUrl(clip), clip, 'a first press plays the clip from its own address');
  const tried = [clip];
  for (let attempt = 1; attempt <= ASSET_RETRY_ATTEMPTS; attempt++) {
    assert.equal(retryAssetAudioOnNextPress(clip, tried.at(-1)!), true, `press ${attempt + 1} has another encoding to try`);
    assert.equal(assetAudioUrl(clip), alternateAssetUrl(clip, attempt));
    tried.push(assetAudioUrl(clip));
  }
  assert.equal(retryAssetAudioOnNextPress(clip, tried.at(-1)!), false, 'after the last encoding the failure is the last');
  assert.equal(assetAudioUrl(clip), clip, 'and a later press starts again from its own address');
  // The helpers set no address and call no play(): the press does, inside itself.
  const source = fs.readFileSync(path.join(ROOT, 'lib/assets/assetRetry.ts'), 'utf8');
  assert.doesNotMatch(source, /\.play\(/);
  for (const file of ['components/operators/OperatorVoiceLines.tsx', 'components/skins/DynamicArtwork.tsx']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(text, /assetAudioUrl\(/, `${file} plays a clip from assetAudioUrl`);
    assert.match(text, /retryAssetAudioOnNextPress\(/, `${file} leaves the next encoding for the next press`);
  }
});

test('the retry script is in <head>, ahead of every image', () => {
  const document = fs.readFileSync(path.join(ROOT, 'pages/_document.tsx'), 'utf8');
  const head = document.slice(document.indexOf('<Head>'), document.indexOf('</Head>'));
  assert.match(head, /<script dangerouslySetInnerHTML=\{\{ __html: assetRetryScript\(\) \}\} \/>/);
  // No Content-Security-Policy that would block an inline script (next.config.js, vercel.json).
  for (const file of ['next.config.js', 'vercel.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /key:\s*['"]Content-Security-Policy['"]|"Content-Security-Policy"/i, `${file}: a CSP must allow the inline retry script (hash it)`);
  }
});

/*
 * Every fetch() in the app, and every picture or sound made outside the page, is one of: the
 * shared helpers (fetchAsset, loadAssetImage, assetAudioUrl), an /api route of the site's own,
 * a third-party address, or a call listed here with what it fetches. A new fetch of a published
 * file fails here until it uses fetchAsset.
 */
const NOT_PUBLISHED_FILES: Record<string, string> = {
  'lib/music/youtube.ts: url': 'the YouTube Data API',
  'lib/music-guesser/prepareClip.ts: url': "Monster Siren's own audio CDN (/api/music-guesser)",
  'lib/account-import/relay.ts: url: string': "the account-import transport's type (Yostar's servers)",
  'lib/account-import/relay.ts: url': "Yostar's servers, for the account import",
  'pages/api/music-art/[id].ts: url': "Monster Siren's song API",
  'pages/api/music-cover/[id].ts: url': "Monster Siren's song API",
  'pages/api/music-cover/[id].ts: art.cover': "Monster Siren's cover CDN",
  'lib/content/shippedTable.ts: request: Request': "the Worker's ASSETS binding's type: its own static files, read in the same isolate",
};
/** Pictures and sounds made outside the page: how many each file makes, and why they need no retry. */
const DETACHED_MEDIA: Record<string, { count: number; why: string }> = {
  'components/operators/RoamingChibiProvider.tsx: new Image': { count: 1, why: 'furniture from the ArknightsAssets mirror, not an arkpedia repository' },
  'components/skins/DynamicArtwork.tsx: new Audio': { count: 2, why: 'retried with retryAssetMedia (the entrance) and on the next press (voices, assetAudioUrl)' },
  'lib/music-guesser/useSongClip.ts: new Audio': { count: 1, why: "Monster Siren's own audio CDN" },
  "lib/music/audioElement.ts: createElement('audio')": { count: 1, why: "the music player's element, which plays Monster Siren's own files" },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) { if (relative !== 'lib/vendor') out.push(...sourceFiles(relative)); }
    else if (/\.(?:tsx?|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(relative);
  }
  return out;
}

function literalPrefix(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

test('every fetch of a published file goes through fetchAsset', () => {
  const failures: string[] = [];
  const used = new Set<string>();
  const detached = new Map<string, number>();
  for (const file of ['lib', 'components', 'pages'].flatMap(sourceFiles)) {
    if (file === 'lib/assets/assetRetry.ts' || file === 'lib/assets/githubRetry.mjs') continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!/\bfetch\s*\(|new (?:window\.)?(?:Image|Audio)\s*\(|createElement\(/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        const made = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ['window', 'globalThis', 'self'].includes(node.expression.expression.text) ? node.expression.name.text : '';
        if (made === 'Image' || made === 'Audio') {
          const key = `${file}: new ${made}`;
          detached.set(key, (detached.get(key) ?? 0) + 1);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement'
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && ['img', 'audio', 'video'].includes(node.arguments[0].text)) {
        const key = `${file}: createElement('${node.arguments[0].text}')`;
        detached.set(key, (detached.get(key) ?? 0) + 1);
      }
      const callee = ts.isCallExpression(node) || ts.isMethodSignature(node) ? (ts.isCallExpression(node) ? node.expression : node.name) : null;
      const isFetch = callee && (ts.isIdentifier(callee) ? callee.text === 'fetch'
        : ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch' && ts.isIdentifier(callee.expression) && ['window', 'globalThis', 'self'].includes(callee.expression.text));
      if (isFetch) {
        const first = ts.isCallExpression(node) ? node.arguments[0] : (node as ts.MethodSignature).parameters[0];
        const argument = first ? first.getText(source).replace(/\s+/g, ' ') : '';
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const prefix = first ? literalPrefix(first) : null;
        if (/contentUrl|assetUrl|pinAssetUrl|raw\.githubusercontent|baseUrl|\.skeleton\b|\.atlas\b/.test(argument)) {
          failures.push(`${where} fetches a published file without fetchAsset: fetch(${argument})`);
        } else if (prefix !== null && (prefix.startsWith('/api/') || (/^https:\/\//.test(prefix) && !prefix.startsWith('https://raw.githubusercontent.com/')))) {
          // The site's own API, or a third party: not a published file.
        } else if (NOT_PUBLISHED_FILES[`${file}: ${argument}`]) {
          used.add(`${file}: ${argument}`);
        } else {
          failures.push(`${where}: fetch(${argument}) -- use fetchAsset (lib/assets/assetRetry.ts) for a published file, or list it in NOT_PUBLISHED_FILES with what it fetches`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [key, count] of detached) {
    const known = DETACHED_MEDIA[key];
    if (!known) failures.push(`${key}: load a published picture with loadAssetImage, a sound with assetAudioUrl/retryAssetMedia, or list it in DETACHED_MEDIA`);
    else if (known.count !== count) failures.push(`${key}: ${count} found, DETACHED_MEDIA expects ${known.count}; check the new one is retried`);
  }
  for (const key of Object.keys(DETACHED_MEDIA)) if (!detached.has(key)) failures.push(`${key} is gone: remove it from DETACHED_MEDIA`);
  for (const key of Object.keys(NOT_PUBLISHED_FILES)) if (!used.has(key)) failures.push(`${key} is gone: remove it from NOT_PUBLISHED_FILES`);
  assert.deepEqual(failures, []);
});

test('the content release is read through fetchAsset on the server too', () => {
  const server = fs.readFileSync(path.join(ROOT, 'lib/content/release.ts'), 'utf8');
  assert.match(server, /await fetchAsset\(url, \{ signal: AbortSignal\.timeout\(10_000\), cache: 'no-store' \}\)/);
});

/*
 * The CI and release scripts read the same files, and a false 404 there is worse than a broken
 * picture: check-voice-clips failed main's Check on 140 clips it then found, and with
 * --quarantine the release would have held back clips and art that were there all along.
 *
 * Deny by default. In each script that reads published files (RAW_READERS) every bare
 * fetch()/fetcher() is a failure unless listed here with what it asks for, and fetchAsset must
 * be called (an import alone proves nothing). In every other script, a fetch of an address
 * built from a raw arkpedia literal -- written in the call or held in a variable of the same
 * file, however many assignments away -- is a failure.
 */
type Allowed = { call: RegExp; why: string };
const RAW_READERS: Record<string, Allowed[]> = {
  'scripts/audits/check-published-assets.mjs': [],
  'scripts/audits/check-voice-clips.mjs': [],
  'scripts/build/adopt-release-asset-pins.mjs': [
    { call: /^fetch\(`https:\/\/api\.github\.com\/repos\/arkpedia\/\$\{repository\}\/compare\//, why: "GitHub's compare API (githubCompare), not a published file" },
  ],
  'scripts/deploy/check-asset-redirects.mjs': [
    { call: /^fetch\(url, \{ method: 'HEAD', redirect: 'manual'/, why: "the site's own address, whose redirect is read by hand before its target is asked through fetchAsset" },
  ],
  'scripts/sync/sync-chibi-art.mjs': [
    { call: /^fetcher\(`https:\/\/api\.github\.com\/repos\/\$\{REPOSITORY\}\/commits\/main`/, why: "the API's commit lookup, not a published file" },
  ],
  'scripts/sync/sync-dynamic-art.mjs': [],
  'scripts/sync/update-asset-revisions.mjs': [],
};
const RAW_LITERAL = /raw\.githubusercontent\.com\/(?:arkpedia\/|\$\{REPOSITORY\})/;

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ['globalThis', 'window', 'self'].includes(callee.expression.text)) return callee.name.text;
  return '';
}

/** What the scripts guard finds wrong in `sources` (path to text). */
function scriptGuardFailures(sources: Record<string, string>): string[] {
  const failures: string[] = [];
  const used = new Set<RegExp>();
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const calls: ts.CallExpression[] = [];
    // Names assigned an address built from a raw arkpedia literal, directly or through another such name.
    const declarations: { name: string; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push({ name: node.name.text, text: node.initializer.getText(source) });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) declarations.push({ name: node.left.text, text: node.right.getText(source) });
      ts.forEachChild(node, visit);
    };
    visit(source);
    const tainted = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const { name, text: value } of declarations) {
        if (tainted.has(name)) continue;
        if (RAW_LITERAL.test(value) || [...tainted].some((other) => new RegExp(`\\b${other}\\b`).test(value))) { tainted.add(name); grew = true; }
      }
    }
    const allowed = RAW_READERS[file];
    let confirmed = false;
    for (const call of calls) {
      const name = calleeName(call);
      if (name === 'fetchAsset') { confirmed = true; continue; }
      if (name !== 'fetch' && name !== 'fetcher') continue;
      const text = call.getText(source).replace(/\s+/g, ' ');
      const argument = call.arguments[0]?.getText(source).replace(/\s+/g, ' ') ?? '';
      if (allowed) {
        const entry = allowed.find(({ call: pattern }) => pattern.test(text));
        if (entry) used.add(entry.call);
        else failures.push(`${where(call)}: ${text.slice(0, 120)} -- this script reads published files: ask through fetchAsset (lib/assets/githubRetry.mjs), or list the call in RAW_READERS with what it asks for`);
      } else if (RAW_LITERAL.test(argument) || [...tainted].some((other) => new RegExp(`\\b${other}\\b`).test(argument))) {
        failures.push(`${where(call)}: ${name}(${argument}) -- a raw arkpedia address: a 404 counts only once confirmed, so ask through fetchAsset (lib/assets/githubRetry.mjs) and add the file to RAW_READERS`);
      }
    }
    if (allowed && !confirmed) failures.push(`${file} never calls fetchAsset`);
  }
  for (const [file, entries] of Object.entries(RAW_READERS)) {
    if (!(file in sources)) { failures.push(`${file} is gone: remove it from RAW_READERS`); continue; }
    for (const entry of entries) if (!used.has(entry.call)) failures.push(`${file}: no call matches ${entry.call} any more: remove it from RAW_READERS`);
  }
  return failures;
}

function scriptSources(): Record<string, string> {
  const files = sourceFiles('scripts').filter((file) => !file.startsWith('scripts/tests/') && !file.startsWith('scripts/palettes/palette-review/'));
  return Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
}

test('the scripts that read published files confirm a 404 through fetchAsset', () => {
  assert.deepEqual(scriptGuardFailures(scriptSources()), []);
});

test('the scripts guard fails each way a script can go around fetchAsset', () => {
  const sources = scriptSources();
  const reverted = (file: string, from: RegExp, to: string) => {
    assert.match(sources[file], from, `${file} still has the call this case reverts`);
    return scriptGuardFailures({ ...sources, [file]: sources[file].replace(from, to) });
  };
  // adopt-release-asset-pins' get() back on plain fetch: the pointer's 404 decides live's fallback.
  const pins = reverted('scripts/build/adopt-release-asset-pins.mjs', /fetchAsset\(url, (\{ cache: 'no-store', signal: AbortSignal\.timeout\(20_000\) \}), \{ fetcher: fetch \}\)/, 'fetch(url, $1)');
  assert.ok(pins.some((line) => /adopt-release-asset-pins\.mjs:\d+: fetch\(url/.test(line)), pins.join('\n'));
  // check-asset-redirects' probe() asking the redirect's target with plain fetch.
  const probe = reverted('scripts/deploy/check-asset-redirects.mjs', /fetchAsset\(target, (\{[^}]*\}), \{ fetcher: fetch \}\)/, 'fetch(target, $1)');
  assert.ok(probe.some((line) => /check-asset-redirects\.mjs:\d+: fetch\(target/.test(line)), probe.join('\n'));
  // A new script holding a raw address in a variable.
  const added = scriptGuardFailures({ ...sources, 'scripts/sync/sync-new-art.mjs': "const base = 'https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets';\nconst manifest = `${base}/${process.argv[2]}/asset-manifest.json`;\nconst response = await fetch(manifest);\n" });
  assert.ok(added.some((line) => /sync-new-art\.mjs:3: fetch\(manifest\)/.test(line)), added.join('\n'));
  // And a reader that only imports fetchAsset.
  const imported = scriptGuardFailures({ ...sources, 'scripts/sync/update-asset-revisions.mjs': sources['scripts/sync/update-asset-revisions.mjs'].replaceAll('await fetchAsset(', 'await fetch(') });
  assert.ok(imported.includes('scripts/sync/update-asset-revisions.mjs never calls fetchAsset'), imported.join('\n'));
});

test('CSS art built in code looks at a false 404 once it is shown (useAssetUrl)', () => {
  const failures: string[] = [];
  for (const file of ['components', 'pages', 'lib'].flatMap(sourceFiles)) {
    if (file === 'lib/content/urls.ts' || file === 'lib/assets/assetRetry.ts') continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // A url() straight from the release's address, with no look at whether GitHub refused it.
    for (const match of text.matchAll(/cssUrl\((?:contentUrl|url)\(/g)) {
      failures.push(`${file}:${text.slice(0, match.index).split('\n').length}: cssUrl of an address useAssetUrl has not looked at`);
    }
    if (/url\(\\?"\$\{/.test(text) && !/useAssetUrl\(/.test(text)) failures.push(`${file}: builds a CSS url() without useAssetUrl`);
  }
  assert.deepEqual(failures, []);
});
