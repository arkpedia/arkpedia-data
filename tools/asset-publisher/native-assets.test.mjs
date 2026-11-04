import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { mirrorRevision } from './mirror-github-assets.mjs';
import { NATIVE_BUCKET, SOURCE_BUCKET, acquireNativeLease, nativeKey, nativeStore, planNativeAssets, publishNativeAssets } from './native-assets.mjs';
import { indexKey, objectKey, readyKey, shardFor } from './contract.mjs';

const hash = (algorithm, body) => createHash(algorithm).update(body).digest('hex');
const repository = 'arkpedia-sd-assets', revision = 'a'.repeat(40);
const makeFile = (path, text) => {
  const body = Buffer.from(text);
  return { path, body, bytes: body.length, sha: hash('sha1', Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])) };
};
const files = [makeFile('char_002/战斗/char.atlas', 'char.png\nsize: 2,2'), makeFile('char_002/战斗/char.png', 'PNG bytes'), makeFile('char_002/战斗/char.skel', 'skeleton bytes')];
async function fixture() {
  const sourceData = new Map(), nativeData = new Map(), metadata = new Map(), puts = [], reads = [];
  nativeData.set('__control/native-publisher.json', Buffer.from(JSON.stringify({ owner: 'test', expires: 0 }).padEnd(256, ' ')));
  await mirrorRevision({ repository, revision, files, read: async file => file.body, known: new Map(), log: () => {},
    store: { put: async (key, body) => sourceData.set(key, Buffer.from(body)) } });
  const source = {
    list: async prefix => new Map([...sourceData].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => [key, { bytes: body.length, md5: hash('md5', body) }])),
    get: async key => { reads.push(key); assert.ok(sourceData.has(key)); return sourceData.get(key); },
  };
  const destination = {
    list: async () => new Map([...nativeData].map(([key, body]) => [key, { bytes: body.length, md5: hash('md5', body) }])),
    head: async key => metadata.get(key),
    put: async (key, body, contentType) => {
      puts.push(key); nativeData.set(key, Buffer.from(body));
      metadata.set(key, { ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' });
    },
  };
  return { sourceData, nativeData, source, destination, metadata, puts, reads };
}
const budgets = { maxNewBytes: 1_000_000, maxTotalBytes: 2_000_000 };

test('native inventory is read-only, includes historical revisions and counts duplicated paths honestly', async () => {
  const f = await fixture();
  await mirrorRevision({ repository, revision: 'b'.repeat(40), files, read: async file => file.body, known: new Map(), log: () => {},
    store: { put: async (key, bytes) => f.sourceData.set(key, Buffer.from(bytes)) } });
  const plan = await planNativeAssets(f.source, f.destination);
  assert.equal(plan.summary.revisions, 2);
  assert.equal(plan.summary.newObjects, 8);
  assert.equal(plan.summary.newBytes, [...plan.revisions].reduce((sum, r) => sum + r.ready.bytes + files.reduce((n, file) => n + file.bytes, 0), 0));
  assert.deepEqual(f.puts, []);
  assert.ok(f.reads.every(key => !key.includes('/objects/')));
  assert.equal(f.reads.filter(key => key.includes('/indexes/')).length, 1, 'Identical historical index bodies should share one verified read');
  const empty = await planNativeAssets(f.source, { list: async () => new Map() });
  assert.equal(empty.summary.newBytes, plan.summary.newBytes + 256);
  assert.equal(empty.summary.newObjects, 9);
});
test('native publishing preserves animation directories/Unicode filenames and publishes readiness last', async () => {
  const f = await fixture(), plan = await planNativeAssets(f.source, f.destination);
  await publishNativeAssets(plan, f.source, f.destination, budgets);
  for (const file of files) assert.deepEqual(f.nativeData.get(nativeKey(repository, revision, file.path)), file.body);
  assert.equal(f.puts.at(-1), `__ready/${repository}/${revision}`);
  assert.equal(f.metadata.get(nativeKey(repository, revision, files[0].path)).ContentType, 'text/plain; charset=utf-8');
  const atlas = new URL(`https://assets.arkpedia.net/${nativeKey(repository, revision, files[0].path).split('/').map(encodeURIComponent).join('/')}`);
  assert.equal(decodeURIComponent(new URL('char.png', atlas).pathname), `/${nativeKey(repository, revision, files[1].path)}`);
});
test('resumed publication does not rewrite identical files or reread their source blobs', async () => {
  const f = await fixture();
  await publishNativeAssets(await planNativeAssets(f.source, f.destination), f.source, f.destination, budgets);
  f.puts.length = 0; f.reads.length = 0;
  const plan = await planNativeAssets(f.source, f.destination);
  assert.equal(plan.summary.newBytes, 0);
  await publishNativeAssets(plan, f.source, f.destination, { maxNewBytes: 0, maxTotalBytes: plan.summary.totalBytes });
  assert.deepEqual(f.puts, []);
  assert.ok(f.reads.every(key => !key.includes('/objects/')));
});
test('both byte budgets are enforced before the first write, including already stored bytes', async () => {
  for (const limits of [{}, { maxNewBytes: -1, maxTotalBytes: 1000 }, { maxNewBytes: 1, maxTotalBytes: 1_000_000 }, { maxNewBytes: 1_000_000, maxTotalBytes: 1 }]) {
    const f = await fixture();
    const plan = await planNativeAssets(f.source, f.destination);
    await assert.rejects(publishNativeAssets(plan, f.source, f.destination, limits), /budgets|budget/);
    assert.deepEqual(f.puts, []);
  }
});
test('corrupt or failed file writes leave the revision unready and can resume safely', async () => {
  for (const reason of ['upload', 'source']) {
    const f = await fixture(), plan = await planNativeAssets(f.source, f.destination);
    if (reason === 'source') f.sourceData.set(objectKey(files[0].sha), Buffer.from('corrupt'));
    else f.destination.put = async () => { throw new Error('failed upload'); };
    await assert.rejects(publishNativeAssets(plan, f.source, f.destination, budgets));
    assert.ok(!f.nativeData.has(`__ready/${repository}/${revision}`));
  }
});
test('native inventory rejects changed indexes, missing blobs, and receipt counts that lie', async () => {
  for (const reason of ['index', 'blob', 'count', 'reference']) {
    const f = await fixture();
    if (reason === 'index') f.sourceData.set(indexKey(repository, revision, await shardFor(files[0].path)), Buffer.from('{}'));
    if (reason === 'blob') f.sourceData.delete(objectKey(files[0].sha));
    if (['count', 'reference'].includes(reason)) {
      const key = readyKey(repository, revision), receipt = JSON.parse(f.sourceData.get(key));
      if (reason === 'count') receipt.files++;
      else receipt.references = [{ repository: 'arkpedia-l2d-assets', revision }];
      f.sourceData.set(key, Buffer.from(JSON.stringify(receipt)));
    }
    await assert.rejects(planNativeAssets(f.source, f.destination), /integrity|Missing|count|referenced/);
    assert.deepEqual(f.puts, []);
  }
});
test('an existing native path with different bytes or HTTP metadata cannot be accepted', async () => {
  for (const reason of ['bytes', 'metadata']) {
    const f = await fixture();
    await publishNativeAssets(await planNativeAssets(f.source, f.destination), f.source, f.destination, budgets);
    const key = nativeKey(repository, revision, files[0].path);
    if (reason === 'bytes') f.nativeData.set(key, Buffer.from('wrong'));
    else {
      f.nativeData.delete(`__ready/${repository}/${revision}`);
      f.metadata.get(key).ContentType = 'application/octet-stream';
    }
    await assert.rejects(planNativeAssets(f.source, f.destination), /conflict/);
  }
});
test('native keys exclude moving refs, private repositories, traversal, scripts and oversized keys', () => {
  for (const args of [['arkpedia-data', revision, 'release/public/file.json'], ['private-repo', revision, 'file.png'], [repository, 'main', 'file.png'], [repository, revision, '../file.png'], [repository, revision, 'run.js'], [repository, revision, `${'é'.repeat(600)}.png`]]) {
    assert.throws(() => nativeKey(...args));
  }
  assert.throws(() => nativeStore({}, 'arkpedia-prod-accounts'));
});
test('native planning excludes generated content snapshots and their recurring copies', async () => {
  const f = await fixture();
  const generated = makeFile('release/public/example.json', '{"example":true}');
  await mirrorRevision({ repository: 'arkpedia-data', revision, files: [generated], read: async file => file.body, known: new Map(), log: () => {},
    store: { put: async (key, body) => f.sourceData.set(key, Buffer.from(body)) } });
  const plan = await planNativeAssets(f.source, f.destination);
  assert.equal(plan.summary.revisions, 1);
  assert.ok(plan.summary.identities.every(pin => pin.repository !== 'arkpedia-data'));
  assert.ok(f.reads.every(key => !key.includes('/arkpedia-data/')));
});
test('native transport accepts only public target paths and refuses all source writes', async () => {
  const client = { send: async () => { throw new Error('should not call S3'); } };
  await assert.rejects(nativeStore(client, SOURCE_BUCKET).put(objectKey(files[0].sha), Buffer.from('x'), 'image/png'), /Only native/);
  for (const key of [objectKey(files[0].sha), 'accounts/session.json', 'arkpedia/private-repo/main/a.png']) {
    await assert.rejects(nativeStore(client, NATIVE_BUCKET).put(key, Buffer.from('x'), 'image/png'), /Only native/);
  }
});
test('native transport verifies bounded stream lengths and destroys incomplete reads', async () => {
  for (const [declared, bytes, limit] of [[1, Buffer.from('too long'), 2], [9, Buffer.from('short'), 10], [9, Buffer.from('oversized'), 1]]) {
    const body = Readable.from([bytes]);
    const store = nativeStore({ send: async () => ({ ContentLength: declared, Body: body }) }, SOURCE_BUCKET);
    await assert.rejects(store.get(objectKey(files[0].sha), limit), /Oversized|Truncated/);
    assert.equal(body.destroyed, true);
  }
});
test('native conditional uploads verify checksums, type and immutable racing objects', async () => {
  const file = files[1], key = nativeKey(repository, revision, file.path), calls = [];
  const client = { send: async command => { calls.push(command.input); return { ETag: `"${hash('md5', file.body)}"` }; } };
  await nativeStore(client, NATIVE_BUCKET).put(key, file.body, 'image/png');
  assert.equal(calls[0].IfNoneMatch, '*');
  assert.equal(calls[0].ContentType, 'image/png');
  assert.equal(calls[0].ContentMD5, createHash('md5').update(file.body).digest('base64'));
  const saved = { ContentLength: file.bytes, ETag: `"${hash('md5', file.body)}"`, ContentType: 'image/png', CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: hash('sha256', file.body) } };
  for (const broken of [false, true]) {
    const race = { send: async command => {
      if (command.constructor.name === 'PutObjectCommand') throw { $metadata: { httpStatusCode: 412 } };
      return broken ? { ...saved, ContentType: 'text/html' } : saved;
    } };
    const result = nativeStore(race, NATIVE_BUCKET).put(key, file.body, 'image/png');
    if (broken) await assert.rejects(result, /conflict/); else await result;
  }
});
test('native transport fails closed on repeated listing tokens', async () => {
  const store = nativeStore({ send: async () => ({ Contents: [], IsTruncated: true, NextContinuationToken: 'same' }) }, SOURCE_BUCKET);
  await assert.rejects(store.list('github-v1/ready/'), /repeated/);
});

