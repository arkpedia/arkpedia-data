// Future publication uses only GitHub and the unified bucket, never the old mirror.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMIT, REPOSITORIES, assetReferences, descriptor, objectKey, publicFile, readyKey } from './contract.mjs';
import { boundedMap, mirrorRevision, revisionMetadata, source, verifyGitBlob } from './mirror-github-assets.mjs';
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

export async function planUnifiedAssets(pins, destination, resolveSource) {
  assert.ok(Array.isArray(pins) && pins.length && pins.length <= 10_000, 'An immutable source plan is required');
  const existing = await destination.list('');
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
      identities.push({ repository, revision, reused: true });
      continue;
    }
    const input = await resolveSource(repository, revision);
    assert.ok(input.files?.length && input.files.every(file => descriptor(file) && publicFile(repository, file.path)), 'Invalid public Git tree');
    assert.equal(new Set(input.files.map(file => file.path)).size, input.files.length, 'Duplicate public Git path');
    const references = new Map();
    if (repository === 'arkpedia-data') await boundedMap(input.files, 8, async file => {
      const bytes = await input.read(file); verifyGitBlob(bytes, file);
      for (const ref of assetReferences(bytes.toString('utf8'))) references.set(pin(ref), ref);
    });
    queue.push(...references.values());
    const metadata = await revisionMetadata({ repository, revision, files: input.files, references: [...references.values()] });
    const entry = { repository, revision, ...input, metadata, references: [...references.values()], verifiedPaths: new Set() };
    if (repository === 'arkpedia-data') {
      data.push(entry);
      for (const file of input.files) add(objectKey(file.sha), { bytes: file.bytes });
      for (const [key, body] of metadata.indexes) add(key, { bytes: body.length, md5: md5(body) });
    } else {
      media.push(entry);
      for (const file of input.files) add(nativeKey(repository, revision, file.path), { bytes: file.bytes });
      const legacyHashes = new Map();
      await boundedMap(input.files.filter(file => existing.has(nativeKey(repository, revision, file.path))), 16, async file => {
        const key = nativeKey(repository, revision, file.path), listed = existing.get(key);
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
    add(key, { bytes: metadata.body.length, md5: md5(metadata.body) });
    identities.push({ repository, revision, reused: false });
  }
  let existingBytes = 0, newBytes = 0, newObjects = 0;
  for (const item of existing.values()) { assert.ok(validSize(item.bytes), 'Invalid unified inventory size'); existingBytes += item.bytes; }
  for (const [key, item] of desired) if (!existing.has(key)) { newBytes += item.bytes; newObjects++; }
  assert.ok(validSize(existingBytes + newBytes), 'Unified inventory exceeds safe integer range');
  return { existing, media, data, desired, summary: { existingBytes, newBytes, newObjects, totalBytes: existingBytes + newBytes, identities,
    source: 'immutable GitHub repositories', destination: NATIVE_BUCKET, oldBucketRequired: false } };
}

export async function publishUnifiedAssets(plan, destination, { maxNewBytes, maxTotalBytes, log = console.log }) {
  assert.ok(validSize(maxNewBytes) && validSize(maxTotalBytes) && maxTotalBytes > 0, 'Explicit integer byte budgets are required');
  assert.ok(plan.summary.newBytes <= maxNewBytes && plan.summary.totalBytes <= maxTotalBytes, 'Unified storage budget exceeded; no asset writes performed');
  // Complete every media dependency before publishing any newly referenced JSON.
  for (const entry of plan.media) {
    const bySha = new Map();
    for (const file of entry.files) {
      if (!bySha.has(file.sha)) bySha.set(file.sha, []);
      bySha.get(file.sha).push(file);
    }
    const knownMedia = new Map([...bySha].filter(([, files]) => files.every(file => entry.verifiedPaths.has(nativeKey(entry.repository, entry.revision, file.path))))
      .map(([sha, files]) => [objectKey(sha), files[0].bytes]));
    await mirrorRevision({ ...entry, known: knownMedia, log, store: { put: async (key, bytes) => {
      if (key.startsWith('github-v1/objects/')) {
        const files = bySha.get(key.slice('github-v1/objects/'.length));
        assert.ok(files?.length, 'Unexpected native Git blob');
        for (const file of files) {
          const path = nativeKey(entry.repository, entry.revision, file.path);
          if (!entry.verifiedPaths.has(path)) await destination.put(path, bytes, nativeContentType(file.path));
        }
      } else if (entry.metadata.indexes.has(key)) {
        assert.ok(bytes.equals(entry.metadata.indexes.get(key)), 'Native receipt index changed');
      } else {
        assert.equal(key, readyKey(entry.repository, entry.revision));
        assert.ok(bytes.equals(entry.metadata.body), 'Native completion receipt changed');
        await destination.put(readyPath(entry.repository, entry.revision), bytes, 'application/json; charset=utf-8');
      }
    } } });
  }
  const known = new Map([...plan.existing].filter(([key]) => /^github-v1\/objects\/[a-f0-9]{40}$/.test(key)).map(([key, item]) => [key, item.bytes]));
  for (const entry of plan.data) await mirrorRevision({ ...entry, known, log, store: { put: async (key, bytes) => {
    assert.ok(dedupDataKey(key) && plan.desired.has(key), 'Unexpected deduplicated data write');
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
    const plan = await planUnifiedAssets(pins, destination, (repository, revision) => source(repository, revision, cache));
    console.log(JSON.stringify(plan.summary, null, 2));
    if (lease) {
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
