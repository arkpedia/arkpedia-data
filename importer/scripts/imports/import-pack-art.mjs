#!/usr/bin/env node
/** Official promotional artwork, staged in .cache/pack-art/. Stage originals through the existing publisher;
 * adopt paths only after publication. Source-scoped keys preserve dates/prices. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { beginStaging } from '../lib/staged-art.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { assetFileNames } from '../lib/public-assets.mjs';
import { packPromoCandidates, printedPacks, titleText } from '../lib/pack-promo.mjs';
import { packArtKey } from '../../lib/events/packArt.mjs';

const require = createRequire(import.meta.url);
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function promoReader() {
  const { createWorker } = await import('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  return { read: async bytes => (await worker.recognize(bytes)).data.text, close: () => worker.terminate() };
}

export function imageSize(bytes) {
  const result = execFileSync('python3', ['-c', 'import io,json,sys,warnings; from PIL import Image; warnings.simplefilter("error"); Image.MAX_IMAGE_PIXELS=16000000; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps(im.size)); im.verify()'], { input: bytes, encoding: 'utf8', timeout: 10000, maxBuffer: 10000 });
  return JSON.parse(result);
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Arkpedia-content/1.0' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 8_000_000) { await reader.cancel(); throw Error('Artwork exceeds the download limit'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function importPackArt({ root = process.cwd(), fetchImage = download, createReader = promoReader, inspect = imageSize, limit = 24, log = console.log } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw Error('Pack-art limit must be 1–250');
  const data = path.join(root, 'data');
  const rewards = read(path.join(data, 'event-rewards.json'), {});
  const artFile = path.join(data, 'event-pack-art.json');
  const cacheFile = path.join(data, 'pack-art-state.json');
  const art = read(artFile, {});
  const cache = read(cacheFile, { version: 1, images: {} });
  if (cache.version !== 1 || !cache.images || Array.isArray(cache.images)) throw Error('Invalid pack-art state');
  const published = new Set(assetFileNames('content-art', root));
  const staging = beginStaging('pack-art', root), report = beginStage(root, 'pack-art');
  const candidates = packPromoCandidates(rewards, id => read(path.join(data, 'official-news/global', `${id}.json`), null));
  const chosen = new Set();
  let reader, fetched = 0;
  try {
    for (const candidate of candidates) {
      const key = `pack-art:${digest(candidate.source + candidate.url).slice(0, 20)}`;
      const file = `pack-promo-${digest(candidate.url).slice(0, 24)}.webp`;
      let previous = cache.images[candidate.url];
      const matchedNames = text => [...new Set([...printedPacks(text, candidate.names), ...candidate.directNames])];
      try {
        if (previous?.file !== file || typeof previous?.text !== 'string') previous = null;
        if (previous?.ignored) continue;
        if (!previous || !published.has(file) && matchedNames(previous.text).length) {
          if (fetched >= limit) {
            report.add({ key, action: 'published-partial', sourceRef: candidate.source, reason: 'New official pack artwork is queued for a later bounded refresh; existing artwork is kept.' });
            continue;
          }
          fetched++;
          const bytes = await fetchImage(candidate.url);
          const [width, height] = inspect(bytes);
          if (!(width >= 400 && height >= 100 && width / height >= 1.6 && width / height <= 6 && width * height <= 16_000_000)) {
            // Keep tall announcement sheets and ticket-roster illustrations out of offer cards.
            cache.images[candidate.url] = { file, text: '', ignored: true, sha256: digest(bytes) };
            continue;
          }
          reader ??= await createReader();
          const text = titleText(String(await reader.read(bytes)).slice(0, 20000));
          previous = cache.images[candidate.url] = { file, text, width, height, sha256: digest(bytes) };
          if (matchedNames(text).length) staging.stage(`content-art/${file}`, bytes, { source: candidate.url });
        }
        if (previous.ignored) continue;
        const matched = matchedNames(previous.text);
        if (!matched.length) {
          report.add({ key, action: 'published-partial', sourceRef: candidate.source, reason: 'The promotional picture could not be matched unambiguously to a printed pack title; existing artwork is kept.' });
          continue;
        }
        if (!published.has(file)) {
          report.add({ key, action: 'published-partial', sourceRef: candidate.url, reason: 'Official pack artwork is staged and awaits asset publication; existing artwork is kept.' });
          continue;
        }
        for (const name of matched) {
          const pack = packArtKey(candidate.source, name);
          if (!chosen.has(pack)) { art[pack] = `/content-art/${file}`; chosen.add(pack); }
        }
      } catch (error) {
        log(`Pack artwork: ${error.message}`);
        report.add({ key, action: 'published-partial', sourceRef: candidate.source, reason: 'The official promotional picture could not be refreshed; existing artwork is kept.' });
      }
    }
  } finally { await reader?.close(); }
  staging.commit(); report.commit();
  write(artFile, Object.fromEntries(Object.entries(art).sort(([a], [b]) => a.localeCompare(b))));
  write(cacheFile, cache);
  log(`Pack artwork: ${fetched} pictures checked; ${chosen.size} source-specific offers use published art.`);
  return { staged: staging.files, adopted: chosen.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await importPackArt();
