import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The updater also runs directly in the refresh workflow.
import { buildRecruitmentPool, validateLocalOperators } from '../sync/sync-recruitment.mjs';

// That the site's two recruitment tools read the roster this writes is held by
// arkpedia-app's own scripts/tests/test-recruitment-pool.ts.

const characters = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`char_${i + 1}`, {
  name: `Recruit ${i + 1}`, rarity: `TIER_${i + 1}`, profession: 'CASTER', position: 'RANGED', tagList: ['DPS'],
}]));
const gacha = { gachaTags: [{ tagName: 'DPS' }], recruitDetail: 'Rules\n' + Array.from({ length: 6 }, (_, i) => `${'★'.repeat(i + 1)}\n<@rc.eml>Recruit ${i + 1}</>\n--------------------`).join('\n') };

test('the importer reads only explicitly listed recruits and resolves harmless name quotes by ID', () => {
  const extra = { ...characters, char_extra: { ...characters.char_4, name: 'Gallus²' }, char_1: { ...characters.char_1, name: "'Recruit 1'" } };
  const pool = buildRecruitmentPool(gacha, extra);
  assert.equal(pool.length, 6);
  assert.equal(pool[0].id, 'char_1');
  assert.ok(pool.every((operator: { id: string }) => operator.id !== 'char_extra'));
});

test('incomplete, duplicate, ambiguous or unrecognized recruitment data is rejected', () => {
  assert.throws(() => buildRecruitmentPool({ ...gacha, recruitDetail: '★\nRecruit 1' }, characters), /Incomplete/);
  assert.throws(() => buildRecruitmentPool({ ...gacha, recruitDetail: gacha.recruitDetail.replace('Recruit 1', 'Unknown') }, characters), /Unresolved/);
  assert.throws(() => buildRecruitmentPool({ ...gacha, recruitDetail: gacha.recruitDetail.replace('Recruit 1', 'Recruit 1 / Recruit 1') }, characters), /Duplicate/);
  assert.throws(() => buildRecruitmentPool(gacha, { ...characters, char_duplicate: characters.char_1 }), /ambiguous/);
  assert.throws(() => buildRecruitmentPool(gacha, { ...characters, char_1: { ...characters.char_1, tagList: ['Unknown tag'] } }), /Invalid recruitment fields/);
  assert.throws(() => buildRecruitmentPool(gacha, { ...characters, char_1: { ...characters.char_1, rarity: 'TIER_6' } }), /Invalid recruitment fields/);
});

test('new recruits need complete local records and matching recruitment fields', () => {
  const pool = buildRecruitmentPool(gacha, characters);
  const local = pool.map((operator: { id: string }) => ({ ...operator, internalName: operator.id }));
  assert.doesNotThrow(() => validateLocalOperators(pool, local));
  assert.throws(() => validateLocalOperators(pool, local.slice(1)), /Missing/);
  assert.throws(() => validateLocalOperators(pool, [...local, local[0]]), /duplicate/);
  assert.throws(() => validateLocalOperators(pool, [{ ...local[0], tags: ['Summon'] }, ...local.slice(1)]), /differs/);
});
