import fs from 'node:fs';
import path from 'node:path';
import { stripRichText } from '../lib/gametext.mjs';

import { pathToFileURL } from 'node:url';

export function reconcileBaseRosters({ operators, constants, characters, previous }) {
const terms = constants.termDescriptionDict;
const rosters = { ...previous };
const byId = new Map();
const byAlias = new Map();
for (const op of operators) {
  byId.set(op.internalName, op);
  for (const alias of [op.name, ...(op.aliases ?? [])]) byAlias.set(alias, op.name);
}
const byGameName = new Map(Object.entries(characters).filter(([id]) => byId.has(id)).map(([id, char]) => [char.name, byId.get(id).name]));
const keys = {
  A1_DETACHMENT: 'cc.g.A1', ABYSSAL_HUNTERS: 'cc.g.abyssal', BLACKSTEEL_WORLDWIDE: 'cc.g.bs',
  DURIN: 'cc.tag.durin', ELITE_OPERATOR: 'cc.g.elite', GLASGOW: 'cc.g.glasgow',
  KARLAN_TRADE: 'cc.g.karlan', KNIGHTS: 'cc.tag.knight', LATERANO: 'cc.g.laterano',
  LUNGMEN_GUARD_DEPARTMENT: 'cc.g.lgd', MINOS: 'cc.g.minos', OPERATION_PLATFORM: 'cc.tag.op',
  PINUS_SYLVESTRIS: 'cc.g.psk', RHINE_LAB: 'cc.g.rh', SAMI: 'cc.g.sm', SARGON: 'cc.g.sargon',
  SOUBO_ADVENTURERS: 'cc.tag.mh', SUI: 'cc.g.sui', TEAM_RAINBOW: 'cc.g.R6',
  URSUS_STUDENT_SELF_GOVERNING_GROUP: 'cc.g.ussg', SIRACUSA: 'cc.g.siracusa',
  R6_DEFENDING: 'cc.g.Defence', R6_ATTACKING: 'cc.g.Attack', LAIOS_PARTY: 'cc.tag.dungeon',
  BUBBLE_KINGDOM_HUNTERS: 'cc.tag.mh2', SEES: 'cc.tag.sees',
};
for (const [key, term] of Object.entries(keys)) {
  const definition = stripRichText(terms[term]?.description);
  const names = definition.split('\n').slice(1).join('').split('、').map(n => n.trim()).filter(Boolean);
  if (!names.length) throw new Error(`No explicit members for ${term}`);
  rosters[key] = names.map(name => {
    const match = byGameName.get(name) ?? byAlias.get(name) ?? (name === 'GALLUS²' ? byAlias.get('Gallus²') : null);
    if (!match) throw new Error(`${term}: ${name} has no operator record`);
    return match;
  });
}
rosters.WANDERING_MEDIC = [...byId.values()].filter(op => op.branch === 'Wandering Medic').map(op => op.name);
rosters.ALTERNATE_OPERATOR = Object.entries(characters).filter(([id, char]) => char.isSpChar && byId.has(id) && !/^Amiya \(/.test(byId.get(id).name)).map(([id]) => byId.get(id).name);
for (const [key, names] of Object.entries(rosters)) for (const name of names) if (!byAlias.has(name)) throw new Error(`${key}: nonexistent operator ${name}`);
return rosters;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [constantsPath, charactersPath] = process.argv.slice(2);
  if (!constantsPath || !charactersPath) throw new Error('Provide CN gamedata_const and character_table paths');
  const operators = fs.readdirSync('data').filter(name => /^operators-.*star$/.test(name)).flatMap(folder => fs.readdirSync(path.join('data', folder)).filter(f => f.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join('data', folder, file), 'utf8'))));
  const rosters = reconcileBaseRosters({ operators, constants: JSON.parse(fs.readFileSync(constantsPath)), characters: JSON.parse(fs.readFileSync(charactersPath)), previous: JSON.parse(fs.readFileSync('data/base-group-rosters.json')) });
  fs.writeFileSync('data/base-group-rosters.json', JSON.stringify(rosters, null, 2) + '\n');
  console.log(`Updated ${Object.keys(rosters).length} source rosters.`);
}
