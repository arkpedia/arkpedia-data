import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { buildProfileAvatars } from '../build/build-profile-avatars.mjs';

test('the avatar catalogue offers only small catalogue icons, sorted, and files base-skill icons by the records\' facility', () => {
  const files = ['six-star-icons/Surtr - Base.webp', 'skin-originals/x.png', 'base-skill-icons/Surtr - Pyroclast.webp', 'base-skill-icons/Lone - Unknown.webp',
    'base-skill-icons/Mixed - Other.webp', 'item-icons/Orirock.png', 'posters/event.webp', 'item-icons/nested/x.webp'];
  const operators = [
    { name: 'Surtr', baseSkills: [{ name: 'Pyroclast', facility: 'Factory' }, { name: 'Other', facility: 'Power Plant' }] },
    { name: 'Lone', baseSkills: [{ name: 'Something', facility: 'Trading Post' }] },
    { name: 'Mixed', baseSkills: [{ name: 'A', facility: 'Factory' }, { name: 'B', facility: 'Office' }] },
  ];
  const avatars = buildProfileAvatars({ files, operators });
  assert.equal(avatars.version, 1);
  assert.deepEqual(avatars.icons, ['base-skill-icons/Lone - Unknown.webp', 'base-skill-icons/Mixed - Other.webp', 'base-skill-icons/Surtr - Pyroclast.webp', 'item-icons/Orirock.png', 'six-star-icons/Surtr - Base.webp']);
  // By the skill's name first; else the operator's only facility; else the catch-all.
  assert.deepEqual(avatars.facilities, { 'base-skill-icons/Lone - Unknown.webp': 'Trading Post', 'base-skill-icons/Mixed - Other.webp': 'Other base skills', 'base-skill-icons/Surtr - Pyroclast.webp': 'Factory' });
});

test('the import builds the catalogue after the last stage that rewrites the asset index', () => {
  const run = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  const at = (name: string) => run.search(new RegExp(`^stage ${name} `, 'm'));
  assert.ok(at('profile-avatars') > at('staged-art') && at('staged-art') > 0, 'after staged-art, whose assets:update rewrites data/assets/public-asset-index.json');
});
