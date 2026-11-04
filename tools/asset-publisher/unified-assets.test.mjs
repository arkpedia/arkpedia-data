import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { nativeKey } from './native-assets.mjs';
import { planUnifiedAssets, publishUnifiedAssets } from './unified-assets.mjs';
import { objectKey, readyKey } from './contract.mjs';

const hash = (type, bytes) => createHash(type).update(bytes).digest('hex');
const mediaRepo = 'arkpedia-image-assets', mediaRev = 'a'.repeat(40), dataRev = 'b'.repeat(40), oldRev = 'c'.repeat(40);
const makeFile = (path, text) => {
  const body = Buffer.from(text);
  return { path, body, bytes: body.length, sha: hash('sha1', Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])) };
};
const mediaFile = makeFile('icons/example.webp', 'public image bytes');
const jsonFile = makeFile('release/manifest.json', JSON.stringify({ image: `https://raw.githubusercontent.com/arkpedia/${mediaRepo}/${mediaRev}/${mediaFile.path}` }));
const mediaFiles = [mediaFile, { ...mediaFile, path: 'icons/repeated.webp' }];
const jsonFiles = [jsonFile, { ...jsonFile, path: 'release/public/repeated.json' }];
const budgets = { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000, log: () => {} };
function memoryStore() {
  const objects = new Map(), metadata = new Map(), puts = [];
  const store = {
    list: async prefix => new Map([...objects].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => [key, { bytes: body.length, md5: hash('md5', body) }])),
    get: async key => { assert.ok(objects.has(key), `Missing fixture ${key}`); return objects.get(key); },
    head: async key => metadata.get(key),
    put: async (key, body, contentType) => {
      if (objects.has(key)) assert.ok(objects.get(key).equals(body), 'Immutable fixture conflict');
      puts.push(key); objects.set(key, Buffer.from(body));
      metadata.set(key, { ContentLength: body.length, ETag: `"${hash('md5', body)}"`, ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable', Metadata: { 'git-sha1': hash('sha1', Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])) } });
    },
  };
  return { objects, metadata, puts, store };
}
function gitSources() {
  const reads = [];
  const source = async (repository, revision) => {
    const files = repository === 'arkpedia-data' && [dataRev, oldRev].includes(revision) ? jsonFiles
      : repository === mediaRepo && revision === mediaRev ? mediaFiles : null;
    assert.ok(files, 'Unexpected Git source');
    return { files, read: async file => { reads.push(`${repository}/${revision}/${file.path}`); return file.body; } };
  };
  return { source, reads };
}

test('unified Git publication writes URL-shaped media and deduplicated JSON into one bucket without the old mirror', async () => {
  const f = memoryStore(), git = gitSources();
  const pins = [{ repository: 'arkpedia-data', revision: oldRev }, { repository: 'arkpedia-data', revision: dataRev }];
  const plan = await planUnifiedAssets(pins, f.store, git.source);
  assert.deepEqual(f.puts, []); assert.equal(plan.summary.oldBucketRequired, false);
  assert.equal(plan.media.length, 1); assert.equal(plan.data.length, 2);
  await publishUnifiedAssets(plan, f.store, budgets);
  assert.ok(f.objects.has(nativeKey(mediaRepo, mediaRev, mediaFile.path)));
  assert.ok(f.objects.has(nativeKey(mediaRepo, mediaRev, mediaFiles[1].path)));
  assert.ok(!f.objects.has(objectKey(mediaFile.sha)), 'Media must not retain an extra CAS copy');
  assert.ok(f.objects.has(objectKey(jsonFile.sha)));
  assert.equal(f.puts.filter(key => key === objectKey(jsonFile.sha)).length, 1, 'Repeated data revisions share a JSON blob');
  assert.ok(f.puts.indexOf(`__ready/${mediaRepo}/${mediaRev}`) < f.puts.indexOf(readyKey('arkpedia-data', oldRev)));
  assert.ok(f.objects.get(readyKey('arkpedia-data', dataRev)));
  const resumed = await planUnifiedAssets(pins, f.store, async () => { throw Error('Completed immutable pins must not require Git or the old bucket'); });
  assert.equal(resumed.summary.newBytes, 0);
  f.puts.length = 0; await publishUnifiedAssets(resumed, f.store, { ...budgets, maxNewBytes: 0 });
  assert.deepEqual(f.puts, []);
});
test('unified storage budgets and invalid source paths fail before asset writes', async () => {
  const f = memoryStore(), git = gitSources(), pins = [{ repository: mediaRepo, revision: mediaRev }];
  const plan = await planUnifiedAssets(pins, f.store, git.source);
  await assert.rejects(publishUnifiedAssets(plan, f.store, { ...budgets, maxNewBytes: 0 }), /budget/);
  assert.deepEqual(f.puts, []);
  for (const value of [{ repository: 'private-repository', revision: mediaRev }, { repository: mediaRepo, revision: 'main' }]) {
    await assert.rejects(planUnifiedAssets([value], f.store, git.source), /immutable/);
  }
  await assert.rejects(planUnifiedAssets(pins, f.store, async () => ({ files: [{ ...mediaFile, path: '../private.js' }] })), /Git tree/);
  assert.deepEqual(f.puts, []);
});
test('interrupted native revisions reuse verified paths, including partially copied duplicate blobs', async () => {
  const f = memoryStore(), git = gitSources(), pins = [{ repository: mediaRepo, revision: mediaRev }];
  const plan = await planUnifiedAssets(pins, f.store, git.source);
  const first = nativeKey(mediaRepo, mediaRev, mediaFiles[0].path), second = nativeKey(mediaRepo, mediaRev, mediaFiles[1].path);
  await assert.rejects(publishUnifiedAssets(plan, { ...f.store, put: async (key, ...args) => {
    if (key === second) throw Error('interrupted duplicate copy'); return f.store.put(key, ...args);
  } }, budgets));
  assert.ok(f.objects.has(first)); assert.ok(!f.objects.has(second));
  f.puts.length = 0; git.reads.length = 0;
  const resumed = await planUnifiedAssets(pins, f.store, git.source);
  assert.equal(git.reads.length, 0, 'Verified Git metadata avoids rereading already copied bodies');
  await publishUnifiedAssets(resumed, f.store, budgets);
  assert.equal(git.reads.length, 1, 'The missing duplicate path reads the Git blob only once');
  assert.deepEqual(f.puts, [second, `__ready/${mediaRepo}/${mediaRev}`]);
  f.objects.delete(`__ready/${mediaRepo}/${mediaRev}`); f.puts.length = 0;
  const noReads = async (...args) => ({ ...(await git.source(...args)), read: async () => { throw Error('Existing bodies must not be read or resent'); } });
  await publishUnifiedAssets(await planUnifiedAssets(pins, f.store, noReads), f.store, budgets);
  assert.deepEqual(f.puts, [`__ready/${mediaRepo}/${mediaRev}`]);
});
test('a failed or corrupt media upload cannot publish generated-data readiness', async () => {
  for (const reason of ['upload', 'source']) {
    const f = memoryStore(), git = gitSources();
    const source = async (...args) => {
      const result = await git.source(...args);
      if (reason === 'source' && args[0] === mediaRepo) result.read = async () => Buffer.from('corrupt media');
      return result;
    };
    const plan = await planUnifiedAssets([{ repository: 'arkpedia-data', revision: dataRev }], f.store, source);
    const destination = reason === 'upload' ? { ...f.store, put: async () => { throw Error('interrupted'); } } : f.store;
    await assert.rejects(publishUnifiedAssets(plan, destination, budgets));
    assert.ok(!f.objects.has(`__ready/${mediaRepo}/${mediaRev}`));
    assert.ok(!f.objects.has(readyKey('arkpedia-data', dataRev)));
  }
});
