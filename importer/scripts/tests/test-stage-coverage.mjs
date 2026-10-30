import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStageCoverage } from '../stage-pipeline/lib/coverage.mjs';
const record = (id, content = 'act51side') => ({ id, slug: id, content: { id: content }, geometry: id });
const fixture = () => ({ stages: { old: {}, newest: {} }, records: [record('old'), record('newest')],
  index: [{ slug: 'old' }, { slug: 'newest' }], geometryExists: () => true });

test('exact source coverage catches one missing newest stage even among thousands of older stages', () => {
  const input = fixture();
  input.records.pop();
  assert.throws(() => assertStageCoverage(input), /Global stage_table row missing: newest/);
});
test('navigation exclusions preserve records and require exact index membership', () => {
  const input = fixture();
  input.records[1].content.id = 'excluded';
  input.index.pop();
  assert.equal(assertStageCoverage({ ...input, excluded: { excluded: {} } }).indexed, 1);
  assert.throws(() => assertStageCoverage(input), /stage missing from index/);
  assert.throws(() => assertStageCoverage({ ...fixture(), excluded: { act51side: {} } }), /excluded stage listed/);
});
test('story-only vignette rows remain in records but share the index builder exclusion', () => {
  const input = fixture(); input.records[1].stage_type = 'special_story'; input.index.pop();
  assert.equal(assertStageCoverage(input).indexed, 1);
});
test('broken map references, duplicate identities, orphan index entries and lost content fail', () => {
  assert.throws(() => assertStageCoverage({ ...fixture(), geometryExists: () => false }), /missing geometry/);
  const input = fixture(); input.records[1].slug = 'old';
  assert.throws(() => assertStageCoverage(input), /duplicate or empty/);
  const orphan = fixture(); orphan.index.push({ slug: 'ghost' });
  assert.throws(() => assertStageCoverage(orphan), /index has no record/);
  const unmapped = fixture(); unmapped.records[0].content = {};
  assert.throws(() => assertStageCoverage(unmapped), /no content/);
});
