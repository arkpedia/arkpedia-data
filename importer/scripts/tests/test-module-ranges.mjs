import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleAttackRange, moduleTileMechanics } from '../sync/sync-module-ranges.mjs';

const rangeId = 'test-grid';
const ranges = { [rangeId]: { grids: [{ row: 0, col: 0 }, { row: 0, col: -1 }, { row: 1, col: 0 }] } };
const grid = { cols: 2, rows: 2, opCell: [1, 2], rangeCells: [[1, 1], [2, 2]] };
const phase = (talent, part = {}) => ({
  parts: [{ addOrOverrideTalentDataBundle: { candidates: [talent] }, ...part }],
});

test('visible game range replaces normal range even when the talent itself is hidden', () => {
  const source = phase({ rangeId, displayRangeId: true, isHideTalent: true });
  assert.deepEqual(moduleAttackRange(source, ranges), { grid });
  assert.deepEqual(moduleTileMechanics(source, ranges), []);
});

test('melee redeployment decodes the blackboard shape without an operator-specific lookup', () => {
  const source = phase({ blackboard: [
    { key: 'ignore_build_type_target', value: 1 },
    { key: 'ignore_build_type_target_range', valueStr: rangeId },
  ] });
  assert.deepEqual(moduleTileMechanics(source, ranges), [{ kind: 'redeployment', grid }]);
  assert.equal(moduleAttackRange(source, ranges), undefined);
});

test('named tile effects use their grid and mode-specific areas stay scoped to gameplay text', () => {
  const talent = { name: 'Test talent', rangeId, description: 'Allies in adjacent tiles gain DEF.' };
  assert.deepEqual(moduleTileMechanics(phase(talent), ranges), [{ kind: 'effect', name: 'Test talent', grid }]);
  assert.deepEqual(moduleTileMechanics(phase(talent, { validInGameTag: 'roguelike' }), ranges), []);
  assert.deepEqual(moduleTileMechanics(phase({ ...talent, description: 'Gain DEF.' }), ranges), []);
});
