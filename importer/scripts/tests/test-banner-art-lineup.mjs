import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ACCEPT_DISTANCE, ACCEPT_MARGIN, acceptLineup, lineReader, matchName, nameArtUrl, readArtLineup } from '../sync/banner-art-lineup.mjs';
import { pinVariable } from '../content/pin-upstream.mjs';
import { readArtLineups } from '../sync/sync-recurring-banners.mjs';

// The name plates of 30 Global Standard banners as the client ships them
// (ArknightsAssets2 en, assets/dyn/[[en]]/ui/gacha/<pool>/name1-5.png, losslessly
// recompressed), the lineups the wiki recorded for 29 of them, and the 5- and 6-star
// roster as it was then. The roster is frozen so a future operator whose name is close to
// one of these cannot fail this test; in a refresh it only holds a read back.
const FIXTURES = path.resolve('scripts/tests/fixtures/banner-art');
const { roster: rosterRows, lineups } = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'known.json'), 'utf8'));
const roster = new Map(rosterRows);
const plate = (pool) => async (slot) => fs.readFileSync(path.join(FIXTURES, pool.toLowerCase(), `name${slot}.png`));
const sorted = (names) => [...names].sort();

let reader;
const results = new Map();
before(async () => {
  reader = await lineReader();
  for (const pool of Object.keys(lineups)) results.set(pool, await readArtLineup({ fetchImage: plate(pool), roster, reader }));
});
after(() => reader?.close());

test('the art gives all 29 known Standard lineups, every name read right', () => {
  const known = Object.entries(lineups).filter(([, lineup]) => lineup.six_stars);
  assert.equal(known.length, 29);
  for (const [pool, lineup] of known) {
    const art = results.get(pool);
    assert.equal(art.problem, undefined, `${pool} (${lineup.name}): ${art.problem}`);
    assert.deepEqual([sorted(art.sixStars), sorted(art.fiveStars)], [sorted(lineup.six_stars), sorted(lineup.five_stars)], `${pool} (${lineup.name})`);
  }
});

test('a read is never taken for an operator the roster lacks', () => {
  // As for an operator with no record yet: with each plate's own name out of the roster,
  // its read must be held, not given to the next closest name ("Lin" is not Ling).
  let checked = 0;
  for (const art of results.values()) {
    for (const read of art.reads) {
      const others = [...roster].filter(([name, rarity]) => rarity === read.rarity && name !== read.match.name).map(([name]) => name);
      const next = matchName(read.text, others);
      assert.ok(next.distance > ACCEPT_DISTANCE || next.margin < ACCEPT_MARGIN, `"${read.text}" would be taken as ${next.name}`);
      checked++;
    }
  }
  assert.equal(checked, 150);
});

test('Standard Pool #177, which the wiki has no row for yet, reads with the 6-stars its home card shows', () => {
  // The home banner card (arts/ui/homebanners/gacha/picdouble_en_41_0_9.png) shows Hoederer
  // and Ho'olheyak; the 5-stars are pinned as read.
  const art = results.get('DOUBLE_EN_41_0_9');
  assert.deepEqual([art.sixStars, art.fiveStars], [['Hoederer', "Ho'olheyak"], ['Lucilla', 'Tecno', 'Almond']]);
});

test('a lineup is taken only when every plate reads clearly as five different operators', () => {
  const read = (slot, rarity, name, distance = 0, margin = 0.5) => ({ slot, rarity, text: name, match: { name, distance, margin } });
  const clean = [read(1, 6, 'Six A'), read(2, 6, 'Six B'), read(3, 5, 'Five A'), read(4, 5, 'Five B'), read(5, 5, 'Five C')];
  assert.deepEqual(acceptLineup(clean), { sixStars: ['Six A', 'Six B'], fiveStars: ['Five A', 'Five B', 'Five C'] });
  const far = clean.with(2, read(3, 5, 'Five A', 0.25));
  assert.match(acceptLineup(far).problem, /^the banner art's name 3 reads "Five A", closest to Five A \(distance 0\.25, margin 0\.50\), which is not clearly one 5-star operator$/);
  assert.match(acceptLineup(clean.with(4, read(5, 5, 'Five C', 0, 0.2))).problem, /name 5 reads/);
  assert.match(acceptLineup(clean.with(4, read(5, 5, 'Five A'))).problem, /^the banner art's names read as Six A, Six B, Five A, Five B, Five A, which repeats an operator$/);
  assert.match(acceptLineup(clean.with(0, { slot: 1, rarity: 6, text: '', match: null })).problem, /name 1 reads "", which is not clearly one 6-star/);
});

test('the sync reads the plates at the pinned commit, and tells art not out yet from art it cannot download', async () => {
  const variable = pinVariable('ArknightsAssets/ArknightsAssets2'), saved = process.env[variable];
  process.env[variable] = 'a'.repeat(40);
  try {
    assert.equal(nameArtUrl('DOUBLE_EN_41_0_9', 2), `https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/${'a'.repeat(40)}/assets/dyn/%5B%5Ben%5D%5D/ui/gacha/double_en_41_0_9/name2.png`);
    const asked = [];
    const art = await readArtLineups(['DOUBLE_EN_41_0_9', 'NOT_OUT', 'DOWN'], roster, async (url) => {
      asked.push(url);
      if (url.includes('/double_en_41_0_9/')) return plate('DOUBLE_EN_41_0_9')(Number(url.at(-5)));
      if (url.includes('/not_out/') && url.endsWith('name5.png')) return null;
      if (url.includes('/not_out/')) return plate('DOUBLE_EN_41_0_9')(1);
      throw new Error(`${url}: 503`);
    });
    assert.ok(asked.every((url) => url.includes(`/ArknightsAssets2/${'a'.repeat(40)}/`)));
    assert.deepEqual(art.get('DOUBLE_EN_41_0_9'), { sixStars: ['Hoederer', "Ho'olheyak"], fiveStars: ['Lucilla', 'Tecno', 'Almond'] });
    assert.equal(art.get('NOT_OUT'), null);
    assert.deepEqual(art.get('DOWN'), { problem: 'its banner art could not be downloaded' });
  } finally {
    if (saved === undefined) delete process.env[variable]; else process.env[variable] = saved;
  }
});
