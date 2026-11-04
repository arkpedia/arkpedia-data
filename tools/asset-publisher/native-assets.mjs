// A public, path-addressed view of the private deduplicated mirror. No DNS changes.
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { COMMIT, PREFIX, REPOSITORIES, descriptor, indexKey, objectKey, publicFile, shardFor } from './contract.mjs';
import { boundedMap, publisherClient, verifyGitBlob } from './mirror-github-assets.mjs';

export const SOURCE_BUCKET = 'arkpedia-public-assets';
export const NATIVE_BUCKET = 'arkpedia-public-assets-direct';
// Generated content snapshots change frequently. Keep those on the deduplicated
// reader; path copies of every release would add recurring PUT/storage charges.
export const NATIVE_REPOSITORIES = new Set([...REPOSITORIES].filter(repository => repository !== 'arkpedia-data'));
const LEASE_KEY = '__control/native-publisher.json';
const LEASE_BYTES = 256;
const LEASE_MS = 30 * 60_000;
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', json: 'application/json; charset=utf-8', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', atlas: 'text/plain; charset=utf-8', skel: 'application/octet-stream' };
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const nativeKey = (repository, revision, path) => {
  assert(NATIVE_REPOSITORIES.has(repository) && COMMIT.test(revision) && publicFile(repository, path), 'Invalid native public asset');
  // Keys contain decoded filenames: the browser retains its existing encoded URL.
  const key = `arkpedia/${repository}/${revision}/${path}`;
  assert(Buffer.byteLength(key) <= 1024, 'Native R2 key exceeds 1024 bytes');
  return key;
};
const receiptKey = (repository, revision) => `__ready/${repository}/${revision}`;
function publicKey(key) {
  if (key === LEASE_KEY) return true; // Public coordination metadata; never credentials.
  const receipt = /^__ready\/([^/]+)\/([a-f0-9]{40})$/.exec(key);
  if (receipt) return NATIVE_REPOSITORIES.has(receipt[1]);
  const file = /^arkpedia\/([^/]+)\/([a-f0-9]{40})\/(.+)$/.exec(key);
  return !!file && NATIVE_REPOSITORIES.has(file[1]) && publicFile(file[1], file[3]);
}
const size = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.bytes === b.bytes && a.md5 === b.md5;

/** Both adapters are bucket-scoped. Reads are bounded, writes are create-only. */
export function nativeStore(client, bucket) {
  assert([SOURCE_BUCKET, NATIVE_BUCKET].includes(bucket), 'Unexpected asset bucket');
  const source = bucket === SOURCE_BUCKET;
  const allowed = key => source ? key.startsWith(`${PREFIX}/`) : publicKey(key);
  return {
    async list(prefix) {
      assert(source ? prefix.startsWith(`${PREFIX}/`) : prefix === '', 'Unexpected inventory prefix');
      const objects = new Map();
      const tokens = new Set();
      let token;
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of result.Contents || []) {
          const etag = item.ETag?.replaceAll('"', '');
          assert(allowed(item.Key) && size(item.Size) && /^[a-f0-9]{32}$/.test(etag || ''), 'Unexpected native inventory object');
          assert(!objects.has(item.Key), 'Duplicate inventory key');
          objects.set(item.Key, { bytes: item.Size, md5: etag });
        }
        token = result.IsTruncated ? result.NextContinuationToken : undefined;
        assert(!result.IsTruncated || token && !tokens.has(token), 'Truncated or repeated inventory page');
        tokens.add(token);
      } while (token);
      return objects;
    },
    async get(key, limit) {
      assert(allowed(key), 'Unexpected asset read');
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      try {
        assert(size(result.ContentLength) && result.ContentLength <= limit, 'Oversized asset read');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of result.Body) {
          bytes += chunk.length;
          assert(bytes <= limit, 'Oversized asset stream');
          chunks.push(Buffer.from(chunk));
        }
        assert(bytes === result.ContentLength, 'Truncated asset read');
        return Buffer.concat(chunks);
      } finally { result.Body?.destroy?.(); }
    },
    async head(key) {
      assert(allowed(key), 'Unexpected asset metadata read');
      return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    },
    async put(key, body, contentType) {
      assert(!source && publicKey(key) && key !== LEASE_KEY, 'Only native public paths can be written');
      const expected = { bytes: body.length, md5: md5(body) };
      try {
        const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*',
          ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable',
          ContentMD5: Buffer.from(expected.md5, 'hex').toString('base64'), Metadata: { sha256: sha256(body) } }));
        assert(result.ETag?.replaceAll('"', '') === expected.md5, 'Native upload checksum mismatch');
      } catch (error) {
        if (![409, 412].includes(error.$metadata?.httpStatusCode)) throw error;
        const saved = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        assert(same(expected, { bytes: saved.ContentLength, md5: saved.ETag?.replaceAll('"', '') })
          && saved.ContentType === contentType && saved.CacheControl === 'public, max-age=31536000, immutable'
          && saved.Metadata?.sha256 === sha256(body), 'Immutable native object conflict');
      }
    },
  };
}

