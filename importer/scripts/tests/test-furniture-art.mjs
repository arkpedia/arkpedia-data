import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { furnitureThemes, importFurnitureArt } from '../imports/import-furniture-art.mjs';

const group = { kind: 'furniture-set', title: 'Workshop', source: 'building_data furni_set_gunworkshop' };
const rewards = { events: { original: { groups: [group] }, rerun: { groups: [{ ...group, inherited: 'original' }] } } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=', 'base64');
const pin = '7'.repeat(40);
const client = async () => ({ commit: pin, files: new Set(['furni_set_gunworkshop.png']) });
async function temporary(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'furniture-art-'));
  fs.mkdirSync(path.join(root, 'data/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/event-rewards.json'), JSON.stringify(rewards));
  fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files }));
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('originals and reruns join by stable theme ID, never by translated display name', () => {
  assert.deepEqual([...furnitureThemes(rewards)], [['furni_set_gunworkshop', 'Workshop']]);
  assert.equal(furnitureThemes({ events: { bad: { groups: [{ ...group, themeId: '../../outside' }] } } }).size, 0);
});

test('missing regional art stages exact official bytes with pinned provenance; published art clears reports', async () => {
  await temporary([], async root => {
    const options = { root, readClient: client, download: async () => png, log: () => {} };
    const files = await importFurnitureArt(options);
    assert.equal(Object.keys(files).length, 2);
    const row = files['content-art/furni_set_gunworkshop-en.webp'];
    assert.ok(row.source.includes(pin));
    assert.equal(row.mirror.commit, pin);
    assert.deepEqual(fs.readFileSync(path.join(root, '.cache/furniture-art', row.file)), png);
    fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files: Object.keys(files) }));
    assert.deepEqual(await importFurnitureArt({ ...options, readClient: () => { throw new Error('should not fetch published art'); } }), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'))).entries, []);
    assert.equal(fs.existsSync(path.join(root, '.cache/furniture-art/staged.json')), false);
  });
});

test('a Global outage still stages CN art, while a missing regional thumbnail retries later', async () => {
  await temporary([], async root => {
    const files = await importFurnitureArt({ root, readClient: async region => { if (region === 'en') throw new Error('offline'); return client(); }, download: async () => png, log: () => {} });
    assert.deepEqual(Object.keys(files), ['content-art/furni_set_gunworkshop-cn.webp']);
    const held = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'))).entries;
    assert.ok(held.some(row => row.key.endsWith(':en')));
  });
});

test('mixed-case client filenames resolve by game ID and invalid artwork stays pending', async () => {
  await temporary([], async root => {
    const files = await importFurnitureArt({ root,
      readClient: async region => ({ commit: pin, files: new Set(region === 'cn' ? ['furni_set_gunworkshop.png'] : []), names: new Map([['furni_set_gunworkshop.png', 'furni_set_GunWorkshop.png']]) }),
      download: async url => { assert.ok(url.endsWith('/furni_set_GunWorkshop.png')); return Buffer.from('<html>unavailable</html>'); }, log: () => {} });
    assert.deepEqual(files, {});
    assert.equal(fs.existsSync(path.join(root, '.cache/furniture-art/staged.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'))).entries[0].action, 'published-partial');
  });
});
