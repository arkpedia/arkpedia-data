import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export function baseWorkshopRecipes(building, items) {
const categories = { F_BUILDING: 'Building materials', F_EVOLVE: 'Elite materials', F_SKILL: 'Skill Summaries', F_ASC: 'Chips' };
const recipes = Object.values(building.workshopFormulas).map(v => {
  if (!categories[v.formulaType]) throw new Error(`Unknown formula type ${v.formulaType}`);
  return { id: v.formulaId, name: items[v.itemId]?.name ?? v.itemId, category: categories[v.formulaType], morale: v.apCost / 360000, lmd: v.goldCost, baseChance: v.extraOutcomeRate, level: Math.max(...v.requireRooms.filter(r => r.roomId === 'WORKSHOP').map(r => r.roomLevel), 1) };
});
return recipes;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [buildingFile, itemFile] = process.argv.slice(2);
  const recipes = baseWorkshopRecipes(JSON.parse(fs.readFileSync(buildingFile)), JSON.parse(fs.readFileSync(itemFile)).items);
  fs.writeFileSync('data/base-workshop-recipes.json', JSON.stringify(recipes, null, 2) + '\n');
  console.log(`${recipes.length} source workshop recipes`);
}
