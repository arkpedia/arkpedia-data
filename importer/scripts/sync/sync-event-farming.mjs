import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Repeatable tier-three material drops from time-limited Global stages only. */
export function buildEventFarming(stages, items) {
  const drops = [];
  for (const [id, stage] of Object.entries(stages.stages)) {
    if (stage.stageType !== 'ACTIVITY' || stage.difficulty !== 'NORMAL' || !stage.canBattleReplay || stage.isStoryOnly) continue;
    const window = stages.stageValidInfo?.[id];
    if (!window || !(window.startTs > 0 && window.endTs > window.startTs)) continue;
    for (const drop of stage.stageDropInfo?.displayRewards ?? []) {
      const item = items.items[drop.id];
      if (drop.dropType !== 'NORMAL' || drop.type !== 'MATERIAL' || item?.rarity !== 'TIER_3' || item.classifyType !== 'MATERIAL') continue;
      drops.push({ stageId: id, stage: stage.code, itemId: drop.id, material: item.name,
        startAt: new Date(window.startTs * 1000).toISOString(),
        // Game table endTs is inclusive. App windows use an exclusive end.
        endAt: new Date((window.endTs + 1) * 1000).toISOString() });
    }
  }
  return drops.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.stage.localeCompare(b.stage));
}
export function syncEventFarming(directory) {
  const read = file => fs.readFileSync(path.join(directory, file));
  const stageBytes = read('stage_table.json'), itemBytes = read('item_table.json');
  const drops = buildEventFarming(JSON.parse(stageBytes), JSON.parse(itemBytes));
  if (!drops.length) throw new Error('No event farming drops: source is empty or changed schema');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const output = { source: { region: 'Global', stageSha256: hash(stageBytes), itemSha256: hash(itemBytes) }, drops };
  fs.writeFileSync('data/event-farming.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Updated ${drops.length} timed stage/material pairs from Global game data`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncEventFarming(process.argv[2] || '.cache/upstream/en-gamedata/en/gamedata/excel');
