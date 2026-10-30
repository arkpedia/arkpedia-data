import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { CLIENT_VERSIONS, manifestChanges, manifestDigest, MIRROR_VERSION, mirrorResVersion, watchClientVersions } from '../sync/watch-client-versions.mjs';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { pinVariable } from '../content/pin-upstream.mjs';

const CONFIGS: Record<string, string> = {
  en: 'https://ak-conf.arknights.global/config/prod/official/network_config',
  jp: 'https://ak-conf.arknights.jp/config/prod/official/network_config',
  kr: 'https://ak-conf.arknights.kr/config/prod/official/network_config',
  cn: 'https://ak-conf.hypergryph.com/config/prod/official/network_config',
};
const config = (host: string) => ({ content: JSON.stringify({ funcVer: 'V1', configs: { V1: { network: {
  hv: `https://${host}/assetbundle/official/{0}/version`, hu: `https://${host}/assetbundle/official`, prean: `https://webview.${host}` } } } }) });
const PIN = 'a'.repeat(40), CN_PIN = 'b'.repeat(40);
const ENV = { [pinVariable('ArknightsAssets/ArknightsGamedata')]: PIN, [pinVariable('yuanyan3060/ArknightsGameResource')]: CN_PIN };
const mirrorUrl = (region: string) => {
  const { repository, file } = (MIRROR_VERSION as any)[region];
  return `https://raw.githubusercontent.com/${repository}/${region === 'cn' ? CN_PIN : PIN}/${file}`;
};
const list = (resVersion: string, names: string[]) => ({ versionId: resVersion, abInfos: names.map(name => ({ name, md5: `md5-${name}` })) });

/** Each region on `versions[region]`, its file list `lists[resVersion]`, and its mirror on `mirrors[region]`. */
function server({ versions, lists = {}, mirrors = {}, down = [] as string[] }: { versions: Record<string, string>; lists?: Record<string, unknown>; mirrors?: Record<string, string>; down?: string[] }, seen: string[] = []) {
  return async (url: string, init?: any) => {
    seen.push(url);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (down.includes(url)) return reply(503, {});
    for (const [region, configUrl] of Object.entries(CONFIGS)) {
      const host = `${region}.test`;
      if (url === configUrl) return reply(200, config(host));
      if (url === `https://${host}/assetbundle/official/Android/version`) return reply(200, { resVersion: versions[region], clientVersion: '1.0.0' });
      const listed = url.match(new RegExp(`^https://${host}/assetbundle/official/Android/assets/([^/]+)/hot_update_list\\.json$`));
      if (listed) return lists[decodeURIComponent(listed[1])] ? reply(200, lists[decodeURIComponent(listed[1])]) : reply(404, {});
      if (url === mirrorUrl(region)) {
        assert.equal(init?.headers?.range, 'bytes=0-511', 'the mirror is read by its first bytes only');
        const version = mirrors[region] ?? versions[region];
        return reply(206, region === 'cn' ? `${version}\n` : `{\n    "versionId": "${version}",\n    "abInfos": [`);
      }
    }
    return reply(404, {});
  };
}
const ALL = (v: string) => ({ en: `en-${v}-xxxxxxxx`, jp: `jp-${v}-xxxxxxxx`, kr: `kr-${v}-xxxxxxxx`, cn: `cn-${v}-xxxxxxxx` });
const listsFor = (versions: Record<string, string>, names: string[]) => Object.fromEntries(Object.values(versions).map(v => [v, list(v, names)]));
const tmp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-versions-'));
  fs.mkdirSync(path.join(root, 'data'));
  return root;
};
const read = (root: string) => JSON.parse(fs.readFileSync(path.join(root, CLIENT_VERSIONS), 'utf8'));

test('a file list becomes a digest per top-level folder and the operator art it ships', () => {
  const digest = manifestDigest(list('v1', ['chararts/char_002_amiya.ab', 'chararts/char_002_amiya[alpha].ab', 'anon/abc.bin', 'root.idx']), 'v1');
  assert.equal(digest.bundles, 4);
  assert.deepEqual(Object.keys(digest.folders), ['(root)', 'anon', 'chararts']);
  assert.deepEqual(digest.chararts, ['char_002_amiya']);
  const next = manifestDigest(list('v2', ['chararts/char_002_amiya.ab', 'chararts/char_002_amiya[alpha].ab', 'chararts/char_4200_newop.ab', 'anon/abc.bin', 'root.idx']), 'v2');
  assert.deepEqual(manifestChanges(digest, next), { changedFolders: ['chararts'], newChararts: ['char_4200_newop'] });
  assert.deepEqual(manifestChanges(digest, digest), {});
  assert.throws(() => manifestDigest({ abInfos: [] }, 'v'), /names no bundles/);
});

test('a mirror\'s version is read from the start of its file list, or its version file', () => {
  assert.equal(mirrorResVersion('{\n    "versionId": "26-10-03-16-06-39_0a6acf",\n    "abInf'), '26-10-03-16-06-39_0a6acf');
  assert.equal(mirrorResVersion('26-10-14-13-45-10-99469376\n'), '26-10-14-13-45-10-99469376');
  assert.equal(mirrorResVersion('<html>404</html>'), null);
});

