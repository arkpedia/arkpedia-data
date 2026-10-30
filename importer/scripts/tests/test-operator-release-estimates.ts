import assert from 'node:assert/strict';
import test from 'node:test';
import { isDebutAvailable, isOperatorReleased, operatorReleaseLabel, releaseMarker } from '../../lib/operators/operatorAvailability';

test('a calendar forecast never becomes confirmed availability as the clock advances', () => {
  const operator = { releaseEstimate: '2026-11-16', isFuture: true };
  assert.equal(operatorReleaseLabel(operator, Date.parse('2026-11-10T07:00:00Z')), 'Est. in 6 days');
  for (const now of ['2026-11-16T15:00:00Z', '2026-11-18T15:00:00Z']) {
    assert.equal(isDebutAvailable(operator, Date.parse(now)), false);
    assert.equal(isOperatorReleased(operator, Date.parse(now)), false);
  }
  assert.deepEqual(releaseMarker(operator), { releasedAt: null, isFuture: true });
});

test('an official timestamp takes precedence over a calendar forecast', () => {
  const opening = Date.parse('2026-11-16T15:00:00Z');
  const operator = { releaseEstimate: '2026-11-17', releaseAt: '2026-11-16T15:00:00Z', isFuture: true };
  assert.equal(isOperatorReleased(operator, opening - 1), false);
  assert.equal(isOperatorReleased(operator, opening), true);
  assert.equal(isDebutAvailable(operator, opening), true);
});
