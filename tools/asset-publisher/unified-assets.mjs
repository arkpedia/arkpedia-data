// Future publication uses only GitHub and the unified bucket, never the old mirror.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMIT, REPOSITORIES, assetReferences, descriptor, maxFileBytes, objectKey, publicFile, readyKey } from './contract.mjs';
import { boundedMap, mirrorRevision, revisionMetadata, source, verifyGitBlob } from './mirror-github-assets.mjs';
import { planMediaReuse } from './media-reuse.mjs';
import { mediaRevision, validateMediaDelivery } from './mediaDelivery.mjs';
import { NATIVE_BUCKET, acquireNativeLease, dedupDataKey, nativeContentType, nativeKey, nativePublisherClient, nativeStore } from './native-assets.mjs';

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const readyPath = (repository, revision) => repository === 'arkpedia-data' ? readyKey(repository, revision) : `__ready/${repository}/${revision}`;
const validSize = value => Number.isSafeInteger(value) && value >= 0;
function pin(value) {
  assert.ok(value && REPOSITORIES.has(value.repository) && COMMIT.test(value.revision), 'Expected approved immutable public source');
  return `${value.repository}/${value.revision}`;
}
function receipt(bytes, repository, revision) {
  const saved = JSON.parse(bytes);
  assert.ok(saved.version === 1 && saved.repository === repository && saved.revision === revision
    && Number.isSafeInteger(saved.files) && saved.files > 0 && validSize(saved.bytes) && saved.shards
    && Object.entries(saved.shards).every(([key, value]) => /^[a-f0-9]{64}$/.test(key) && /^[a-f0-9]{64}$/.test(value)), 'Invalid unified readiness receipt');
  for (const ref of saved.references || []) { pin(ref); assert.notEqual(ref.repository, 'arkpedia-data'); }
  return saved;
}

