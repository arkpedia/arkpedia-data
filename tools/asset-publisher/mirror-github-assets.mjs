import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { COMMIT, MAX_BYTES, PREFIX, REPOSITORIES, assetReferences, indexKey, objectKey, publicFile, readyKey, shardFor } from './contract.mjs';

const exec = promisify(execFile);
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const git = async (directory, args, binary = false) => (await exec('git', ['-C', directory, ...args], {
  encoding: binary ? 'buffer' : 'utf8', maxBuffer: MAX_BYTES + 1_000_000, timeout: 300_000,
})).stdout;

export function treeFiles(repository, listing) {
  if (!REPOSITORIES.has(repository)) throw new Error('Repository is not approved for public delivery');
  return listing.split('\0').filter(Boolean).flatMap(line => {
    const match = /^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/s.exec(line);
    if (!match || !publicFile(repository, match[4])) return [];
    const [, mode, sha, size, path] = match;
    const bytes = Number(size);
    if (!['100644', '100755'].includes(mode) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) throw new Error(`Unsupported public object: ${path}`);
    return [{ path, sha, bytes }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function verifyGitBlob(bytes, file) {
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== file.bytes || actual !== file.sha) throw new Error(`Git object integrity failure: ${file.path}`);
}

export async function boundedMap(items, limit, work) {
  let next = 0, failed;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { failed = error; }
    }
  }));
  if (failed) throw failed;
}

export function publisherClient(env = process.env) {
  if (!/^[a-f0-9]{32}$/.test(env.ARKPEDIA_R2_ACCOUNT_ID || '') || !env.ARKPEDIA_R2_ACCESS_KEY_ID || !env.ARKPEDIA_R2_SECRET_ACCESS_KEY) throw new Error('Explicit bucket-scoped R2 S3 credentials are required');
  return new S3Client({
    region: 'auto', endpoint: `https://${env.ARKPEDIA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.ARKPEDIA_R2_ACCESS_KEY_ID, secretAccessKey: env.ARKPEDIA_R2_SECRET_ACCESS_KEY },
    maxAttempts: 3, requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function s3Store(client, bucket) {
  if (bucket !== 'arkpedia-public-assets') throw new Error('Only the dedicated public-assets bucket is a publishing target');
  return {
    async ready(repository, revision) {
      try {
        const saved = await client.send(new GetObjectCommand({ Bucket: bucket, Key: readyKey(repository, revision) }));
        if (saved.ContentLength > 1_000_000) throw new Error('Oversized readiness receipt');
        const receipt = JSON.parse(await saved.Body.transformToString());
        if (receipt.version !== 1 || receipt.repository !== repository || receipt.revision !== revision || !receipt.shards || !Number.isSafeInteger(receipt.files) || receipt.files <= 0) throw new Error('Invalid readiness receipt');
        return receipt;
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async objects() {
      const known = new Map();
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PREFIX}/objects/`, ContinuationToken: token }));
        for (const object of page.Contents || []) known.set(object.Key, object.Size);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new Error('Truncated R2 object listing');
      } while (token);
      return known;
    },
    async put(key, bytes) {
      if (!key.startsWith(`${PREFIX}/`)) throw new Error('Invalid public-assets key');
      const md5 = createHash('md5').update(bytes).digest('base64');
      const etag = hash('md5', bytes);
      try {
        const saved = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*',
          ContentMD5: md5, ContentType: key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          Metadata: { sha256: hash('sha256', bytes) }, CacheControl: 'public, max-age=31536000, immutable' }));
        if (saved.ETag?.replaceAll('"', '') !== etag) throw new Error('R2 upload checksum mismatch');
      } catch (error) {
        if (![409, 412].includes(error.$metadata?.httpStatusCode)) throw error;
        const saved = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (saved.ContentLength !== bytes.length || saved.ETag?.replaceAll('"', '') !== etag || saved.Metadata?.sha256 !== hash('sha256', bytes)) throw new Error(`Immutable R2 object conflict: ${key}`);
      }
    },
  };
}

