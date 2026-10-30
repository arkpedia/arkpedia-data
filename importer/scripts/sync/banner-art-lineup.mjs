/**
 * A Standard banner's rate-ups, read from the banner's own art in the Global client.
 *
 * The client table names a Standard pool's window but not its rate-ups (gachaPoolClient's
 * dynMeta is null for every DOUBLE pool), and the wiki's yearly banner page adds the row
 * only around the day the banner opens. The client ships the banner's art about two weeks
 * earlier: under assets/dyn/[[en]]/ui/gacha/<pool id>/, name1.png and name2.png carry the
 * two 6-stars' names, name3.png to name5.png the three 5-stars', each written under its
 * stars beside the operator's class icon.
 *
 * Each name is read with Tesseract (tesseract.js, with its vendored English model, so no
 * run downloads anything) and matched against the 6- or 5-star records' names. A read is
 * taken only when it is close to one name (ACCEPT_DISTANCE) and clearly closer to it than
 * to any other (ACCEPT_MARGIN). On the 29 Global Standard banners whose art and lineup are
 * both known, that takes all 145 names and none wrongly; and with each true name taken out
 * of the roster, as for an operator with no record yet, it takes none of them
 * (scripts/tests/test-banner-art-lineup.mjs). A banner takes its lineup from the art only
 * when all five names are taken and are five different operators. Otherwise the reason is
 * returned, and the banner stays pending until its wiki row arrives.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { PNG } from 'pngjs';
import { pinnedRef } from '../content/pin-upstream.mjs';

export const ART_REPOSITORY = 'ArknightsAssets/ArknightsAssets2';
export const ACCEPT_DISTANCE = 0.2;
export const ACCEPT_MARGIN = 0.25;
/** The name plates in order, with the rarity each one names. */
export const NAME_SLOTS = [6, 6, 5, 5, 5].map((rarity, i) => ({ slot: i + 1, rarity }));

/** Where a pool's name plate is in the art mirror, at the commit this run pinned
 *  (run-stage.mjs), else the branch. */
export function nameArtUrl(poolId, slot, env = process.env) {
  return `https://raw.githubusercontent.com/${ART_REPOSITORY}/${pinnedRef(ART_REPOSITORY, env)}/assets/dyn/%5B%5Ben%5D%5D/ui/gacha/${poolId.toLowerCase()}/name${slot}.png`;
}

/** Runs of set rows (or columns) in a w×h mask, as [start, end) pairs. */
function runs(length, filled) {
  const found = [];
  let start = null;
  for (let i = 0; i <= length; i++) {
    const on = i < length && filled(i);
    if (on && start === null) start = i;
    if (!on && start !== null) { found.push([start, i]); start = null; }
  }
  return found;
}

/**
 * The name line of one name plate, as black text on white, or null when the plate has
 * none. Only the glyphs' bright, opaque core is kept, not their glow. The stars are on
 * top and the name below them. On some plates the stars' points touch the class icon, so
 * the two are split at the emptiest row of the plate's middle half, not at an empty one.
 * The class icon leads the line: a block about as wide as the line is tall, which is
 * dropped with the gap after it.
 */
export function nameLine(png) {
  const { width, height, data } = png;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = data.subarray(i * 4, i * 4 + 4);
    mask[i] = a > 200 && (r + g + b) / 3 > 200 ? 1 : 0;
  }
  const filled = Array.from({ length: height }, (_, y) => mask.subarray(y * width, (y + 1) * width).reduce((sum, on) => sum + on, 0));
  const first = filled.findIndex((count) => count > 0), last = filled.findLastIndex((count) => count > 0);
  if (first < 0) return null;
  const quarter = Math.floor((last - first) / 4);
  let split = first + quarter;
  for (let y = split; y <= last - quarter; y++) if (filled[y] < filled[split]) split = y;
  const top = filled.findIndex((count, y) => y > split && count > 0);
  const bottom = last + 1;
  if (top < 0 || bottom - top <= 3) return null;
  const lineHeight = bottom - top;
  const columnSet = (x) => { for (let y = top; y < bottom; y++) if (mask[y * width + x]) return true; return false; };
  const columns = runs(width, columnSet);
  let left = 0;
  const icon = columns.find(([, end]) => end - columns[0][0] >= lineHeight * 0.7);
  if (icon) {
    const rest = columns.find(([start]) => start > icon[1]);
    if (rest) left = rest[0];
  }
  const lineWidth = width - left;
  const pixels = new Uint8Array(lineWidth * lineHeight);
  for (let y = 0; y < lineHeight; y++) {
    for (let x = 0; x < lineWidth; x++) pixels[y * lineWidth + x] = mask[(top + y) * width + left + x] ? 0 : 255;
  }
  return { width: lineWidth, height: lineHeight, pixels };
}