/** Cross-repository exclusion. GitHub concurrency groups only span one repository. */
export async function acquireNativeLease(client, { now = Date.now } = {}) {
  const store = nativeStore(client, NATIVE_BUCKET);
  let previous;
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: NATIVE_BUCKET, Key: LEASE_KEY }));
    assert(response.ContentLength === LEASE_BYTES, 'Invalid native publisher lease');
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    assert(bytes.length === LEASE_BYTES, 'Invalid native publisher lease body');
    const value = JSON.parse(bytes);
    assert(Number.isSafeInteger(value.expires) && typeof value.owner === 'string', 'Invalid native publisher lease');
    assert(value.expires <= now(), 'Another native publisher holds the lease; retry after it finishes');
    previous = response.ETag;
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
  }
  const owner = randomUUID();
  let expires, etag = previous, lost, pending;
  async function write(until) {
    const body = Buffer.from(JSON.stringify({ owner, expires: until }).padEnd(LEASE_BYTES, ' '));
    assert(body.length === LEASE_BYTES, 'Oversized native publisher lease');
    const response = await client.send(new PutObjectCommand({ Bucket: NATIVE_BUCKET, Key: LEASE_KEY, Body: body,
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }), ContentType: 'application/json', CacheControl: 'no-store',
      ContentMD5: createHash('md5').update(body).digest('base64') }));
    assert(response.ETag?.replaceAll('"', '') === md5(body), 'Native lease checksum mismatch');
    etag = response.ETag; expires = until;
  }
  await write(now() + LEASE_MS);
  return {
    assertValid() {
      if (lost) throw lost;
      // Leave more time than the S3 transport/retry window for in-flight writes.
      assert(expires - now() > 10 * 60_000, 'Native publisher lease needs renewal; refusing asset writes');
    },
    renew() {
      if (lost) return Promise.reject(lost);
      if (!pending) pending = (async () => {
        assert(expires > now(), 'Native publisher lease expired');
        await write(now() + LEASE_MS);
      })().catch(error => { lost = error; throw error; }).finally(() => { pending = undefined; });
      return pending;
    },
    async release() {
      if (pending) await pending.catch(() => {});
      if (!lost && expires > now()) await write(0);
    },
    // Route all asset writes through a current lease. Never expose a stale writer.
    destination: { ...store, put: async (...args) => {
      if (lost) throw lost;
      assert(expires - now() > 10 * 60_000, 'Native publisher lease needs renewal; refusing asset writes');
      return store.put(...args);
    } },
  };
}

