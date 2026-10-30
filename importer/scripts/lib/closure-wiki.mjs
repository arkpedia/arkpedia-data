/** Supplemental operation references, consulted only after the client mirrors miss art.
 * A Closure page never confirms Global availability or changes the client's mechanics. */
import { decodeEntities } from '../build/official-news.mjs';
import { imageExtension } from './staged-art.mjs';

const normalLevel = value => String(value ?? '').replace(/\\/g, '/').toLowerCase();
export function operationUrl(stageId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) throw new Error('Invalid Closure operation ID');
  return `https://closure.wiki/operations/${stageId}`;
}

/** Accept only the exact client stage and layout, and a stage-specific map preview. */
export function parseOperation(html, { stageId, levelId }) {
  const reference = operationUrl(stageId);
  const objects = [...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)].flatMap(([, code]) => {
    try { return [JSON.parse(decodeEntities(code.replace(/<[^>]*>/g, '')))]; } catch { return []; }
  });
  const stage = objects.find(row => row?.stageId === stageId);
  if (!stage || !levelId || normalLevel(stage.levelId) !== normalLevel(levelId)) {
    throw new Error('Closure operation does not match the client stage and layout');
  }
  const level = objects.find(row => row?.mapData?.map && Array.isArray(row?.mapData?.tiles));
  const map = level?.mapData?.map;
  if (!Number.isInteger(map?.row_size) || !Number.isInteger(map?.column_size)
    || map.row_size < 1 || map.row_size > 100 || map.column_size < 1 || map.column_size > 100
    || !Array.isArray(map.matrix_data) || map.matrix_data.length !== map.row_size * map.column_size) {
    throw new Error('Closure operation has no valid raw map data');
  }
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(([, key, value]) => [key.toLowerCase(), decodeEntities(value)])));
  const preview = metas.find(meta => meta.property === 'og:image')?.content;
  const image = preview ? new URL(preview) : null;
  if (!image || image.origin !== 'https://static.closure.wiki'
    || !new RegExp(`^/v[0-9]+/mappreviews/${stageId}\\.(?:webp|png)$`).test(image.pathname)
    || image.search || image.hash) throw new Error('Closure operation has no matching map preview');
  return { reference, preview: image.href, stage, level };
}

async function boundedGet(url, { fetcher, timeoutMs, maxBytes }) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    headers: { 'User-Agent': 'Arkpedia content refresh (https://www.arkpedia.net/credits)' },
  });
  if (!response.ok) throw new Error(`Closure request failed (${response.status})`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Closure response exceeds the size limit');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Closure response has no body');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Closure response exceeds the size limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function fetchOperationPreview({ stageId, levelId }, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  const html = await boundedGet(operationUrl(stageId), { fetcher, timeoutMs, maxBytes: 3 * 1024 * 1024 });
  const operation = parseOperation(html.toString('utf8'), { stageId, levelId });
  const bytes = await boundedGet(operation.preview, { fetcher, timeoutMs, maxBytes: 5 * 1024 * 1024 });
  if (!imageExtension(bytes)) throw new Error('Closure preview is not an image');
  return { ...operation, bytes };
}

/** Bound nightly requests, rotating the batch so an unavailable early page cannot starve
 * later missing maps. The adoption rerun uses the same batch on the same UTC day. */
export function fallbackBatch(candidates, { limit = 20, now = new Date() } = {}) {
  if (!candidates.length || limit < 1) return [];
  const count = Math.min(Math.floor(limit), candidates.length);
  const day = Math.floor(new Date(now).getTime() / 86400000);
  if (!Number.isFinite(day)) throw new Error('Invalid Closure fallback clock');
  const start = ((day * count) % candidates.length + candidates.length) % candidates.length;
  return Array.from({ length: count }, (_, index) => candidates[(start + index) % candidates.length]);
}
