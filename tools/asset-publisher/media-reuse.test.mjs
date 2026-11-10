import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { planUnifiedAssets, publishUnifiedAssets } from './unified-assets.mjs';
import { mediaGroup, mediaRevision, validateMediaDelivery } from './mediaDelivery.mjs';

const hash = (kind, value) => createHash(kind).update(value).digest('hex');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const image = 'arkpedia-image-assets', chibi = 'arkpedia-sd-assets', art = 'arkpedia-l2d-assets';
const file = (path, text = path) => {
  const body = Buffer.from(text);
  return { path, body, bytes: body.length, sha: hash('sha1', Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])) };
};
function fixture() {
  const objects = new Map(), heads = new Map(), writes = [], reads = [], gets = [];
  const store = {
    list: async () => new Map([...objects].map(([key, value]) => [key, { bytes: value.length, md5: hash('md5', value) }])),
    get: async key => { gets.push(key); return objects.get(key); }, head: async key => heads.get(key),
    put: async (key, body, contentType) => {
      writes.push(key); objects.set(key, body);
      heads.set(key, { ContentLength: body.length, ETag: hash('md5', body), ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable', Metadata: { 'git-sha1': hash('sha1', Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])) } });
    },
  };
  const publish = async (repository, revision, files, reuseMedia = true) => {
    const plan = await planUnifiedAssets([{ repository, revision }], store, async () => ({ files: [...files].sort((a, b) => a.path.localeCompare(b.path)), read: async f => { reads.push(f.path); return f.body; } }), { reuseMedia });
    await publishUnifiedAssets(plan, store, { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} });
    return plan;
  };
  return { objects, writes, reads, gets, store, publish };
}
test('completed pins read only their dependency receipts while retaining the full storage budget', async () => {
  const f = fixture(), files = [file('icons/a.webp')];
  await f.publish(image, a, files, false);
  const original = JSON.parse(f.objects.get(`__ready/${image}/${a}`));
  for (let i = 0; i < 1000; i++) {
    const revision = i.toString(16).padStart(40, '0');
    f.objects.set(`__ready/${image}/${revision}`, Buffer.from(JSON.stringify({ ...original, revision })));
  }
  f.gets.length = 0; f.writes.length = 0;
  const noSource = async () => { throw Error('Completed pins must not load Git sources'); };
  const plan = await planUnifiedAssets([{ repository: image, revision: a }], f.store, noSource, { reuseMedia: true });
  assert.deepEqual(f.gets, [`__ready/${image}/${a}`]);
  assert.equal(plan.summary.newBytes, 0);
  assert.equal(plan.summary.newObjects, 0);
  assert.equal(plan.summary.existingBytes, [...f.objects.values()].reduce((sum, body) => sum + body.length, 0));
  await assert.rejects(publishUnifiedAssets(plan, f.store, { maxNewBytes: 0, maxTotalBytes: plan.summary.existingBytes - 1 }), /budget/);
  assert.deepEqual(f.writes, []);

  const json = file('release/manifest.json', JSON.stringify({ assets: { [image]: a } }));
  await f.publish('arkpedia-data', b, [json]);
  f.gets.length = 0;
  const dataPlan = await planUnifiedAssets([{ repository: 'arkpedia-data', revision: b }], f.store, noSource, { reuseMedia: true });
  assert.deepEqual(f.gets, [`github-v1/ready/arkpedia-data/${b}.json`, `__ready/${image}/${a}`]);
  assert.equal(dataPlan.summary.identities.length, 2, 'completed data still follows its media dependencies');
});
test('new data preserves referenced media mappings without reading unrelated history', async () => {
  const f = fixture(), files = [file('icons/a.webp')];
  await f.publish(image, a, files, false);
  await f.publish(image, b, files);
  const native = JSON.parse(f.objects.get(`__ready/${image}/${b}`)).native;
  assert.equal(native.baseRevision, a);
  f.objects.set(`__ready/${image}/${'d'.repeat(40)}`, Buffer.from('{}'));
  f.gets.length = 0;
  const json = file('release/manifest.json', JSON.stringify({ assets: { [image]: b } }));
  const plan = await planUnifiedAssets([{ repository: 'arkpedia-data', revision: c }], f.store, async repository => {
    assert.equal(repository, 'arkpedia-data', 'completed media must not load Git sources');
    return { files: [json], read: async value => value.body };
  }, { reuseMedia: true });
  assert.deepEqual(f.gets, [`__ready/${image}/${b}`]);
  assert.equal(plan.media.length, 0);
  assert.deepEqual(JSON.parse(plan.data[0].body).media[image][b], native);
  await publishUnifiedAssets(plan, f.store, { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} });
  const ready = JSON.parse(f.objects.get(`github-v1/ready/arkpedia-data/${c}.json`));
  assert.deepEqual(ready.media[image][b], native);

  f.writes.length = 0;
  await assert.rejects(f.publish(image, c, files), /Invalid unified readiness receipt/);
  assert.deepEqual(f.writes, [], 'new media still validates historical reuse authorities before writing');
});
test('new media loads historical receipts once and reuses already verified requested receipts', async () => {
  const f = fixture(), files = [file('icons/a.webp')];
  await f.publish(image, a, files, false);
  f.gets.length = 0;
  const pins = [{ repository: image, revision: a }, { repository: image, revision: b }];
  const plan = await planUnifiedAssets(pins, f.store, async () => ({ files, read: async value => value.body }), { reuseMedia: true });
  assert.deepEqual(f.gets, [`__ready/${image}/${a}`]);
  assert.equal(plan.media[0].native.baseRevision, a);
});
test('completed pins still reject receipts changed since inventory', async () => {
  const f = fixture();
  await f.publish(image, a, [file('icons/a.webp')], false);
  f.store.get = async () => Buffer.from('{}');
  await assert.rejects(planUnifiedAssets([{ repository: image, revision: a }], f.store,
    async () => { throw Error('Unexpected source read'); }, { reuseMedia: true }), /receipt changed/);
});
test('unchanged directories reuse original bytes across multiple generations, changed/deleted directories do not', async () => {
  const f = fixture(), old = [file('icons/a.webp'), file('icons/b.webp'), file('deleted/old.webp')];
  await f.publish(image, a, old, false);
  f.writes.length = 0; f.reads.length = 0;
  const next = [old[0], old[1], file('new/c.webp')];
  const plan = await f.publish(image, b, next);
  assert.deepEqual(f.reads, ['new/c.webp']);
  assert.ok(!f.writes.some(key => key.includes('/icons/')));
  const native = plan.media[0].native;
  const maps = { [image]: { [b]: native } };
  assert.equal(mediaRevision(maps, image, b, 'icons/a.webp'), a);
  assert.equal(mediaRevision(maps, image, b, 'deleted/old.webp'), b, 'removed directory never exposes old files');
  assert.ok(f.objects.has(`arkpedia/${image}/${a}/deleted/old.webp`), 'historical URL retained');
  f.writes.length = 0; f.reads.length = 0;
  await f.publish(image, c, [...next, file('other/d.webp')]);
  assert.deepEqual(f.reads, ['other/d.webp'], 'mapped receipts can be reused without alias chains');
});
test('one changed animation child recopies its complete bundle including relative resources', async () => {
  const f = fixture(), root = `models/character/${'d'.repeat(12)}`;
  const old = [file(`${root}/model.json`), file(`${root}/textures/0.png`), file(`${root}/entrance/entry.skel`)];
  await f.publish(art, a, old, false); f.reads.length = 0;
  const next = [old[0], file(`${root}/textures/0.png`, 'new pixels'), old[2]];
  const plan = await f.publish(art, b, next);
  assert.equal(f.reads.length, 3);
  for (const item of next) assert.equal(mediaRevision({ [art]: { [b]: plan.media[0].native } }, art, b, item.path), b);
  assert.equal(mediaGroup(chibi, `models/operator/name/front/${a}/texture.png`), `models/operator/name/front/${a}`);
});
test('missing physical reuse files and changed readiness checksums fail before writes', async () => {
  for (const damage of ['missing', 'receipt']) {
    const f = fixture(), files = [file('icons/a.webp'), file('icons/b.webp')];
    await f.publish(image, a, files, false); f.writes.length = 0;
    if (damage === 'missing') f.objects.delete(`arkpedia/${image}/${a}/icons/b.webp`);
    else f.store.get = async () => Buffer.from('{}');
    await assert.rejects(f.publish(image, b, files), /Incomplete|receipt changed/);
    assert.deepEqual(f.writes, []);
  }
});
test('manifest asset pins are dependencies and mapped data readiness follows media readiness', async () => {
  const f = fixture(), files = [file('icons/a.webp')];
  await f.publish(image, a, files, false); f.writes.length = 0;
  const json = file('release/manifest.json', JSON.stringify({ assets: { [image]: b } }));
  const plan = await planUnifiedAssets([{ repository: 'arkpedia-data', revision: c }], f.store, async repository => ({
    files: repository === 'arkpedia-data' ? [json] : files, read: async value => value.body,
  }), { reuseMedia: true });
  await assert.rejects(publishUnifiedAssets(plan, f.store, { maxNewBytes: 0, maxTotalBytes: 2_000_000 }), /budget/);
  assert.deepEqual(f.writes, []);
  await publishUnifiedAssets(plan, f.store, { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} });
  const key = `github-v1/ready/arkpedia-data/${c}.json`;
  const ready = JSON.parse(f.objects.get(key));
  assert.equal(ready.media[image][b].baseRevision, a);
  assert.ok(f.writes.indexOf(`__ready/${image}/${b}`) < f.writes.indexOf(key));
  assert.ok(f.objects.get(`github-v1/objects/${json.sha}`).equals(json.body), 'Git JSON remains unchanged');
});
test('delivery validation bounds payload and rejects private paths, mutable revisions and invalid groups', () => {
  for (const maps of [
    { private: { [a]: { version: 1, baseRevision: b, overrides: {} } } },
    { [image]: { main: { version: 1, baseRevision: b, overrides: {} } } },
    { [image]: { [a]: { version: 1, baseRevision: b, overrides: { '../private': a } } } },
    { [chibi]: { [a]: { version: 1, baseRevision: b, overrides: { [`models/character/${c}/textures`]: a } } } },
  ]) assert.throws(() => validateMediaDelivery(maps), /Invalid/);
  const maps = { [image]: { [a]: { version: 1, baseRevision: b, overrides: { 'art #1': c } } } };
  assert.equal(mediaRevision(validateMediaDelivery(maps), image, a, 'art%20%231/Name%20%23.png?v=3'), c);
  assert.equal(mediaRevision(maps, image, a, 'art #1/Name #.png', true), c);
  assert.equal(mediaRevision({}, image, a, 'icons/file.webp'), a);
});
test('interrupted mapped publication resumes verified new files and preserves its reuse map', async () => {
  const f = fixture(), old = [file('icons/a.webp')], next = [...old, file('new/a.webp'), file('new/b.webp')];
  await f.publish(image, a, old, false); f.writes.length = 0;
  const sources = async () => ({ files: next, read: async value => value.body });
  const pins = [{ repository: image, revision: b }];
  const plan = await planUnifiedAssets(pins, f.store, sources, { reuseMedia: true });
  const failed = { ...f.store, put: async (key, ...args) => { if (key.endsWith('/new/b.webp')) throw Error('interrupted'); await f.store.put(key, ...args); } };
  await assert.rejects(publishUnifiedAssets(plan, failed, { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} }), /interrupted/);
  assert.ok(!f.objects.has(`__ready/${image}/${b}`)); f.writes.length = 0;
  const resumed = await planUnifiedAssets(pins, f.store, sources, { reuseMedia: true });
  assert.deepEqual(resumed.media[0].native, plan.media[0].native);
  await publishUnifiedAssets(resumed, f.store, { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} });
  assert.deepEqual(f.writes, [`arkpedia/${image}/${b}/new/b.webp`, `__ready/${image}/${b}`]);
});