const lanczos = (x) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

/** One pass of a Lanczos-3 enlargement along a line of `size` samples, to `size * scale`. */
function enlargeLine(read, size, scale, write) {
  for (let out = 0; out < size * scale; out++) {
    const center = (out + 0.5) / scale;
    const first = Math.max(Math.floor(center - 3 + 0.5), 0);
    const last = Math.min(Math.floor(center + 3 + 0.5), size);
    let total = 0, weights = 0;
    for (let i = first; i < last; i++) {
      const weight = lanczos(i - center + 0.5);
      total += read(i) * weight;
      weights += weight;
    }
    write(out, Math.min(255, Math.max(0, Math.round(total / weights))));
  }
}

/**
 * A name line as Tesseract reads it best: on a white border of 10 pixels, enlarged three
 * times, as a PNG.
 */
export function ocrImage(line, { border = 10, scale = 3 } = {}) {
  const width = line.width + border * 2, height = line.height + border * 2;
  const framed = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < line.height; y++) framed.set(line.pixels.subarray(y * line.width, (y + 1) * line.width), (y + border) * width + border);
  const wide = new Uint8Array(width * scale * height);
  for (let y = 0; y < height; y++) {
    enlargeLine((x) => framed[y * width + x], width, scale, (x, value) => { wide[y * width * scale + x] = value; });
  }
  const png = new PNG({ width: width * scale, height: height * scale, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const out = Buffer.alloc(width * scale * height * scale);
  for (let x = 0; x < width * scale; x++) {
    enlargeLine((y) => wide[y * width * scale + x], height, scale, (y, value) => { out[y * width * scale + x] = value; });
  }
  png.data = out;
  return PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
}

const normalize = (text) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The record name a read is closest to, among `names`: its distance (edits over the
 * name's length, both reduced to letters and digits) and its margin over the next closest.
 */
export function matchName(read, names) {
  const text = normalize(read);
  const scored = names.map((name) => {
    const target = normalize(name);
    return { name, distance: editDistance(text, target) / Math.max(target.length, 1) };
  }).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  if (!scored.length) return null;
  return { name: scored[0].name, distance: scored[0].distance, margin: (scored[1]?.distance ?? Infinity) - scored[0].distance };
}

const shown = (value) => (Number.isFinite(value) ? value.toFixed(2) : 'none');

/**
 * The lineup five reads name, or why they do not: {sixStars, fiveStars} or {problem}. The
 * problem is a clause that follows "published without its rate-up lineup: ", and is the
 * same every day for the same art.
 */
export function acceptLineup(reads) {
  for (const read of reads) {
    if (!read.match || read.match.distance > ACCEPT_DISTANCE || read.match.margin < ACCEPT_MARGIN) {
      const closest = read.match ? `, closest to ${read.match.name} (distance ${shown(read.match.distance)}, margin ${shown(read.match.margin)})` : '';
      return { problem: `the banner art's name ${read.slot} reads "${read.text.slice(0, 40)}"${closest}, which is not clearly one ${read.rarity}-star operator` };
    }
  }
  const names = reads.map((read) => read.match.name);
  if (new Set(names).size !== names.length) return { problem: `the banner art's names read as ${names.join(', ')}, which repeats an operator` };
  return {
    sixStars: reads.filter((read) => read.rarity === 6).map((read) => read.match.name),
    fiveStars: reads.filter((read) => read.rarity === 5).map((read) => read.match.name),
  };
}

const require = createRequire(import.meta.url);

/**
 * A Tesseract reader for single lines, with the English model vendored in
 * @tesseract.js-data/eng (the same model tesseract.js would otherwise download). Call
 * `close` when done.
 */
export async function lineReader() {
  const { createWorker } = await import('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  return {
    read: async (image) => (await worker.recognize(image)).data.text.trim(),
    close: () => worker.terminate(),
  };
}

/**
 * Read a pool's five name plates. `fetchImage(slot)` gives a plate's PNG bytes, or null
 * when the client has no such art yet; `roster` maps each record's name to its rarity.
 * Returns null when any plate is missing (the art is not out yet), else acceptLineup's
 * answer with the reads.
 */
export async function readArtLineup({ fetchImage, roster, reader }) {
  const images = await Promise.all(NAME_SLOTS.map(({ slot }) => fetchImage(slot)));
  if (images.some((image) => !image)) return null;
  const reads = [];
  for (const [i, { slot, rarity }] of NAME_SLOTS.entries()) {
    const line = nameLine(PNG.sync.read(images[i]));
    const text = line ? await reader.read(ocrImage(line)) : '';
    const names = [...roster].filter(([, value]) => value === rarity).map(([name]) => name);
    reads.push({ slot, rarity, text, match: text ? matchName(text, names) : null });
  }
  return { ...acceptLineup(reads), reads };
}
