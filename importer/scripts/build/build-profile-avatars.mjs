#!/usr/bin/env node
/**
 * Writes public/profile-avatars.json: the icons a reader may choose as their profile avatar, and
 * the base facility each base-skill icon belongs to (for the picker's grouping). The site fetches
 * it from the live release when the picker opens and checks a stored avatar against it before it
 * becomes a URL (arkpedia-app lib/account/profileAvatar.ts), so a new icon is offered the night
 * its art is published.
 *
 *   node scripts/build/build-profile-avatars.mjs
 *
 * Only small catalogue icons from the published asset index (data/assets/public-asset-index.json):
 * no full portraits, outfits, posters or user URLs. A facility comes from the operator records'
 * base skills, never from an icon's colour.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ICON_FOLDERS = /^(?:[a-z]+-star-icons|enemies-icons|npc-icons|faction-icons|alliance-icons|nation-marks|essential-icons|stat-icons|enemy-stat-icons|class-icons|branch-icons|material-icons|item-icons|skill-icons|base-skill-icons|profile-avatars|profile-ui)\/[^/]+\.(?:webp|png)$/;
const normalise = value => value.normalize('NFKC').replace(/Replaces.*$/, '').replace(/['’“”"\s._-]/g, '').toLowerCase();

export function buildProfileAvatars({ files, operators }) {
  const icons = files.filter(file => ICON_FOLDERS.test(file)).sort();
  const skills = new Map(), single = new Map();
  for (const op of operators) {
    const facilities = new Set((op.baseSkills ?? []).map(skill => skill.facility).filter(Boolean));
    single.set(normalise(op.name), facilities.size === 1 ? [...facilities][0] : null);
    for (const skill of op.baseSkills ?? []) {
      const name = (skill.rawName ?? skill.name ?? '').replace(/[\\/*?:"<>|]/g, '').trim();
      if (name && skill.facility) skills.set(normalise(`${op.name} - ${name}`), skill.facility);
    }
  }
  const facilities = Object.fromEntries(icons.filter(id => id.startsWith('base-skill-icons/')).map(id => {
    const name = id.slice('base-skill-icons/'.length).replace(/\.(webp|png)$/, '');
    return [id, skills.get(normalise(name)) ?? single.get(normalise(name.split(' - ')[0])) ?? 'Other base skills'];
  }));
  return { version: 1, icons, facilities };
}

function readOperators(root) {
  const operators = [];
  for (let rarity = 1; rarity <= 6; rarity++) {
    const folder = path.join(root, `data/operators-${rarity}star`);
    for (const file of readdirSync(folder).filter(name => name.endsWith('.json')).sort()) operators.push(JSON.parse(readFileSync(path.join(folder, file), 'utf8')));
  }
  return operators;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = JSON.parse(readFileSync('data/assets/public-asset-index.json', 'utf8')).files;
  const avatars = buildProfileAvatars({ files, operators: readOperators('.') });
  // A catalogue that lost most of its icons is a broken index, not a release to publish.
  if (avatars.icons.length < 1000) throw new Error(`Only ${avatars.icons.length} catalogue icons in the asset index; keeping the last list.`);
  writeFileSync('public/profile-avatars.json', `${JSON.stringify(avatars)}\n`);
  console.log(`Profile avatars: ${avatars.icons.length} icons, ${Object.keys(avatars.facilities).length} base-skill icons by facility.`);
}
