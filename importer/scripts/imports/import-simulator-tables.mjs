#!/usr/bin/env node
// Publish the raw simulator inputs from the pinned EN gamedata checkout.
//
// The stage simulator (arkpedia/arkpedia-stage-simulator-standalone) needs the enemy database and
// handbook. They are copied byte-for-byte into data/simulator/raw/ with a receipt (upstream
// repository, commit, bytes, SHA256); the simulator checks both against the receipt and does its
// own transformation (its canonical loader reads raw/ only), so no transformed copy is kept here.
// Ported from arkpedia/arkpedia#741 into arkpedia-data's importer (data split phase 3).
//
// `ARKPEDIA_EN` is the gamedata directory (scripts/stage-pipeline/lib/gamedata.mjs); the
// scheduled sparse checkout is `.cache/upstream/en-gamedata/en/gamedata`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const source = path.resolve(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en/gamedata');
const lockPath = path.join(root, 'data/upstream.lock.json');
const pin = process.env.ARKPEDIA_PIN_ARKNIGHTSASSETS_ARKNIGHTSGAMEDATA
  || (fs.existsSync(lockPath)
    ? JSON.parse(fs.readFileSync(lockPath, 'utf8')).repositories?.['ArknightsAssets/ArknightsGamedata']?.commit
    : null);
if (!/^[a-f0-9]{40}$/.test(pin || '')) throw new Error('Missing pinned ArknightsAssets/ArknightsGamedata commit');
const git = (args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const head = git(['rev-parse', 'HEAD']);
if (head !== pin) throw new Error(`EN checkout HEAD ${head} does not match pin ${pin}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = rel => {
  const status = git(['status', '--porcelain', '--', rel]);
  if (status) throw new Error(`Pinned input is modified in the checkout: ${rel}`);
  git(['ls-files', '--error-unmatch', rel]);
  const file = path.join(source, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing pinned input: ${file}`);
  return fs.readFileSync(file);
};
const write = (rel, bytes) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const rawDatabase = read('levels/enemydata/enemy_database.json');
const rawHandbook = read('excel/enemy_handbook_table.json');
const database = JSON.parse(rawDatabase);
const handbook = JSON.parse(rawHandbook);
if (!database || Array.isArray(database) || typeof database !== 'object') throw new Error('Unexpected enemy_database shape');
if (!handbook || typeof handbook !== 'object' || !handbook.enemyData || typeof handbook.enemyData !== 'object') throw new Error('Unexpected enemy_handbook_table shape');
const entries = Object.entries(database);
if (!entries.length) throw new Error('Empty enemy database');
const missingHandbook = entries.filter(([key]) => !handbook.enemyData[key]).map(([key]) => key);
if (!database.enemy_3010_mcreep) throw new Error('The enemy database is missing the chapter 16 civilian');
write('data/simulator/raw/enemy_database.json', rawDatabase);
write('data/simulator/raw/enemy_handbook_table.json', rawHandbook);
const files = {
  'raw/enemy_database.json': { path: 'en/gamedata/levels/enemydata/enemy_database.json', bytes: rawDatabase.length, sha256: sha(rawDatabase) },
  'raw/enemy_handbook_table.json': { path: 'en/gamedata/excel/enemy_handbook_table.json', bytes: rawHandbook.length, sha256: sha(rawHandbook) },
};
const receipt = {
  version: 1,
  source: { repository: 'ArknightsAssets/ArknightsGamedata', commit: pin },
  files,
  handbookCoverage: { enemies: entries.length, withoutHandbook: missingHandbook.length, missingHandbook: missingHandbook.slice(0, 100) },
};
write('data/simulator/upstream.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
console.log(`Published ${entries.length} enemy records (${missingHandbook.length} without handbook) from ${pin.slice(0, 8)}`);
