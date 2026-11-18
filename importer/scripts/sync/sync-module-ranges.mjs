import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripRichText } from '../lib/gametext.mjs';

function cropRange(tiles) {
  const minRow = Math.min(0, ...tiles.map(tile => tile.row));
  const maxRow = Math.max(0, ...tiles.map(tile => tile.row));
  const minCol = Math.min(0, ...tiles.map(tile => tile.col));
  const maxCol = Math.max(0, ...tiles.map(tile => tile.col));
  return {
    cols: maxCol - minCol + 1,
    rows: maxRow - minRow + 1,
    opCell: [1 - minRow, 1 - minCol],
    rangeCells: tiles.filter(({ row, col }) => row !== 0 || col !== 0)
      .map(({ row, col }) => [row - minRow + 1, col - minCol + 1]),
  };
}

const tileArea = /\badjacent\b|\bnearby enemies\b|\bsurrounding (?:\d+ )?tiles\b|\b(?:deployed|directly) behind\b|\bwithin \d+ tiles around\b|周围(?:[0-9一二三四五六七八九十]+格|敌人)|相邻|身后/i;
const skillRangeChange = /when skill is active, [^.]*attack range expands|技能期间[^。]*攻击范围扩大/i;
const normalParts = phase => (phase?.parts ?? []).filter(part => !part.isToken && !part.validInGameTag && !part.validInMapTag);
const talentDescription = talent => stripRichText(talent.upgradeDescription || talent.description);

function getGrid(ranges, rangeId) {
  const tiles = ranges[rangeId]?.grids;
  if (!tiles?.length) throw new Error(`Missing module range ${rangeId}`);
  return cropRange(tiles);
}

export function moduleAttackRange(phase, ranges) {
  for (const part of normalParts(phase)) {
    for (const talent of part.addOrOverrideTalentDataBundle?.candidates ?? []) {
      if (talent.requiredPotentialRank || talent.tokenKey || !talent.rangeId) continue;
      // Hidden module talents can carry a visible replacement for the operator's range.
      // A regular talent's range can instead describe its own area of effect.
      const whileSkillActive = skillRangeChange.test(talentDescription(talent));
      if (!talent.displayRangeId && !whileSkillActive) continue;
      return { grid: getGrid(ranges, talent.rangeId), ...(whileSkillActive ? { whileSkillActive } : {}) };
    }
    if (part.target !== 'TRAIT') continue;
    for (const trait of part.overrideTraitDataBundle?.candidates ?? []) {
      if (trait.requiredPotentialRank || trait.tokenKey) continue;
      const forward = Array.isArray(trait.blackboard)
        ? trait.blackboard.find(stat => stat.key === 'ability_range_forward_extend')?.value
        : undefined;
      if (Number.isInteger(forward) && forward > 0) return { forward };
    }
  }
}

export function moduleTileMechanics(phase, ranges) {
  const areas = new Map();
  for (const part of normalParts(phase)) {
    for (const talent of part.addOrOverrideTalentDataBundle?.candidates ?? []) {
      if (talent.requiredPotentialRank || talent.tokenKey || talent.isHideTalent) continue;
      const grid = meleeRedeploymentRange(talent, ranges);
      if (grid) areas.set('redeployment', { kind: 'redeployment', grid });
      // Some named talents carry an area in rangeId. Require the description to identify
      // a spatial effect. Other talents use this field for internal targeting or attack range.
      const description = talentDescription(talent);
      if (!talent.name || !talent.rangeId || talent.displayRangeId || skillRangeChange.test(description) || !tileArea.test(description)) continue;
      const effectGrid = getGrid(ranges, talent.rangeId);
      if (effectGrid.rangeCells.length) areas.set(talent.name, { kind: 'effect', name: talent.name, grid: effectGrid });
    }
  }
  return [...areas.values()];
}

function meleeRedeploymentRange(talent, ranges) {
  const stats = Array.isArray(talent.blackboard) ? talent.blackboard : [];
  const rangeId = stats.find(stat => stat.key === 'ignore_build_type_target_range')?.valueStr;
  if (rangeId && stats.some(stat => stat.key === 'ignore_build_type_target' && stat.value === 1)) {
    return getGrid(ranges, rangeId);
  }
}

const talentRowKey = (name, elite, potential) => JSON.stringify([name, elite, potential]);

export function syncTalentRedeploymentRanges(record, character, ranges) {
  const areas = new Map();
  for (const talent of character.talents ?? []) {
    for (const candidate of talent.candidates ?? []) {
      if (!candidate.name || candidate.isHideTalent) continue;
      const grid = meleeRedeploymentRange(candidate, ranges);
      if (!grid) continue;
      const elite = Number(candidate.unlockCondition?.phase?.match(/\d+/)?.[0] ?? 0);
      const key = talentRowKey(candidate.name, elite, (candidate.requiredPotentialRank ?? 0) + 1);
      areas.set(key, grid);
    }
  }
  let changed = false;
  for (const talent of record.talents ?? []) {
    for (const row of talent.rows ?? []) {
      const elite = Number(row.stage?.match(/\d+/)?.[0] ?? 0);
      const potential = Number(row.potential?.match(/\d+/)?.[0] ?? 1);
      const grid = areas.get(talentRowKey(row.name ?? talent.name, elite, potential));
      if (JSON.stringify(row.redeploymentRange) === JSON.stringify(grid)) continue;
      if (grid) row.redeploymentRange = grid;
      else delete row.redeploymentRange;
      changed = true;
    }
  }
  return changed;
}

function clientTables(root, directory) {
  const read = file => JSON.parse(fs.readFileSync(path.resolve(root, directory, 'excel', file), 'utf8'));
  return {
    battle: read('battle_equip_table.json'),
    characters: read('character_table.json'),
    ranges: read('range_table.json'),
  };
}

export function syncModuleRanges(root = process.cwd()) {
  const en = clientTables(root, process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en/gamedata');
  const cn = clientTables(root, process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource');
  const directory = path.join(root, 'data');
  const updates = [];
  for (const folder of fs.readdirSync(directory).filter(name => /^operators-[1-6]star$/.test(name))) {
    for (const file of fs.readdirSync(path.join(directory, folder)).filter(name => name.endsWith('.json'))) {
      const source = path.join(directory, folder, file);
      const record = JSON.parse(fs.readFileSync(source, 'utf8'));
      const characterClient = en.characters[record.internalName] ? en : cn;
      const character = characterClient.characters[record.internalName];
      let changed = character ? syncTalentRedeploymentRanges(record, character, characterClient.ranges) : false;
      for (const module of record.modules ?? []) {
        const client = en.battle[module.moduleId] ? en : cn;
        const battle = client.battle[module.moduleId];
        if (!battle) continue;
        for (const [index, stage] of module.stages.entries()) {
          const phase = battle.phases?.[index];
          if (!phase) continue;
          const range = moduleAttackRange(phase, client.ranges);
          const areas = moduleTileMechanics(phase, client.ranges);
          const fields = { attackRange: range, tileMechanics: areas.length ? areas : undefined };
          for (const [key, value] of Object.entries(fields)) {
            if (JSON.stringify(stage[key]) === JSON.stringify(value)) continue;
            if (value) stage[key] = value;
            else delete stage[key];
            changed = true;
          }
        }
      }
      if (changed) updates.push({ source, record });
    }
  }
  for (const { source, record } of updates) {
    fs.writeFileSync(source, `${JSON.stringify(record, null, 2)}\n`);
  }
  return updates.map(({ record }) => record.name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const updated = syncModuleRanges();
  console.log(`Updated module and talent ranges for ${updated.length} operators: ${updated.join(', ')}`);
}
