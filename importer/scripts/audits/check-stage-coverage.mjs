#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertStageCoverage } from '../stage-pipeline/lib/coverage.mjs';

const root = process.cwd();
const en = process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en';
// The stage builder accepts gamedata/ directly; refresh's other readers use en/.
const gamedata = fs.existsSync(path.join(en, 'excel')) ? en : path.join(en, 'gamedata');
const table = fs.readFileSync(path.join(gamedata, 'excel/stage_table.json'));
const revision = execFileSync('git', ['-C', gamedata, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pinned = process.env.ARKPEDIA_PIN_ARKNIGHTSASSETS_ARKNIGHTSGAMEDATA;
if (pinned && pinned !== revision) throw new Error(`Stage source ${revision} differs from run pin ${pinned}`);
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const records = fs.readdirSync('data/stages').filter(file => file.endsWith('.json')).map(file => read(`data/stages/${file}`));
const coverage = assertStageCoverage({ stages: JSON.parse(table).stages, records,
  index: read('public/stages-index.json'), excluded: read('data/excluded-contents.json'),
  geometryExists: key => fs.existsSync(path.join(root, 'data/stage-geometry', `${key}.json`)) });
const report = { version: 1, region: 'global', sourceRevision: revision,
  stageTableSha256: createHash('sha256').update(table).digest('hex'), ...coverage };
fs.writeFileSync('data/stage-coverage.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Stage coverage verified: ${coverage.tableRows} Global table rows, ${coverage.records} records, ${coverage.indexed} indexed; source ${revision}`);