/** Include ALL completed media revisions, including historical pins held by old tabs. */
export async function planNativeAssets(source, destination) {
  const [receipts, blobs, existing] = await Promise.all([
    source.list(`${PREFIX}/ready/`), source.list(`${PREFIX}/objects/`), destination.list(''),
  ]);
  assert(receipts.size > 0, 'No completed public revisions to migrate');
  const revisions = [], desired = new Map();
  // Historical revisions share most indexes. Reuse verified bodies by digest,
  // with a memory bound, and overlap a small number of independent R2 reads.
  // Serially reading every historical shard can exceed the publisher deadline.
  const indexes = new Map();
  let indexBytes = 0;
  function indexBody(key, digest) {
    if (indexes.has(digest)) return indexes.get(digest).promise;
    const entry = { bytes: 0, promise: null };
    entry.promise = source.get(key, 5_000_000).then(bytes => {
      assert(sha256(bytes) === digest, 'Source index integrity failure');
      entry.bytes = bytes.length;
      indexBytes += bytes.length;
      for (const [hash, saved] of indexes) {
        if (indexBytes <= 64_000_000) break;
        if (saved.bytes) { indexes.delete(hash); indexBytes -= saved.bytes; }
      }
      return bytes;
    }).catch(error => { indexes.delete(digest); throw error; });
    indexes.set(digest, entry);
    return entry.promise;
  }
  for (const [key, listed] of [...receipts].sort(([a], [b]) => a.localeCompare(b))) {
    const match = new RegExp(`^${PREFIX}/ready/([^/]+)/([a-f0-9]{40})\\.json$`).exec(key);
    assert(match && REPOSITORIES.has(match[1]), 'Unexpected readiness key');
    const [, repository, revision] = match;
    if (!NATIVE_REPOSITORIES.has(repository)) continue;
    const bytes = await source.get(key, 1_000_000);
    assert(same(listed, { bytes: bytes.length, md5: md5(bytes) }), 'Readiness changed during inventory');
    const receipt = JSON.parse(bytes);
    assert(receipt.version === 1 && receipt.repository === repository && receipt.revision === revision
      && size(receipt.files) && receipt.files > 0 && size(receipt.bytes) && receipt.shards && typeof receipt.shards === 'object', 'Invalid source receipt');
    const complete = existing.get(receiptKey(repository, revision));
    if (complete) assert(same(complete, listed), 'Native readiness differs from source');
    const entries = [];
    await boundedMap(Object.entries(receipt.shards), 8, async ([shard, digest]) => {
      assert(/^[a-f0-9]{64}$/.test(shard) && /^[a-f0-9]{64}$/.test(digest), 'Invalid index digest');
      const bytes = await indexBody(indexKey(repository, revision, shard), digest);
      for (const [path, item] of Object.entries(JSON.parse(bytes))) {
        assert(descriptor(item) && publicFile(repository, path) && await shardFor(path) === shard, 'Invalid source file descriptor');
        const blob = blobs.get(objectKey(item.sha));
        assert(blob && blob.bytes === item.bytes, 'Missing or truncated source blob');
        const entry = { key: nativeKey(repository, revision, path), path, sha: item.sha, ...blob, completed: !!complete, contentType: TYPES[path.split('.').pop()] };
        assert(!desired.has(entry.key), 'Duplicate native path');
        desired.set(entry.key, entry);
        entries.push(entry);
      }
    });
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert(entries.length === receipt.files && entries.reduce((sum, file) => sum + file.bytes, 0) === receipt.bytes, 'Source receipt count/size mismatch');
    for (const ref of receipt.references || []) assert(REPOSITORIES.has(ref.repository) && COMMIT.test(ref.revision)
      && receipts.has(`${PREFIX}/ready/${ref.repository}/${ref.revision}.json`), 'Incomplete referenced revision');
    const ready = { key: receiptKey(repository, revision), body: bytes, bytes: bytes.length, md5: md5(bytes), contentType: 'application/json; charset=utf-8' };
    desired.set(ready.key, ready);
    revisions.push({ repository, revision, entries, ready });
  }
  assert(revisions.length > 0, 'No completed public media revisions to migrate');
  let existingBytes = 0, newBytes = existing.has(LEASE_KEY) ? 0 : LEASE_BYTES, newObjects = existing.has(LEASE_KEY) ? 0 : 1;
  for (const item of existing.values()) { assert(size(item.bytes), 'Invalid destination inventory'); existingBytes += item.bytes; }
  for (const [key, item] of desired) {
    if (existing.has(key)) {
      assert(same(existing.get(key), item), `Immutable native inventory conflict: ${key}`);
      // A create-only completion receipt attests metadata was set by this publisher.
      // Avoid a billable HEAD for every completed file on every scheduled pass.
      // Incomplete/resumed revisions still verify existing file metadata explicitly.
      if (!item.completed) {
        const saved = await destination.head(key);
        assert(saved.ContentType === item.contentType && saved.CacheControl === 'public, max-age=31536000, immutable', `Native HTTP metadata conflict: ${key}`);
      }
    }
    else { newBytes += item.bytes; newObjects++; }
  }
  assert(size(existingBytes + newBytes), 'Native storage inventory exceeds safe integer range');
  const samples = new Map();
  for (const r of revisions) for (const file of r.entries) {
    const family = `${r.repository}/${file.path.split('.').pop()}`;
    if (!samples.has(family)) samples.set(family, { repository: r.repository, revision: r.revision, path: file.path, sha: file.sha, bytes: file.bytes, contentType: file.contentType });
  }
  const summary = { revisions: revisions.length, objects: desired.size + 1, existingBytes, newBytes, newObjects, totalBytes: existingBytes + newBytes,
    // A structural forecast only; provider allowances/actual spend are not inspected.
    addedStorageUsdPerMonth: newBytes / 1e9 * 0.015,
    nativeStorageUsdPerMonth: (existingBytes + newBytes) / 1e9 * 0.015,
    identities: revisions.map(({ repository, revision }) => ({ repository, revision })), samples: [...samples.values()] };
  return { revisions, existing, summary };
}

