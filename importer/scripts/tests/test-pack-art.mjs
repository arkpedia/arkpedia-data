import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printedPacks, packPromoCandidates } from '../lib/pack-promo.mjs';
import { importPackArt } from '../imports/import-pack-art.mjs';
import { packArtKey, resolvePackArt } from '../../lib/events/packArt.mjs';

const source = 'https://www.arknights.global/news/123';
const url = 'https://webusstatic.yo-star.com/packs.png';
const names = ['Minoto Art Pack', 'Minoto Collection Pack'];
const rewards = { events: { event: { groups: [{ kind: 'packs', title: 'LIMITED-TIME PACKS', source, packs: names.map(name => ({ name })) }] } } };
const post = { publishTime: 100, lines: ['01 NEW OPERATORS', 'Other content', '02 LIMITED-TIME PACKS', ...names, '03 OUTFITS', 'Other content'], art: [{ url: 'https://webusstatic.yo-star.com/other.png', line: 0 }, { url, line: 2 }, { url: 'https://webusstatic.yo-star.com/outfit.png', line: 5 }, { url: 'https://untrusted.invalid/art.png', line: 3 }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=', 'base64');
async function temporary(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-art-'));
  for (const folder of ['data/assets', 'data/official-news/global']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/event-rewards.json'), JSON.stringify(rewards));
  fs.writeFileSync(path.join(root, 'data/official-news/global/123.json'), JSON.stringify(post));
  fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files: [] }));
  fs.writeFileSync(path.join(root, 'data/event-pack-art.json'), JSON.stringify({ [names[0]]: '/content-art/previous-cn.webp' }));
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const options = root => ({ root, inspect: () => [1560, 500], fetchImage: async () => png, createReader: async () => ({ read: async () => names.join('\n'), close: async () => {} }), log: () => {} });

test('only official pack-section images become candidates; newer posts sort first', () => {
  assert.deepEqual(packPromoCandidates(rewards, () => post).map(c => [c.url, c.names]), [[url, names]]);
});
test('an exact adjacent bracketed pack heading can identify ornate art, but prose proximity cannot', () => {
  const adjacent = { ...post, lines: [...post.lines] };
  adjacent.lines[3] = '[Minoto Art Pack]';
  adjacent.art = [{ url, line: 3 }];
  assert.deepEqual(packPromoCandidates(rewards, () => adjacent)[0].directNames, [names[0]]);
  adjacent.lines[3] = 'Note: Minoto Art Pack';
  assert.deepEqual(packPromoCandidates(rewards, () => adjacent)[0].directNames, []);
});
test('printed titles survive spacing and one unambiguous OCR character error without prefix or ambiguous matches', () => {
  assert.deepEqual(printedPacks('Minoto CollectionPack · Bountifut Return pack', [...names, 'Bountiful Return Pack']), [names[1], 'Bountiful Return Pack']);
  assert.deepEqual(printedPacks('Advanced Special Training Pack', ['Special Training Pack', 'Advanced Special Training Pack']), ['Advanced Special Training Pack']);
  assert.deepEqual(printedPacks('Elite Training Pack C', ['Elite Training Pack A', 'Elite Training Pack B']), []);
  assert.deepEqual(printedPacks('Unrelated items and operators', names), []);
});
test('source-scoped Global art overrides the prior fallback without changing another event', () => {
  const art = { [names[0]]: '/cn.webp', [packArtKey(source, names[0])]: '/global.webp' };
  assert.deepEqual(resolvePackArt(art, source, names[0]), { path: '/global.webp', layout: 'promo' });
  assert.deepEqual(resolvePackArt(art, source + '4', names[0]), { path: '/cn.webp', layout: 'icon' });
});
test('new art is staged with provenance, then adopted only after publication; cached reads avoid OCR/network work', async () => {
  await temporary(async root => {
    const first = await importPackArt(options(root));
    const files = Object.keys(first.staged);
    assert.equal(files.length, 1); assert.equal(first.adopted, 0);
    assert.equal(first.staged[files[0]].source, url);
    let art = JSON.parse(fs.readFileSync(path.join(root, 'data/event-pack-art.json')));
    assert.equal(art[packArtKey(source, names[0])], undefined);
    fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files }));
    const next = await importPackArt({ ...options(root), fetchImage: () => { throw Error('must reuse published state'); }, createReader: () => { throw Error('must reuse OCR state'); } });
    assert.equal(next.adopted, 2); assert.deepEqual(next.staged, {});
    art = JSON.parse(fs.readFileSync(path.join(root, 'data/event-pack-art.json')));
    assert.equal(art[packArtKey(source, names[0])], '/' + files[0]);
    assert.equal(art[names[0]], '/content-art/previous-cn.webp');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'))).entries, []);
  });
});
test('outages, unrecognized titles and tall sheets retain previous art', async () => {
  for (const change of [{ fetchImage: async () => { throw Error('offline'); } }, { createReader: async () => ({ read: async () => 'Operators, not pack titles', close: async () => {} }) }, { inspect: () => [800, 2000] }]) {
    await temporary(async root => {
      const result = await importPackArt({ ...options(root), ...change });
      assert.deepEqual(result.staged, {}); assert.equal(result.adopted, 0);
      const art = JSON.parse(fs.readFileSync(path.join(root, 'data/event-pack-art.json')));
      assert.deepEqual(art, { [names[0]]: '/content-art/previous-cn.webp' });
    });
  }
});
