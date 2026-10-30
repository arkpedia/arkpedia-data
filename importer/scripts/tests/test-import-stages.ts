import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { MIRRORS } from '../content/pin-upstream.mjs';
import { commandScripts, refreshScripts, refreshStages } from './fixtures/refresh-stages';

/* The nightly import's stages (run-imports.sh, with refresh-stage-data.sh where it calls it):
   each script exists, reads the mirrors at the run's pins, and runs in an order its inputs allow.
   Moved from the application's test-stage-runner.ts with the import (data split phase 4); the
   stage runner itself (run-stage.mjs) is tested there. */

test('every script a refresh stage names exists, directly or through an npm script', () => {
  // refreshScripts() passes over a path that is not there, so the check above would never see
  // a stage whose script was deleted or renamed under it; the stage would fail every night.
  // A stage kept after its job moved elsewhere is the quieter case: banner-art ran
  // sync-banner-art.py after arkpedia-image-assets took the English art over, and skipped
  // every banner because the art is no longer in this checkout (retired 2026-09-26).
  const npm = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
  const missing: string[] = [];
  const check = (text: string, where: string) => {
    for (const [, name] of text.matchAll(/npm run ([\w:-]+)/g)) {
      if (npm[name]) check(npm[name], `npm run ${name}`); else missing.push(`${where}: npm run ${name} (not in package.json)`);
    }
    for (const [file] of text.matchAll(/scripts\/[\w./-]+\.(?:mjs|js|ts|py|sh)\b/g)) if (!fs.existsSync(file)) missing.push(`${where}: ${file}`);
  };
  const stages = refreshStages();
  for (const stage of stages) check(stage.command, `stage ${stage.name}`);
  assert.deepEqual(missing, []);
  assert.ok(!stages.some(stage => stage.name === 'banner-art' || stage.command.includes('sync-banner-art')), 'banner-art is retired');
});

test('a stage that builds records from the pinned asset revisions runs after the last stage that moves them', () => {
  // Three stages move data/assets/revisions.json, each through npm run assets:update, which
  // pins every asset repository at its head: asset-revisions, catalogue-assets after its push,
  // and staged-art after its push, late in the run. A stage that reads art at the pinned commit
  // and writes records from it (it says so with --revisions data/assets/revisions.json) must
  // come after the last of them. Before it, the release would pin a newer commit than the one
  // the stage read: the palettes stage ran after media-pins, the last mover before staged-art
  // existed, so skin art pushed between it and staged-art went out with no palette and was
  // held for a day. media-pins needs no such place: staged-art re-pins the records itself.
  const stages = refreshStages();
  const order = stages.map(stage => stage.name);
  const movers = stages.filter(stage => commandScripts(stage.command).includes('scripts/sync/update-asset-revisions.mjs')).map(stage => stage.name);
  const readers = stages.filter(stage => /--revisions data\/assets\/revisions\.json\b/.test(stage.command)).map(stage => stage.name);
  // Not vacuous: the walk finds the movers through the publisher's shell script, and the reader.
  assert.deepEqual([...movers].sort(), ['asset-revisions', 'catalogue-assets', 'staged-art']);
  assert.ok(readers.includes('palettes'), 'the palettes stage reads the skin art at the pinned commit');
  const last = Math.max(...movers.map(name => order.lastIndexOf(name)));
  for (const reader of readers) {
    assert.ok(order.indexOf(reader) > last, `${reader} reads the art at the pinned asset commit, but ${order[last]} moves the pins after it`);
  }
});

