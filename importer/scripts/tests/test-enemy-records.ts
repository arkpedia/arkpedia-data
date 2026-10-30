import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Plain Node stage-pipeline helper.
import { enemySlugs } from '../stage-pipeline/lib/level.mjs';

// build-enemy-records.mjs runs its whole build on import, so it is run as the stage
// refresh runs it: ARKPEDIA_ROOT points its output at a scratch tree and ARKPEDIA_EN
// its input at made-up tables.
const handbook = {
  enemy_1001_alpha: { name: 'Alpha', enemyIndex: 'A1', enemyLevel: 'NORMAL', sortId: 1, hideInHandbook: false, description: 'First.', damageType: ['PHYSIC'], abilityList: [] },
  enemy_1003_new: { name: 'Newcomer', enemyIndex: 'N1', enemyLevel: 'ELITE', sortId: 3, hideInHandbook: false, description: '-', damageType: ['MAGIC'], abilityList: [] },
};
const database = {
  enemy_1001_alpha: [{ level: 0, enemyData: { attributes: { maxHp: { m_defined: true, m_value: 1200 }, atk: { m_defined: true, m_value: 300 } }, skills: [], talentBlackboard: [] } }],
};
const slugs: Map<string, string> = enemySlugs(handbook);
const oldEvent = { id: 'act1side', kind: 'event', name: 'Old Event', label: null, release_date: '2026-01-01' };
// A record whose handbook and database entries have since vanished, exactly as filed.
const gone = { slug: 'gone', id: 'enemy_1002_gone', name: 'Gone', index: 'G1', rank: 'Normal', sort: 2, hidden: false, icon: '/enemies-icons/Gone.webp',
  flavour_text: null, race: null, movement: 'Ground', attack_position: null, damage_type: [], abilities: [], levels: [] };

function tree(root: string) {
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  write('en/excel/enemy_handbook_table.json', { enemyData: handbook, levelInfoList: [], raceData: {} });
  write('en/levels/enemydata/enemy_database.json', database);
  write('data/enemies/Old Event.json', { schema_version: 3, content: oldEvent, enemies: [
    { slug: slugs.get('enemy_1001_alpha'), id: 'enemy_1001_alpha', name: 'Alpha (old)', sort: 1, icon: '/enemies-icons/Alpha.webp' }, gone] });
  // Its content left the stage dataset, and two reruns of the same name could have taken its id.
  write('data/enemies/Twice Rerun.json', { schema_version: 3, content: { id: 'act9side', kind: 'event', name: 'Twice Rerun', label: null }, enemies: [] });
  write('data/enemy_appearances.json', [{ kind: 'event', id: 'act1side', label: null, name: 'Old Event', enemy_count: 1, enemies: [slugs.get('enemy_1001_alpha')] }]);
  write('data/stages-content.json', { act1side: oldEvent,
    act9sre: { id: 'act9sre', kind: 'event', name: 'Twice Rerun', label: null }, act9sre2: { id: 'act9sre2', kind: 'event', name: 'Twice Rerun', label: null } });
  write('data/stages/s1.json', { slug: 's1', content: oldEvent, enemies: { by_rank: { normal: [{ slug: slugs.get('enemy_1001_alpha') }], elite: [{ slug: slugs.get('enemy_1003_new') }] } } });
  write('public/stages-index.json', [{ slug: 's1' }]);
}

test('an enemy the tables stopped describing keeps its record, one with no database entry waits, and an ambiguous re-key is not made -- reported, never fatal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-enemies-'));
  try {
    tree(root);
    const run = spawnSync(process.execPath, [path.resolve('scripts/build/build-enemy-records.mjs')], { cwd: root, encoding: 'utf8',
      env: { ...process.env, ARKPEDIA_ROOT: root, ARKPEDIA_EN: path.join(root, 'en'), ARKPEDIA_NOW: '2026-09-23T20:00:00Z' } });
    assert.equal(run.status, 0, run.stderr);
    const bundle = JSON.parse(fs.readFileSync(path.join(root, 'data/enemies/Old Event.json'), 'utf8'));
    // Alpha is rebuilt from the tables; Gone is kept exactly as filed; Newcomer gets no record yet.
    assert.deepEqual(bundle.enemies.map((e: { id: string; name: string }) => [e.id, e.name]), [['enemy_1001_alpha', 'Alpha'], ['enemy_1002_gone', 'Gone']]);
    assert.equal(bundle.enemies[0].levels[0].stats.hp, 1200);
    assert.deepEqual(bundle.enemies[1], gone);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/enemies/Twice Rerun.json'), 'utf8')).content.id, 'act9side');
    const { entries } = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8'));
    assert.deepEqual(entries.map((e: { key: string; stage: string; action: string }) => [e.key, e.stage, e.action]), [
      ['enemy-bundle:act9side', 'enemies', 'kept-previous'],
      ['enemy:enemy_1002_gone', 'enemies', 'kept-previous'],
      ['enemy:enemy_1003_new', 'enemies', 'omitted-new'],
    ]);
    assert.match(entries[0].reason, /2 contents of the same kind and name could have taken its place \(act9sre, act9sre2\)/);
    assert.match(entries[1].reason, /no enemy_handbook_table or enemy_database entry; its previous record is kept/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
