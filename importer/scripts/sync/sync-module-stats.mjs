#!/usr/bin/env node
/** Reconcile module stat bonuses with the Global client's battle equip table. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRef } from '../content/pin-upstream.mjs';

// At the commit this run pinned (run-stage.mjs), else the branch.
const RAW = `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pinnedRef('ArknightsAssets/ArknightsGamedata')}/en/gamedata/excel`;
const LABELS = new Map([
  ['max_hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['magic_resistance', 'RES'],
  ['attack_speed', 'ASPD'], ['cost', 'Cost'], ['respawn_time', 'Redeployment time'],
  ['block_cnt', 'Block'],
]);

export function formatModuleAttributes(rows) {
  return (rows || []).map(({ key, value }) => {
    const label = LABELS.get(key);
    if (!label || !Number.isFinite(value)) throw new Error(`Unsupported module attribute: ${key}=${value}`);
    return `${label} ${value >= 0 ? '+' : ''}${Number.isInteger(value) ? value : Number(value.toFixed(3))}`;
  }).join(' , ');
}

function sameAttributes(current, rows) {
  const expected = new Map((rows || []).map(({ key, value }) => [LABELS.get(key), value]));
  const actual = new Map();
  for (const part of (current || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const match = /^(HP|ATK|DEF|RES|ASPD|Cost|Block|Rdp\.|Redeployment time)\s*([+-])\s*(\d+(?:\.\d+)?)/i.exec(part);
    if (!match) return false;
    const label = /^rdp\./i.test(match[1]) ? 'Redeployment time' : [...expected.keys()].find((key) => key?.toLowerCase() === match[1].toLowerCase());
    actual.set(label, Number(`${match[2]}${match[3]}`));
  }
  return actual.size === expected.size && [...expected].every(([key, value]) => actual.get(key) === value);
}

export function reconcileOperatorModuleStats(operator, equipIds, equipDict, battleEquip) {
  const modules = (operator.modules || []).filter((module) => module.type !== 'Original');
  const upgrades = (equipIds || []).map((id) => equipDict[id]).filter((entry) => entry?.type === 'ADVANCED')
    .sort((a, b) => (a.charEquipOrder ?? 0) - (b.charEquipOrder ?? 0));
  // CN-only operators/modules are intentionally kept until Global ships an
  // authoritative record for them.
  if (!upgrades.length) return [];
  const changes = [];
  for (const local of modules) {
    const prefix = /^([^:]+):/.exec(local.name || '')?.[1].replace(/[^A-Z0-9]/gi, '').toLowerCase();
    const upstream = upgrades.find((entry) => entry.uniEquipId === local.moduleId)
      || upgrades.find((entry) => `${entry.typeName1 || ''}${entry.typeName2 || ''}`.replace(/[^A-Z0-9]/gi, '').toLowerCase() === prefix)
      || upgrades.find((entry) => local.name?.includes(entry.uniEquipName));
    // A CN-only second module can coexist with the one already shipped on
    // Global. Leave it alone until its own Global client record arrives.
    if (!upstream) continue;
    const source = battleEquip[upstream.uniEquipId];
    // Future modules can already have a name in the site record before their
    // three stage cards are imported. There is nothing safe to rewrite yet.
    if (!local.stages.length) continue;
    if (!source || local.stages.length !== source.phases.length) throw new Error(`${operator.name}: incomplete client stages for ${local.name}`);
    for (let stageIndex = 0; stageIndex < local.stages.length; stageIndex++) {
      const next = formatModuleAttributes(source.phases[stageIndex].attributeBlackboard);
      if (!sameAttributes(local.stages[stageIndex].attributesIncreased, source.phases[stageIndex].attributeBlackboard)) {
        changes.push(`${operator.name} / ${local.name} / Stage ${stageIndex + 1}: ${local.stages[stageIndex].attributesIncreased} -> ${next}`);
        local.stages[stageIndex].attributesIncreased = next;
      }
    }
  }
  return changes;
}

async function table(root, file) {
  const cached = path.join(root, '.cache/upstream/en-gamedata/en/gamedata/excel', file);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const response = await fetch(`${RAW}/${file}`);
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  return response.json();
}

export async function syncModuleStats(root = process.cwd(), check = false) {
  const [uniequip, battle] = await Promise.all([table(root, 'uniequip_table.json'), table(root, 'battle_equip_table.json')]);
  const changes = [];
  for (const folder of fs.readdirSync(path.join(root, 'data')).filter((name) => /^operators-[1-6]star$/.test(name)).sort()) {
    for (const file of fs.readdirSync(path.join(root, 'data', folder)).filter((name) => name.endsWith('.json')).sort()) {
      const at = path.join(root, 'data', folder, file);
      const operator = JSON.parse(fs.readFileSync(at, 'utf8'));
      const next = structuredClone(operator);
      const operatorChanges = reconcileOperatorModuleStats(next, uniequip.charEquip?.[operator.internalName], uniequip.equipDict || {}, battle);
      if (!operatorChanges.length) continue;
      changes.push(...operatorChanges);
      if (!check) fs.writeFileSync(at, `${JSON.stringify(next, null, 2)}\n`);
    }
  }
  if (check && changes.length) throw new Error(`Module stat records are stale:\n${changes.join('\n')}`);
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  syncModuleStats(process.cwd(), process.argv.includes('--check')).then(changes => {
    console.log(changes.length ? `Updated module stats:\n${changes.map((line) => `  ${line}`).join('\n')}` : 'Module stats match the Global client.');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