test('every script a refresh stage runs reads the game-data mirrors at the run\'s pinned commit', () => {
  const scripts = refreshScripts();
  // What the walk has to find: stage scripts, npm and shell indirection, local imports.
  for (const file of ['scripts/sync/sync-catalogue.mjs', 'scripts/sync/sync-content-inventory.mjs', 'scripts/build/build-free-rewards.mjs',
    'scripts/build/build-operator-voices.mjs', 'scripts/sync/publish-catalogue-assets.py', 'scripts/imports/import-reward-icons.py', 'scripts/imports/quarantine.py']) {
    assert.ok(scripts.includes(file), `${file} is part of the refresh`);
  }
  const host = /raw\.githubusercontent\.com|api\.github\.com\/repos/;
  for (const file of scripts.filter(file => file !== 'scripts/content/pin-upstream.mjs')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { repository } of MIRRORS as { repository: string }[]) {
      const moving = new RegExp(`(?:raw\\.githubusercontent\\.com|api\\.github\\.com/repos)/${repository.replace(/[.]/g, '\\.')}/(?:commits/)?(?:main|master)\\b`);
      assert.doesNotMatch(text, moving, `${file} reads ${repository} at its moving branch; ${PINNED_ADVICE}`);
      if (text.includes(repository) && host.test(text)) {
        assert.match(text, /pinnedRef\(|pinnedCommit\(|ARKPEDIA_PIN_/, `${file} reads ${repository} without the commit this run pinned; ${PINNED_ADVICE}`);
      }
    }
  }
});

/*
 * The CN tables come from ONE mirror at ONE commit per run: the source the upstream-cn stage
 * settled on (scripts/content/cn-tables.mjs), which may be neither Kengxxiao nor its pin. A
 * stage reads them from the checkout that stage composed, or by URL from cnTableUrl() or
 * cnTables(). One that names a CN mirror's tables itself -- at that mirror's pin, as the check
 * above asks of any other mirror -- reads another mirror, or another commit, than the rest of
 * the run on a day upstream-cn fell back, or fails against the mirror that is down. Only the two
 * scripts that settle the source may name it.
 */
const CN_TABLE_ADVICE = 'build a CN table\'s URL from cnTableUrl() or cnTables() (Python and shell: node scripts/content/pin-upstream.mjs cn-table-url <file>), or read it from .cache/upstream/cn-resource/gamedata';
const PINNED_ADVICE = `for a CN table, ${CN_TABLE_ADVICE}; for any other file, build the URL from pinnedRef() (Python: the ARKPEDIA_PIN_ variable)`;
const CN_TABLE_SETTLERS = ['scripts/content/pin-upstream.mjs', 'scripts/content/cn-tables.mjs'];
/** How a script's text reads a CN table other than from the source the run settled on. */
function cnTablesNotSettled(text: string): string[] {
  const problems: string[] = [];
  // Kengxxiao serves the refresh nothing but CN tables: naming it, or its pin, is reading them there.
  if (/Kengxxiao\/ArknightsGameData|KENGXXIAO_ARKNIGHTSGAMEDATA/i.test(text)) problems.push('names Kengxxiao/ArknightsGameData, which serves the refresh nothing but CN tables');
  // Which sources there are, and where each is checked out, is cn-tables.mjs's to know.
  if (/\bCN_TABLE_SOURCES\b|\bTABLE_CHECKOUTS\b|\.cache\/upstream\/cn-tables/.test(text)) problems.push('reads the CN table sources or their checkouts, not the tables the run settled on');
  // yuanyan3060's art (item/, map/) at its pin is right; anything under its gamedata/ is a CN table.
  if (/yuanyan3060\/ArknightsGameResource(?:\$\{[^}]*\}|\{[^}]*\}|[\w.@/-])*?\/gamedata\b/i.test(text)) problems.push('reads a CN table from yuanyan3060/ArknightsGameResource by itself');
  // Explicit EN/JP/KR mirrors are regional clients; other gamedata folders must use the settled CN source.
  const url = /(?:raw\.githubusercontent\.com|api\.github\.com\/repos|cdn\.jsdelivr\.net\/gh|github\.com)\/(?:\$\{[^}]*\}|\{[^}]*\}|[^\s'"`{}])*/g;
  for (const [address] of text.matchAll(url)) {
    if (/(?<!\/en|\/en_US|\/jp|\/kr|\/ja_JP|\/ko_KR)\/gamedata(?=\/|$)/.test(address)) problems.push(`builds a URL to a CN table: ${address}`);
  }
  // The same through pin-upstream's raw-url command or rawUrl(), or a checkout of its own.
  for (const line of text.replace(/\\\n\s*/g, ' ').split('\n')) {
    if (/raw-url|rawUrl\(|upstream\.sh|upstream_sync/.test(line) && /(?:^|[\s'"`,])(?:zh_CN\/)?gamedata(?=[/\s'"`,]|$)/.test(line)) {
      problems.push(`reads a CN table at a mirror's pin: ${line.trim()}`);
    }
  }
  return problems;
}
test('no refresh script reads a CN table from one mirror or at its pin, only from the tables upstream-cn settled on', () => {
  const texts = [
    ...refreshScripts().filter(file => !CN_TABLE_SETTLERS.includes(file)).map(file => [file, fs.readFileSync(file, 'utf8')]),
    ...refreshStages().map(stage => [`stage ${stage.name}`, stage.command]),
  ];
  assert.ok(texts.some(([file]) => file === 'scripts/imports/import-reward-icons.py') && texts.some(([file]) => file === 'stage charwords'));
  const problems = texts.flatMap(([file, text]) => cnTablesNotSettled(text).map(problem => `${file} ${problem}; ${CN_TABLE_ADVICE}`));
  assert.deepEqual(problems, []);
});
test('the CN table check catches every way a script could read a CN table by itself, and passes art, Global and the settled source', () => {
  const pin = "${pinnedRef('yuanyan3060/ArknightsGameResource')}";
  const caught = [
    // The review's own mutation of sync-reward-names.mjs.
    `export const CN_TABLE = \`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/${pin}/gamedata/excel/item_table.json\`;`,
    "const url = `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/${pinnedRef('Kengxxiao/ArknightsGameData')}/zh_CN/gamedata/excel/${file}`;",
    "const ref = process.env.ARKPEDIA_PIN_KENGXXIAO_ARKNIGHTSGAMEDATA || 'master';",
    "const [primary] = CN_TABLE_SOURCES; const base = `https://raw.githubusercontent.com/${primary.repository}/${pinnedRef(primary.repository)}/${primary.folder}`;",
    "const REPO = 'yuanyan3060/ArknightsGameResource'; fetch(`https://raw.githubusercontent.com/${REPO}/${pinnedRef(REPO)}/gamedata/levels/obt/main/level_main_01-01.json`);",
    "RAW = f'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/{CN_REF}/gamedata/excel'",
    "RAW = f'https://raw.githubusercontent.com/{REPO}/{ref}/gamedata'",
    "const base = `https://cdn.jsdelivr.net/gh/${repo}@${ref}/zh_CN/gamedata/excel`;",
    'curl "$(node scripts/content/pin-upstream.mjs raw-url yuanyan3060/ArknightsGameResource gamedata/excel/item_table.json)"',
    "rawUrl(root, repository, 'gamedata/excel/item_table.json')",
    'bash scripts/lib/upstream.sh cn-own https://github.com/yuanyan3060/ArknightsGameResource.git main \\\n  gamedata/excel gamedata/levels',
    "const table = JSON.parse(fs.readFileSync('.cache/upstream/cn-tables-fallback/gamedata/excel/item_table.json'));",
  ];
  for (const text of caught) assert.ok(cnTablesNotSettled(text).length, `not caught: ${text}`);
  const passed = [
    "const SOURCE = `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/${pinnedRef('yuanyan3060/ArknightsGameResource')}/item`;",
    "ITEM_ART = f'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/{CN_REF}/item'",
    "const RAW = `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pinnedRef('ArknightsAssets/ArknightsGamedata')}/en/gamedata/excel`;",
    'curl "$(node scripts/content/pin-upstream.mjs raw-url PuppiizSunniiz/ArknightsGameData_YoStar en_US/gamedata/excel/charword_table.json)"',
    'bash scripts/lib/upstream.sh en-gamedata https://github.com/ArknightsAssets/ArknightsGamedata.git default \\\n  en/gamedata/excel en/gamedata/levels',
    "cn: cnTableUrl('excel/charword_table.json', env),",
    "const url = `https://raw.githubusercontent.com/${repo}/${revision}/${folder}/excel/${file}`;",
    "const CN = `${process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource'}/gamedata/excel`;",
    "RAW_CN = subprocess.run(['node', PIN_UPSTREAM, 'cn-table-url', 'excel'], capture_output=True, text=True).stdout.strip()",
  ];
  for (const text of passed) assert.deepEqual(cnTablesNotSettled(text), [], text);
});
test('the daily refresh runs every command as a uniquely named stage that needs only earlier ones', () => {
  const stages = refreshStages();
  const seen = new Set<string>();
  for (const stage of stages) {
    assert.ok(!seen.has(stage.name), `${stage.name} is named once`);
    for (const need of stage.needs) assert.ok(seen.has(need), `${stage.name} needs ${need}, which must run before it`);
    seen.add(stage.name);
  }
  // The pin comes first, so every later stage reads the same commits, and then the CN tables,
  // before the catalogue or anything else reads one (scripts/content/cn-tables.mjs).
  assert.deepEqual(stages.slice(0, 2).map(stage => [stage.name, stage.command]), [
    ['pin-upstream', 'node scripts/content/pin-upstream.mjs'], ['upstream-cn', 'node scripts/content/cn-tables.mjs']]);
  // Invariants include game tables, exact stage coverage after navigation filtering,
  // and the completeness gate. Every importer, wiki reader and downloader failing
  // costs its stage -- the CN art too, which only one mirror carries.
  assert.deepEqual(stages.filter(stage => stage.invariant).map(stage => stage.name), ['upstream-cn', 'upstream-en', 'stage-coverage', 'completeness']);
  assert.deepEqual(stages.find(stage => stage.name === 'stage-coverage')!.needs, ['stage-index']);
  const art = stages.find(stage => stage.name === 'upstream-cn-art')!;
  assert.deepEqual([art.invariant, art.command], [false, 'node scripts/content/cn-tables.mjs art']);
  assert.ok(stages.find(stage => stage.name === 'item-icons')!.needs.includes('upstream-cn-art'), 'item-icons keeps its records on a day without the art');
  // Not cc-stages: skipped, it would take the whole stage build back with it (--output), and
  // it needs the art only for renders the image repository does not publish yet.
  assert.ok(!stages.find(stage => stage.name === 'cc-stages')!.needs.includes('upstream-cn-art'));
  // Run on its own, the stage-data refresh settles the CN tables itself, right after its pin.
  assert.match(fs.readFileSync('scripts/sync/refresh-stage-data.sh', 'utf8'),
    /stage pin-upstream -- node scripts\/content\/pin-upstream\.mjs\n(?:\s*#[^\n]*\n)*\s*stage upstream-cn --invariant --timeout-minutes \d+ -- node scripts\/content\/cn-tables\.mjs\nfi\n/);
  assert.equal(stages.at(-1)!.name, 'completeness');
  for (const script of ['sync-catalogue.mjs', 'import_ra_maps.py', 'import-nation-marks.py', 'sync-recurring-banners.mjs', 'sync-kernel-pool.mjs', 'import-reward-icons.py', 'import-item-icons.mjs', 'charword_table.json']) {
    assert.ok(stages.some(stage => stage.command.includes(script) && !stage.invariant), `${script} runs in a stage that is not an invariant`);
  }
  // The three steps that finish the stage build's own files in place say so, so that one
  // failing takes the build back with it instead of publishing its raw output (the index
  // with every variant and every excluded mode, CC# labels, RA stages without their maps).
  const of = (name: string) => stages.find(stage => stage.name === name)!;
  for (const [name, output] of [['stage-index', 'public/stages-index.json'], ['cc-stages', 'data/stages-content.json'], ['ra-maps', 'data/stages']]) {
    assert.ok(of(name).needs.includes('stage-dataset') && of(name).outputs.includes(output), `${name} --needs stage-dataset --output ${output}`);
  }
  // The completeness gate's holds are true whether or not an invariant stops the release.
  assert.deepEqual(of('completeness').keep, ['data/quarantine.json']);
  // No command of the import runs outside a stage, but the baseline completeness compares with.
  const run = fs.readFileSync('scripts/content/run-imports.sh', 'utf8').replace(/\\\n\s*/g, ' ').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const plumbing = /^(#!\/usr\/bin\/env bash|set -euo pipefail|node scripts\/content\/check-completeness\.mjs --record-baseline|stage\(\) \{.*\}|node scripts\/content\/run-stage\.mjs begin|trap .*|supplemental_charwords=.*|supplement=.*|if \[ ! -s "\$supplement" \].*|bash scripts\/sync\/refresh-stage-data\.sh)$/;
  for (const line of run) assert.ok(line.startsWith('stage ') || plumbing.test(line), `outside a stage: ${line}`);
});
