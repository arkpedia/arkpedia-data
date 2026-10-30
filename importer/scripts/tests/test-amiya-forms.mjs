import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepRefreshedModules } from '../lib/amiya-form-modules.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const STAGES = [1, 2, 3].map(n => ({ stage: `Stage ${n}`, attributesIncreased: [], effectLabel: null, effectText: `stage ${n}`,
  cost: [{ name: 'Module Data Block', quantity: n }] }));

/** A content root with just enough gamedata for build-amiya-forms.mjs to write the Guard. */
function root(existingGuard) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-amiya-forms-'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  };
  write('en/excel/char_patch_table.json', {
    infos: { char_002_amiya: { tmplIds: ['char_002_amiya', 'char_1001_amiya2'], default: 'char_002_amiya' } },
    patchChars: { char_1001_amiya2: { profession: 'WARRIOR', subProfessionId: 'artsfghter', position: 'MELEE', rarity: 'TIER_5',
      description: 'Deals Arts damage', tagList: [], phases: [{ rangeId: '1-1', attributesKeyFrames: [] }], skills: [], talents: [],
      potentialRanks: [], allSkillLvlup: [] } },
  });
  write('en/excel/skill_table.json', {});
  write('en/excel/item_table.json', { items: {} });
  write('en/excel/uniequip_table.json', {
    subProfDict: { artsfghter: { subProfessionName: 'Arts Fighter' } },
    equipDict: {
      uniequip_001_amiya2: { typeName1: 'ORIGINAL', typeName2: null, uniEquipName: "Amiya's Badge (Guard)" },
      uniequip_002_amiya2: { typeName1: 'AFT', typeName2: 'X', uniEquipName: 'Anger to be Tuned' },
    },
  });
  write('data/operators-5star/Amiya.json', { name: 'Amiya', internalName: 'char_002_amiya', rarity: 5, promotion: [] });
  write('data/skins.json', []);
  if (existingGuard) write('data/operators-5star/Amiya (Guard).json', existingGuard);
  return dir;
}

function build(dir) {
  const result = spawnSync('node', [path.join(REPO, 'scripts/build/build-amiya-forms.mjs')], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, ARKPEDIA_EN: path.join(dir, 'en') } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(dir, 'data/operators-5star/Amiya (Guard).json'), 'utf8'));
}

test('amiya-forms keeps the module stages the English refresh built, so their costs have somewhere to go', () => {
  // operator-english runs first and builds AFT-X's stages from the module tables; writing the
  // bare list over them held Amiya (Guard) and (Medic) in the quarantine every night (#59).
  const refreshed = { type: 'Upgrade', name: 'AFT-X: Anger to be Tuned', mission: ['Reach Elite 2'], stages: STAGES };
  const dir = root({ name: 'Amiya (Guard)', internalName: 'char_1001_amiya2', stats: { kept: true },
    modules: [{ type: 'Original', name: "Amiya's Badge (Guard)", stages: [] }, refreshed] });
  try {
    const record = build(dir);
    assert.deepEqual(record.modules, [{ type: 'Original', name: "Amiya's Badge (Guard)", stages: [] }, refreshed]);
    assert.deepEqual(record.stats, { kept: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('amiya-forms keeps the guides the form\'s record has, and gives a new form none of the Caster\'s', () => {
  // The guide-videos stage (scripts/sync/sync-guide-videos.mjs) adds a form's guide once and never
  // again: written over with [], it would be gone for good.
  const guides = [{ videoId: 'aaaaaaaaaaa', creator: 'Dokutah Shikikan' }];
  const kept = root({ name: 'Amiya (Guard)', internalName: 'char_1001_amiya2', guides });
  const fresh = root(null);
  try {
    assert.deepEqual(build(kept).guides, guides);
    assert.deepEqual(build(fresh).guides, []);
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('amiya-forms still writes the bare module list for a new form, or a record of another operator', () => {
  for (const existing of [null, { internalName: 'char_9999_other', modules: [{ type: 'Upgrade', name: 'AFT-X: Other', stages: STAGES }] }]) {
    const dir = root(existing);
    try {
      assert.deepEqual(build(dir).modules, [{ type: 'Original', name: "Amiya's Badge (Guard)", stages: [] },
        { type: 'Upgrade', name: 'AFT-X: Anger to be Tuned', stages: [] }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a refreshed module is matched by its code, never handed to another module or kept without stages', () => {
  const derived = [{ type: 'Upgrade', name: 'AFT-X: Anger to be Tuned', stages: [] }, { type: 'Upgrade', name: 'AFT-A: New', stages: [] }];
  const alpha = { type: 'Upgrade', name: 'AFT-α: New', stages: STAGES };
  assert.deepEqual(keepRefreshedModules(derived, [alpha]), [derived[0], alpha]);
  assert.deepEqual(keepRefreshedModules(derived, [{ type: 'Upgrade', name: 'AFT-X: Anger to be Tuned', stages: [] }]), derived);
  assert.deepEqual(keepRefreshedModules(derived, undefined), derived);
});
