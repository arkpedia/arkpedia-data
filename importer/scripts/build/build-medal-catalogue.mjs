/** Official EN medal descriptions and set membership, with already-published client icons. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildMedalCatalogue(table, published, geometry = {}) {
  if (!Array.isArray(table.medalList) || !table.medalList.length || !table.medalTypeData) throw new Error('The EN medal table is missing medals or categories.');
  const layouts = Object.assign({}, ...Object.values(geometry.bundles ?? {}).map(b => b.layouts ?? {}));
  const sizes = Object.assign({}, ...Object.values(geometry.bundles ?? {}).map(b => b.sizes ?? {}));
  const types = Object.values(table.medalTypeData).sort((a, b) => a.sortId - b.sortId);
  const medals = table.medalList.map(m => ({ id: m.medalId, name: m.medalName, type: m.medalType, rarity: m.rarity,
    description: m.description ?? '', requirement: m.getMethod ?? '', advanced: m.advancedMedal ?? null, origin: m.originMedal ?? null, ...(sizes[m.medalId] ? { size: sizes[m.medalId] } : {}),
    icon: published.has(`profile-medals/${m.medalId.toLowerCase()}.webp`) ? `/profile-medals/${m.medalId.toLowerCase()}.webp` : null }));
  const ids = new Set(medals.map(m => m.id));
  if (ids.size !== medals.length || medals.some(m => !m.id || !m.name || !m.type)) throw new Error('Invalid medal catalogue.');
  const sets = types.flatMap(type => (Array.isArray(type.groupData) ? type.groupData : []).map(g => ({ id: g.groupId, name: g.groupName,
    description: g.groupDesc ?? '', type: type.medalGroupId, medals: g.medalId, color: /^[a-fA-F0-9]{6}$/.test(g.groupBackColor) ? `#${g.groupBackColor}` : '#394b54',
    ...(layouts[g.groupId] && g.medalId.every(id => layouts[g.groupId].positions.some(p => p.id === id)) ? { layout: layouts[g.groupId] } : {}),
    background: published.has(`profile-medals/${g.groupId.toLowerCase()}-background.webp`) ? `/profile-medals/${g.groupId.toLowerCase()}-background.webp` : geometry.backgrounds?.[g.groupId] ?? null }))).reverse();
  if (sets.some(s => !Array.isArray(s.medals) || !s.medals.length || s.medals.some(id => !ids.has(id)))) throw new Error('A medal set references an unknown medal.');
  return { version: 1, medals, sets, categories: types.map(t => ({ id: t.medalGroupId, name: t.medalName })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.join(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata', 'en/gamedata/excel/medal_table.json');
  const catalogue = buildMedalCatalogue(JSON.parse(fs.readFileSync(source, 'utf8')), new Set(JSON.parse(fs.readFileSync('data/assets/external-asset-index.json', 'utf8')).files),
    fs.existsSync('data/medal-set-layouts.json') ? JSON.parse(fs.readFileSync('data/medal-set-layouts.json', 'utf8')) : {});
  fs.writeFileSync('public/medal-catalogue.json', `${JSON.stringify(catalogue)}\n`);
  console.log(`Medal catalogue: ${catalogue.medals.length} medals and ${catalogue.sets.length} sets.`);
}