test('every region is recorded with its version, its file digest and its mirror, read at the pinned commit', async () => {
  const root = tmp();
  try {
    const versions = ALL('v1'), seen: string[] = [];
    const { problems, changed } = await watchClientVersions(root, { fetcher: server({ versions, lists: listsFor(versions, ['chararts/char_002_amiya.ab', 'anon/a.bin']) }, seen), now: new Date('2026-10-18T03:00:00Z'), env: ENV });
    assert.deepEqual(problems, []);
    assert.equal(changed.length, 4);
    const en = read(root).regions.en;
    assert.deepEqual({ ...en, manifest: undefined }, { resVersion: versions.en, clientVersion: '1.0.0', firstSeen: '2026-10-18', manifest: undefined,
      mirror: { repository: 'ArknightsAssets/ArknightsGamedata', resVersion: versions.en } });
    assert.deepEqual(en.manifest.chararts, ['char_002_amiya']);
    assert.ok(seen.includes(mirrorUrl('en')) && seen.includes(mirrorUrl('cn')), 'each mirror at its pin, never its branch');
    assert.ok(!seen.some(url => /\/(?:master|main)\//.test(url)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a quiet night writes the same bytes and fetches no file list; a new version names what it changed', async () => {
  const root = tmp();
  try {
    const v1 = ALL('v1'), v2 = { ...v1, en: 'en-v2-xxxxxxxx' };
    const names1 = ['chararts/char_002_amiya.ab', 'anon/a.bin'], names2 = [...names1, 'chararts/char_4200_newop.ab'];
    await watchClientVersions(root, { fetcher: server({ versions: v1, lists: listsFor(v1, names1) }), now: new Date('2026-10-18T03:00:00Z'), env: ENV });
    const before = fs.readFileSync(path.join(root, CLIENT_VERSIONS), 'utf8');
    const seen: string[] = [];
    await watchClientVersions(root, { fetcher: server({ versions: v1, lists: listsFor(v1, names1) }, seen), now: new Date('2026-10-19T03:00:00Z'), env: ENV });
    assert.equal(fs.readFileSync(path.join(root, CLIENT_VERSIONS), 'utf8'), before, 'no "last checked" time');
    assert.ok(!seen.some(url => url.endsWith('hot_update_list.json') && !url.includes('raw.githubusercontent')));

    await watchClientVersions(root, { fetcher: server({ versions: v2, lists: { ...listsFor(v1, names1), [v2.en]: list(v2.en, names2) } }), now: new Date('2026-10-20T03:00:00Z'), env: ENV });
    const en = read(root).regions.en;
    assert.equal(en.firstSeen, '2026-10-20');
    assert.deepEqual(en.previous, { resVersion: v1.en, clientVersion: '1.0.0', firstSeen: '2026-10-18' });
    assert.deepEqual(en.changedFolders, ['chararts']);
    assert.deepEqual(en.newChararts, ['char_4200_newop']);
    assert.equal(read(root).regions.jp.firstSeen, '2026-10-18', 'a region that did not change keeps its day');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mirror behind the live client is reported, overdue after a grace period', async () => {
  const root = tmp();
  try {
    const versions = ALL('v2');
    const { problems } = await watchClientVersions(root, { fetcher: server({ versions, lists: listsFor(versions, ['anon/a.bin']), mirrors: { en: 'en-v1-xxxxxxxx' } }), now: new Date('2026-10-18T03:00:00Z'), env: ENV });
    assert.deepEqual(problems.map((p: any) => [p.key, p.action, p.overdueAfterDays]), [['client-versions:en:mirror', 'kept-previous', 2]]);
    assert.match(problems[0].reason, /still carries en-v1-xxxxxxxx/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file list that cannot be read keeps the last digest and is asked for again; an unreadable version keeps the region', async () => {
  const root = tmp();
  try {
    const v1 = ALL('v1'), v2 = { ...v1, kr: 'kr-v2-xxxxxxxx' };
    await watchClientVersions(root, { fetcher: server({ versions: v1, lists: listsFor(v1, ['anon/a.bin']) }), now: new Date('2026-10-18T03:00:00Z'), env: ENV });
    const { problems } = await watchClientVersions(root, { fetcher: server({ versions: v2, lists: listsFor(v1, ['anon/a.bin']), down: ['https://jp.test/assetbundle/official/Android/version'] }), now: new Date('2026-10-19T03:00:00Z'), env: ENV });
    assert.deepEqual(problems.map((p: any) => [p.key, p.action]), [['client-versions:jp', 'kept-previous'], ['client-versions:kr:files', 'published-partial']]);
    const { kr, jp } = read(root).regions;
    assert.equal(kr.resVersion, 'kr-v2-xxxxxxxx');
    assert.equal(kr.manifest.resVersion, v1.kr, 'the digest of the version before stands');
    assert.equal(jp.resVersion, v1.jp);
    const seen: string[] = [];
    await watchClientVersions(root, { fetcher: server({ versions: v2, lists: { ...listsFor(v1, ['anon/a.bin']), [v2.kr]: list(v2.kr, ['anon/b.bin']) } }, seen), now: new Date('2026-10-20T03:00:00Z'), env: ENV });
    assert.equal(read(root).regions.kr.manifest.resVersion, v2.kr);
    assert.deepEqual(read(root).regions.kr.changedFolders, ['anon']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