export async function planUnifiedAssets(pins, destination, resolveSource, { reuseMedia = false } = {}) {
  assert.ok(Array.isArray(pins) && pins.length && pins.length <= 10_000, 'An immutable source plan is required');
  const existing = await destination.list('');
  const receipts = new Map();
  if (reuseMedia) await boundedMap([...existing.keys()].filter(key => key.startsWith('__ready/')), 8, async key => {
    const [, repository, revision] = key.split('/'); pin({ repository, revision });
    const body = await destination.get(key, 1_000_000);
    assert.ok(existing.get(key).bytes === body.length && existing.get(key).md5 === md5(body), 'Native reuse receipt changed during inventory');
    receipts.set(`${repository}/${revision}`, receipt(body, repository, revision));
  });
  const queue = [...pins], visited = new Set(), media = [], data = [], desired = new Map(), identities = [];
  const add = (key, item) => {
    if (desired.has(key)) assert.deepEqual(desired.get(key), item, 'Conflicting unified object descriptors');
    desired.set(key, item);
    const saved = existing.get(key);
    if (saved) assert.ok(saved.bytes === item.bytes && (!item.md5 || saved.md5 === item.md5), `Immutable unified conflict: ${key}`);
  };
  for (const current of queue) {
    const identity = pin(current);
    if (visited.has(identity)) continue;
    assert.ok(visited.size < 10_000, 'Too many referenced public revisions');
    visited.add(identity);
    const { repository, revision } = current;
    const key = readyPath(repository, revision);
    if (existing.has(key)) {
      const bytes = await destination.get(key, 1_000_000);
      assert.ok(existing.get(key).bytes === bytes.length && existing.get(key).md5 === md5(bytes), 'Unified receipt changed during inventory');
      const saved = receipt(bytes, repository, revision);
      queue.push(...(saved.references || []));
      receipts.set(identity, saved);
      identities.push({ repository, revision, reused: true });
      continue;
    }
    const input = await resolveSource(repository, revision);
    assert.ok(input.files?.length && input.files.every(file => descriptor(file, maxFileBytes(repository)) && publicFile(repository, file.path)), 'Invalid public Git tree');
    assert.equal(new Set(input.files.map(file => file.path)).size, input.files.length, 'Duplicate public Git path');
    const references = new Map();
    if (repository === 'arkpedia-data') await boundedMap(input.files, 8, async file => {
      const bytes = await input.read(file); verifyGitBlob(bytes, file);
      for (const ref of assetReferences(bytes.toString('utf8'))) references.set(pin(ref), ref);
      if (file.path === 'release/manifest.json') for (const [repository, revision] of Object.entries(JSON.parse(bytes).assets ?? {})) {
        const ref = { repository, revision }; references.set(pin(ref), ref);
      }
    });
    queue.push(...references.values());
    const metadata = await revisionMetadata({ repository, revision, files: input.files, references: [...references.values()] });
    const native = reuseMedia && repository !== 'arkpedia-data' ? planMediaReuse(repository, revision, input.files, metadata.receipt.shards, receipts, existing) : undefined;
    const entry = { repository, revision, ...input, metadata, native, body: native ? Buffer.from(JSON.stringify({ ...metadata.receipt, native })) : metadata.body, references: metadata.receipt.references || [], verifiedPaths: new Set() };
    if (repository === 'arkpedia-data') {
      data.push(entry);
      for (const file of input.files) add(objectKey(file.sha), { bytes: file.bytes });
      for (const [key, body] of metadata.indexes) add(key, { bytes: body.length, md5: md5(body) });
    } else {
      media.push(entry);
      const physicalKey = file => nativeKey(repository, mediaRevision(native ? { [repository]: { [revision]: native } } : undefined, repository, revision, file.path, true), file.path);
      for (const file of input.files) {
        const path = physicalKey(file); add(path, { bytes: file.bytes });
        if (path !== nativeKey(repository, revision, file.path)) {
          assert.ok(existing.has(path), 'Reused native file is missing');
          entry.verifiedPaths.add(path);
        }
      }
      const legacyHashes = new Map();
      await boundedMap(input.files.filter(file => existing.has(physicalKey(file)) && !entry.verifiedPaths.has(physicalKey(file))), 16, async file => {
        const key = physicalKey(file), listed = existing.get(key);
        const saved = await destination.head(key);
        assert.ok(saved.ContentLength === file.bytes && saved.ETag?.replaceAll('"', '') === listed.md5
          && saved.ContentType === nativeContentType(file.path) && saved.CacheControl === 'public, max-age=31536000, immutable', 'Existing native HTTP metadata conflict');
        if (saved.Metadata?.['git-sha1']) assert.equal(saved.Metadata['git-sha1'], file.sha, 'Existing native Git identity conflict');
        else {
          // Older verified uploads predate Git identity metadata. Check their
          // original Git bytes once per blob without resending existing paths.
          if (!legacyHashes.has(file.sha)) legacyHashes.set(file.sha, (async () => {
            const body = await input.read(file); verifyGitBlob(body, file); return md5(body);
          })());
          assert.equal(await legacyHashes.get(file.sha), listed.md5, 'Existing native bytes conflict');
        }
        entry.verifiedPaths.add(key);
      });
    }
    receipts.set(identity, { ...metadata.receipt, ...(native ? { native } : {}) });
    assert.ok(entry.body.length <= 1_000_000, 'Native readiness exceeds reader limit');
    if (repository !== 'arkpedia-data') add(key, { bytes: entry.body.length, md5: md5(entry.body) });
    identities.push({ repository, revision, reused: false });
  }
  for (const entry of data) {
    const mediaDelivery = {};
    for (const ref of entry.references) {
      const saved = receipts.get(pin(ref));
      assert.ok(saved, 'Missing referenced media readiness');
      if (saved.native) {
        mediaDelivery[ref.repository] ??= {};
        mediaDelivery[ref.repository][ref.revision] = saved.native;
      }
    }
    validateMediaDelivery(mediaDelivery);
    entry.body = Object.keys(mediaDelivery).length ? Buffer.from(JSON.stringify({ ...entry.metadata.receipt, media: mediaDelivery })) : entry.metadata.body;
    assert.ok(entry.body.length <= 1_000_000, 'Data readiness exceeds reader limit');
    add(readyPath(entry.repository, entry.revision), { bytes: entry.body.length, md5: md5(entry.body) });
  }
  let existingBytes = 0, newBytes = 0, newObjects = 0;
  for (const item of existing.values()) { assert.ok(validSize(item.bytes), 'Invalid unified inventory size'); existingBytes += item.bytes; }
  for (const [key, item] of desired) if (!existing.has(key)) { newBytes += item.bytes; newObjects++; }
  assert.ok(validSize(existingBytes + newBytes), 'Unified inventory exceeds safe integer range');
  const mediaDelivery = {};
  for (const identity of identities) {
    const saved = receipts.get(`${identity.repository}/${identity.revision}`);
    if (saved?.native) { mediaDelivery[identity.repository] ??= {}; mediaDelivery[identity.repository][identity.revision] = saved.native; }
  }
  return { existing, media, data, desired, summary: { existingBytes, newBytes, newObjects, totalBytes: existingBytes + newBytes, identities,
    source: 'immutable GitHub repositories', destination: NATIVE_BUCKET, oldBucketRequired: false, mediaDelivery } };
}