test('native lease excludes publishers across repositories, renews and fails closed after takeover', async () => {
  const objects = new Map();
  let now = 1_000_000;
  const client = { send: async command => {
    const input = command.input, previous = objects.get(input.Key);
    if (command.constructor.name === 'GetObjectCommand') {
      if (!previous) throw { $metadata: { httpStatusCode: 404 } };
      return { ContentLength: previous.bytes.length, ETag: previous.etag, Body: { transformToByteArray: async () => previous.bytes } };
    }
    assert.equal(command.constructor.name, 'PutObjectCommand');
    if (input.IfNoneMatch === '*' && previous || input.IfMatch && input.IfMatch !== previous?.etag) throw { $metadata: { httpStatusCode: 412 } };
    const etag = `"${hash('md5', input.Body)}"`;
    objects.set(input.Key, { bytes: Buffer.from(input.Body), etag });
    return { ETag: etag };
  } };
  const first = await acquireNativeLease(client, { now: () => now });
  first.assertValid();
  await assert.rejects(acquireNativeLease(client, { now: () => now }), /Another native publisher/);
  now += 5 * 60_000;
  await first.renew();
  first.assertValid();
  now += 31 * 60_000;
  assert.throws(() => first.assertValid(), /lease/);
  const second = await acquireNativeLease(client, { now: () => now });
  await assert.rejects(first.renew(), /expired/);
  await first.release(); // Must not release the new holder's lease.
  second.assertValid();
  await assert.rejects(acquireNativeLease(client, { now: () => now }), /Another native publisher/);
  await second.release();
  const third = await acquireNativeLease(client, { now: () => now });
  await third.release();
});