export async function mirrorRevision({ repository, revision, files, read, store, known, references = [], concurrency = 8, log = console.log }) {
  if (!REPOSITORIES.has(repository) || !COMMIT.test(revision)) throw new Error('A public repository and immutable commit are required');
  const unique = new Map(files.map(file => [file.sha, file]));
  let uploaded = 0, reused = 0;
  await boundedMap([...unique.values()], concurrency, async file => {
    const key = objectKey(file.sha);
    if (known.has(key)) {
      if (known.get(key) !== file.bytes) throw new Error(`Stored Git object length mismatch: ${file.sha}`);
      reused++;
      return;
    }
    const bytes = await read(file);
    verifyGitBlob(bytes, file);
    await store.put(key, bytes);
    known.set(key, file.bytes);
    uploaded++;
    if (uploaded % 1000 === 0) log(`${repository}: ${uploaded} uploaded, ${reused} reused`);
  });
  const groups = new Map();
  for (const file of files) {
    const shard = await shardFor(file.path);
    if (!groups.has(shard)) groups.set(shard, Object.create(null));
    groups.get(shard)[file.path] = { sha: file.sha, bytes: file.bytes };
  }
  const shards = Object.create(null);
  await boundedMap([...groups], concurrency, async ([shard, index]) => {
    const bytes = Buffer.from(JSON.stringify(index));
    if (bytes.length > 5_000_000) throw new Error('Asset directory index is too large');
    await store.put(indexKey(repository, revision, shard), bytes);
    shards[shard] = hash('sha256', bytes);
  });
  const receipt = { version: 1, repository, revision, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0),
    shards: Object.fromEntries(Object.entries(shards).sort(([a], [b]) => a < b ? -1 : 1)), ...(references.length ? { references } : {}) };
  // Published last. A partial upload cannot make a new commit available to readers.
  await store.put(readyKey(repository, revision), Buffer.from(JSON.stringify(receipt)));
  log(JSON.stringify({ repository, revision, files: files.length, uploaded, reused, bytes: receipt.bytes }));
  return receipt;
}

async function source(repository, revision, cache) {
  if (!REPOSITORIES.has(repository) || !COMMIT.test(revision)) throw new Error('Invalid pinned GitHub source');
  const directory = join(cache, repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet']);
  try { await git(directory, ['cat-file', '-e', `${revision}^{commit}`]); }
  catch { await git(directory, ['fetch', '--no-tags', '--depth=1', `https://github.com/arkpedia/${repository}.git`, revision]); }
  const files = treeFiles(repository, await git(directory, ['ls-tree', '-r', '-z', '-l', revision]));
  if (!files.length) throw new Error(`No public files found in ${repository}`);
  return { files, read: file => git(directory, ['cat-file', 'blob', file.sha], true) };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = Object.fromEntries(args.map(value => { const [key, ...rest] = value.split('='); return [key, rest.join('=')]; }));
  const pinsFile = options['--pins'] || 'data/assets/revisions.json';
  const pins = JSON.parse(await readFile(pinsFile, 'utf8'));
  const sources = Array.isArray(pins) ? pins : Object.entries(pins).map(([repository, revision]) => ({ repository, revision }));
  if (options['--data']) sources.push({ repository: 'arkpedia-data', revision: options['--data'] });
  const store = s3Store(publisherClient(env), 'arkpedia-public-assets');
  let known;
  const cache = resolve(options['--cache'] || '.cache/github-mirror');
  const receipts = [];
  const visited = new Set();
  for (const { repository, revision } of sources) {
    if (!REPOSITORIES.has(repository) || !COMMIT.test(revision)) throw new Error('Invalid pinned mirror plan');
    const identity = `${repository}/${revision}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const ready = await store.ready(repository, revision);
    if (ready) {
      sources.push(...(ready.references || []));
      receipts.push(ready);
      console.log(JSON.stringify({ repository, revision, alreadyMirrored: true, files: ready.files }));
      continue;
    }
    known ||= await store.objects();
    const input = await source(repository, revision, cache);
    const references = new Map();
    if (repository === 'arkpedia-data') {
      await boundedMap(input.files, 8, async file => {
        const bytes = await input.read(file);
        verifyGitBlob(bytes, file);
        for (const ref of assetReferences(bytes.toString('utf8'))) references.set(`${ref.repository}/${ref.revision}`, ref);
      });
    }
    sources.push(...references.values());
    receipts.push(await mirrorRevision({ repository, revision, ...input, references: [...references.values()], store, known }));
  }
  if (options['--report']) await writeFile(options['--report'], JSON.stringify(receipts, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

