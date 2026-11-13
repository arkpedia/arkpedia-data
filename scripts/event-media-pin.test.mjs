import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withEventMediaPin } from './event-media-pin.mjs';

const revision = '1'.repeat(40);
test('adds only the fixed animation repository without changing approved content pins', () => {
  const pins = [{ repository: 'arkpedia-data', revision: '2'.repeat(40) }];
  const result = withEventMediaPin(pins, revision);
  assert.deepEqual(result, [...pins, { repository: 'arkpedia-l2d-assets', revision }]);
  assert.equal(pins.length, 1);
  assert.equal(withEventMediaPin(result, revision), result);
});
test('rejects branches, short SHAs, URLs and missing revisions', () => {
  for (const value of [undefined, '', 'main', '123abcd', 'https://example.com', 'A'.repeat(40), revision + '\n']) {
    assert.throws(() => withEventMediaPin([], value), /full animation repository commit/);
  }
  assert.throws(() => withEventMediaPin({}, revision), /immutable source pins/);
});
test('the preserved CLI works outside the selected content checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'event-media-pin-'));
  try {
    const file = join(dir, 'pins.json'); await writeFile(file, '[]');
    execFileSync(process.execPath, [fileURLToPath(new URL('./event-media-pin.mjs', import.meta.url)), file], {
      cwd: dir, env: { ...process.env, ANIMATION_REVISION: revision },
    });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [{ repository: 'arkpedia-l2d-assets', revision }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
