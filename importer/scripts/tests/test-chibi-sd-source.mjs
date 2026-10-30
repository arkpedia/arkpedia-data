import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chibiIndex } from '../build/build-chibi-index.mjs';
import { readChibiArt, writeChibiArt } from '../sync/sync-chibi-art.mjs';

// The catalogue the index builds from a manifest is held by arkpedia-app's own
// scripts/tests/test-chibi-sd-source.mjs, which reads the record the site is given;
// these are the import's half: how the manifest is fetched and the record written.

const revision = 'a'.repeat(40);
const file = name => ({ path: `models/operator/char_1/outfit/front/${'b'.repeat(40)}/${name}`, bytes: 1, sha256: 'c'.repeat(64) });
const model = { kind: 'operator', skeleton: file('unit.skel'), atlas: file('unit.atlas'), textures: [file('unit.png')], premultipliedAlpha: false };
const manifest = { schemaVersion: 1, models: { battle: model, base: { ...model, skeleton: file('build_unit.skel'), premultipliedAlpha: true } },
  websiteSkins: { 'char_1@outfit#1': { front: 'battle', walk: 'base' } } };

test('sync pins both manifest reads and runtime assets to one SD commit', async () => {
  const calls = [];
  const index = await readChibiArt({ token: 'test-token', fetch: async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => calls.length === 1 ? { sha: revision } : manifest };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], `https://raw.githubusercontent.com/arkpedia/arkpedia-sd-assets/${revision}/manifest.json`);
  assert.equal(calls[1][1].headers, undefined);
  assert.ok(index['char_1@outfit#1'].front.skeleton.includes(`/${revision}/`));
});

test('failed or partial imports keep the previous website catalogue unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-chibi-sync-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const index = chibiIndex(manifest, revision), filePath = path.join(root, 'data/chibi-art.json');
    const previous = JSON.stringify(index) + '\n';
    fs.writeFileSync(filePath, previous);
    assert.throws(() => writeChibiArt(root, {}), /Empty/);
    assert.throws(() => writeChibiArt(root, { 'char_1@outfit#1': { front: index['char_1@outfit#1'].front } }), /walk/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), previous);
    assert.equal(writeChibiArt(root, index), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
