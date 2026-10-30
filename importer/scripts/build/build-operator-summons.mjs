import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const SUMMON_STATS = ['maxHp', 'atk', 'def', 'magicResistance', 'cost', 'blockCnt', 'baseAttackTime', 'respawnTime'];
export function operatorSummons(characters) {
  const output = {};
  for (const [id, op] of Object.entries(characters)) {
    if (!id.startsWith('char_')) continue;
    const tokens = Object.entries(op.displayTokenDict ?? {}).filter(([, shown]) => shown).map(([id]) => id);
    // Some display dictionaries include abstract prefab keys with no character record.
    // Only concrete tokens have level stats; their numbered variants are listed separately.
    const summons = tokens.filter(tokenId => characters[tokenId]?.phases?.length).map(tokenId => {
      const token = characters[tokenId];
      if (!token?.phases?.length) throw new Error(`Missing summon ${tokenId} for ${id}`);
      return { id: tokenId, name: token.name, phases: token.phases.map(phase => ({ maxLevel: phase.maxLevel,
        frames: phase.attributesKeyFrames.map(frame => ({ level: frame.level, stats: Object.fromEntries(SUMMON_STATS.map(key => [key, frame.data[key]])) })) })) };
    });
    if (summons.length) output[id] = summons;
  }
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const en = process.env.ARKPEDIA_EN ?? path.join(process.cwd(), '.cache/upstream/en-gamedata/en/gamedata');
  const global = JSON.parse(fs.readFileSync(path.join(en, 'excel/character_table.json'), 'utf8'));
  const cnPath = process.env.ARKPEDIA_CN_CHARACTERS ?? path.join(process.cwd(), '.cache/upstream/cn-resource/gamedata/excel/character_table.json');
  const cn = fs.existsSync(cnPath) ? JSON.parse(fs.readFileSync(cnPath, 'utf8')) : {};
  const characters = { ...cn, ...global };
  // A preview-only CN token may be named in Global before its stats arrive there.
  for (const [id, op] of Object.entries(characters)) if (!op.phases?.length && cn[id]?.phases?.length) characters[id] = cn[id];
  const summons = operatorSummons(characters);
  fs.writeFileSync('data/operator-summons.json', JSON.stringify(summons, null, 2) + '\n');
  console.log(`${Object.keys(summons).length} operators with summon stats`);
}