export async function publishNativeAssets(plan, source, destination, { maxNewBytes, maxTotalBytes, concurrency = 4, onProgress = () => {} }) {
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32, 'Native upload concurrency must be 1–32');
  assert(size(maxNewBytes) && size(maxTotalBytes) && maxTotalBytes > 0, 'Explicit integer byte budgets are required');
  assert(plan.summary.newBytes <= maxNewBytes && plan.summary.totalBytes <= maxTotalBytes, 'Native asset storage budget exceeded; no writes performed');
  let uploaded = 0, uploadedBytes = 0;
  for (const { repository, revision, entries, ready } of plan.revisions) {
    await boundedMap(entries.filter(file => !plan.existing.has(file.key)), concurrency, async file => {
      const bytes = await source.get(objectKey(file.sha), file.bytes);
      verifyGitBlob(bytes, file);
      assert(md5(bytes) === file.md5, 'Source blob changed during migration');
      await destination.put(file.key, bytes, file.contentType);
      uploaded++; uploadedBytes += bytes.length;
      if (uploaded % 1000 === 0) onProgress({ uploaded, uploadedBytes, repository, revision });
    });
    // No native readiness until EVERY file in this revision is present.
    if (!plan.existing.has(ready.key)) await destination.put(ready.key, ready.body, ready.contentType);
    onProgress({ uploaded, uploadedBytes, repository, revision, ready: true });
  }
}

// Keep the existing source identity unchanged; the new identity can access only
// the native bucket. Never broaden either identity to cover unrelated buckets.
export function nativePublisherClient(env = process.env) {
  return publisherClient({ ...env, ARKPEDIA_R2_ACCESS_KEY_ID: env.ARKPEDIA_NATIVE_R2_ACCESS_KEY_ID,
    ARKPEDIA_R2_SECRET_ACCESS_KEY: env.ARKPEDIA_NATIVE_R2_SECRET_ACCESS_KEY });
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (const arg of args) {
    const [key, ...value] = arg.split('=');
    assert(['--apply', '--empty-destination', '--max-new-bytes', '--max-total-bytes', '--concurrency', '--report'].includes(key) && !(key in options), 'Unknown or duplicate native-assets option');
    assert(['--apply', '--empty-destination'].includes(key) ? !value.length : value.length && value.join('=').length, 'Invalid native-assets option');
    options[key] = value.join('=');
  }
  assert(!('--apply' in options && '--empty-destination' in options), 'An empty-destination forecast cannot be applied');
  const client = publisherClient();
  const source = nativeStore(client, SOURCE_BUCKET);
  let lease, heartbeat, targetClient;
  try {
    if (!('--empty-destination' in options)) targetClient = nativePublisherClient();
    if ('--apply' in options) {
      lease = await acquireNativeLease(targetClient);
      heartbeat = setInterval(() => { lease.renew().catch(() => {}); }, 60_000);
      heartbeat.unref();
    }
    const destination = '--empty-destination' in options ? { list: async () => new Map() } : lease?.destination || nativeStore(targetClient, NATIVE_BUCKET);
    const plan = await planNativeAssets(source, destination);
    console.log(JSON.stringify(plan.summary, null, 2));
    if (lease) {
      lease.assertValid();
      await publishNativeAssets(plan, source, destination, {
        maxNewBytes: options['--max-new-bytes'] === undefined ? undefined : Number(options['--max-new-bytes']),
        maxTotalBytes: options['--max-total-bytes'] === undefined ? undefined : Number(options['--max-total-bytes']),
        concurrency: options['--concurrency'] === undefined ? 4 : Number(options['--concurrency']),
        onProgress: progress => console.log(JSON.stringify({ nativeProgress: progress })),
      });
      lease.assertValid();
    }
    if (options['--report']) await writeFile(options['--report'], JSON.stringify({ observedAt: new Date().toISOString(), applied: !!lease, ...plan.summary }, null, 2));
  } finally {
    clearInterval(heartbeat);
    try { await lease?.release(); } finally { client.destroy(); targetClient?.destroy(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