export async function publishUnifiedAssets(plan, destination, { maxNewBytes, maxTotalBytes, log = console.log }) {
  assert.ok(validSize(maxNewBytes) && validSize(maxTotalBytes) && maxTotalBytes > 0, 'Explicit integer byte budgets are required');
  assert.ok(plan.summary.newBytes <= maxNewBytes && plan.summary.totalBytes <= maxTotalBytes, 'Unified storage budget exceeded; no asset writes performed');
  // Complete every media dependency before publishing any newly referenced JSON.
  for (const entry of plan.media) {
    const physicalKey = file => nativeKey(entry.repository, mediaRevision(entry.native ? { [entry.repository]: { [entry.revision]: entry.native } } : undefined, entry.repository, entry.revision, file.path, true), file.path);
    const bySha = new Map();
    for (const file of entry.files) {
      if (!bySha.has(file.sha)) bySha.set(file.sha, []);
      bySha.get(file.sha).push(file);
    }
    const knownMedia = new Map([...bySha].filter(([, files]) => files.every(file => entry.verifiedPaths.has(physicalKey(file))))
      .map(([sha, files]) => [objectKey(sha), files[0].bytes]));
    // Two media bodies of at most 128 MB keep in-flight file bytes within 256 MB.
    await mirrorRevision({ ...entry, known: knownMedia, concurrency: 2, log, store: { put: async (key, bytes) => {
      if (key.startsWith('github-v1/objects/')) {
        const files = bySha.get(key.slice('github-v1/objects/'.length));
        assert.ok(files?.length, 'Unexpected native Git blob');
        for (const file of files) {
          const path = physicalKey(file);
          if (!entry.verifiedPaths.has(path)) await destination.put(path, bytes, nativeContentType(file.path));
        }
      } else if (entry.metadata.indexes.has(key)) {
        assert.ok(bytes.equals(entry.metadata.indexes.get(key)), 'Native receipt index changed');
      } else {
        assert.equal(key, readyKey(entry.repository, entry.revision));
        assert.ok(bytes.equals(entry.metadata.body), 'Native completion receipt changed');
        await destination.put(readyPath(entry.repository, entry.revision), entry.body, 'application/json; charset=utf-8');
      }
    } } });
  }
  const known = new Map([...plan.existing].filter(([key]) => /^github-v1\/objects\/[a-f0-9]{40}$/.test(key)).map(([key, item]) => [key, item.bytes]));
  for (const entry of plan.data) await mirrorRevision({ ...entry, known, log, store: { put: async (key, bytes) => {
    assert.ok(dedupDataKey(key) && plan.desired.has(key), 'Unexpected deduplicated data write');
    if (key === readyKey(entry.repository, entry.revision)) {
      assert.ok(bytes.equals(entry.metadata.body), 'Data completion receipt changed'); bytes = entry.body;
    }
    const saved = plan.existing.get(key);
    if (saved) { assert.ok(saved.bytes === bytes.length && saved.md5 === md5(bytes), 'Immutable data conflict'); return; }
    await destination.put(key, bytes, key.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  } } });
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (const arg of args) {
    const [key, ...value] = arg.split('=');
    assert.ok(['--apply', '--pins', '--cache', '--max-new-bytes', '--max-total-bytes', '--report'].includes(key) && !(key in options), 'Unknown or duplicate unified-assets option');
    assert.ok(key === '--apply' ? !value.length : value.join('='), 'Invalid unified-assets option');
    options[key] = value.join('=');
  }
  assert.ok(options['--pins'], 'Explicit immutable source pins are required');
  const client = nativePublisherClient();
  let lease, heartbeat;
  try {
    if ('--apply' in options) {
      lease = await acquireNativeLease(client);
      heartbeat = setInterval(() => { lease.renew().catch(() => {}); }, 60_000); heartbeat.unref();
    }
    const destination = lease?.destination || nativeStore(client, NATIVE_BUCKET);
    const pins = JSON.parse(await readFile(options['--pins'], 'utf8'));
    const cache = resolve(options['--cache'] || '.cache/github-unified');
    const plan = await planUnifiedAssets(pins, destination, (repository, revision) => source(repository, revision, cache), { reuseMedia: process.env.ARKPEDIA_NATIVE_MEDIA_REUSE === 'true' });
    console.log(JSON.stringify(plan.summary, null, 2));
    if (lease) {
      if (process.env.ARKPEDIA_NATIVE_MEDIA_REUSE === 'true') {
        const response = await fetch('https://www.arkpedia.net/build-info.json', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        const info = response.ok && await response.json();
        assert.ok(info?.nativeMediaDelivery === 1 && info.deploymentRole === 'production' && info.dirty === false, 'Production must support native media reuse before publication');
      }
      lease.assertValid();
      await publishUnifiedAssets(plan, destination, { maxNewBytes: Number(options['--max-new-bytes']), maxTotalBytes: Number(options['--max-total-bytes']) });
      lease.assertValid();
    }
    if (options['--report']) await writeFile(options['--report'], JSON.stringify({ observedAt: new Date().toISOString(), applied: !!lease, ...plan.summary }, null, 2));
  } finally {
    clearInterval(heartbeat);
    try { await lease?.release(); } finally { client.destroy(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
