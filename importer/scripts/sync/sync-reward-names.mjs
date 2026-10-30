#!/usr/bin/env node
/**
 * Official Global names for event store rewards that were entered under their CN names.
 *
 * The events files are written ahead of Global from CN announcements, so a store can
 * list furniture as 制式木盆 long after the Global client ships it as "Standard Wooden
 * Basin", and nothing else ever rewrites a reward. Once an event has started on Global,
 * each Chinese item name is resolved to its game ID through the CN item and furniture
 * tables, and replaced with the EN tables' name for that ID. Display names are never
 * matched across languages: a CN name that belongs to two IDs with different EN names,
 * or to an ID the EN client does not have yet, is left alone. A Chinese name that is in
 * neither CN table is a typo in the events data (straight quotes for the table's curly
 * ones, say) and would stay Chinese forever. It keeps its CN name, the rest of the run
 * goes on, and it is reported to the quarantine list under 'reward-names' until the
 * events data is corrected.
 *
 * The CN name is kept as `cnName`. Reward icons are files named after the display name
 * (getMaterialIconPath), and the file that is already published is the CN-named one, so
 * until a file under the EN name is in the asset index the item also carries `iconName`
 * = its CN name and keeps resolving to that file; import-reward-icons.py reads the same
 * field, so it never fetches an unpublished EN-named copy that check:assets would then
 * reject. The run after the EN-named file is published drops `iconName`.
 *
 * Run after the stage refresh, which syncs both regional excel folders:
 *   node scripts/sync/sync-reward-names.mjs
 * ARKPEDIA_CN and ARKPEDIA_EN point it at other checkouts, as for the other importers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetFileNames } from '../lib/public-assets.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { eventWindow } from '../lib/event-records.mjs';

const chinese = value => /\p{Script=Han}/u.test(value ?? '');
// The filter getMaterialIconPath applies, so a name maps to the file the page asks for.
export const iconFile = name => `${String(name).replace(/[\\/*?:"<>|]/g, '').trim()}.webp`;
const rewardBlocks = event => event.rewards ? (Array.isArray(event.rewards) ? event.rewards : [event.rewards]) : [];

/** Every CN item and furniture name -> its official EN name, joined on the ID, or null
 *  while that is ambiguous or the EN client does not have the ID yet. */
export function rewardNames(cn, en) {
  const ids = new Map();
  const add = (name, row) => { if (name) ids.set(name, [...(ids.get(name) ?? []), row]); };
  for (const id of Object.keys(cn.items?.items ?? {})) add(cn.items.items[id].name, en.items?.items?.[id]);
  for (const id of Object.keys(cn.building?.customData?.furnitures ?? {})) add(cn.building.customData.furnitures[id].name, en.building?.customData?.furnitures?.[id]);
  const names = new Map();
  for (const [name, rows] of ids) {
    const english = new Set(rows.map(row => row?.name && !chinese(row.name) ? row.name : null));
    names.set(name, english.size === 1 ? [...english][0] : null);
  }
  return names;
}

/** `published` holds material-icons/ file names; see the header for `iconName`. */
export function localizeRewards(events, names, published, now = Date.now()) {
  const next = structuredClone(events), renamed = [], unknown = [];
  for (const event of next) {
    // When it opens on Global: the client's window when known, else the announced UTC−7 day.
    const start = eventWindow(event, 'Global')?.start;
    if (start == null || start > now) continue;
    for (const block of rewardBlocks(event)) {
      for (const item of block?.items ?? []) {
        // Skins resolve through the skins dataset, which has its own Global refresh.
        if (item.type === 'skin') continue;
        if (chinese(item.name) && !names.has(item.name)) unknown.push(`${event.name}: ${item.name}`);
        else if (chinese(item.name) && names.get(item.name)) {
          item.cnName = item.name; item.name = names.get(item.name);
          renamed.push(`${event.name}: ${item.cnName} -> ${item.name}`);
        }
        if (!item.cnName) continue;
        if (published.has(iconFile(item.name))) delete item.iconName;
        else item.iconName = item.cnName;
      }
    }
  }
  return { events: next, renamed, unknown };
}

export function syncRewardNames(root, cnExcel, enExcel, now = Date.now()) {
  const alerts = beginStage(root, 'reward-names', new Date(now));
  const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const table = (dir, file) => {
    const value = read(dir, file);
    if (file === 'item_table.json' ? Object.keys(value.items ?? {}).length < 1000 : Object.keys(value.customData?.furnitures ?? {}).length < 1000)
      throw new Error(`Truncated or changed ${file} in ${dir}`);
    return value;
  };
  const cn = { items: table(cnExcel, 'item_table.json'), building: table(cnExcel, 'building_data.json') };
  const en = { items: table(enExcel, 'item_table.json'), building: table(enExcel, 'building_data.json') };
  const names = rewardNames(cn, en), published = new Set(assetFileNames('material-icons', root));
  const directory = path.join(root, 'data/events'), writes = [], renamed = [], unknown = [];
  for (const file of fs.readdirSync(directory).filter(f => /^events_\d+\.json$/.test(f))) {
    const events = read(directory, file), result = localizeRewards(events, names, published, now);
    renamed.push(...result.renamed); unknown.push(...result.unknown);
    if (JSON.stringify(result.events) !== JSON.stringify(events)) writes.push([path.join(directory, file), result.events]);
  }
  for (const [at, events] of writes) fs.writeFileSync(at, JSON.stringify(events, null, 2) + '\n');
  for (const line of unknown) {
    alerts.add({ key: `reward:${line}`, action: 'kept-previous',
      reason: `The event reward ${line} is on Global but names no CN item or furniture, so it can never get an official name; it keeps its CN name until the events data spells it as the CN tables do.` });
  }
  alerts.commit();
  return { renamed, unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const cnExcel = path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata/excel');
  const enExcel = path.join(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en', 'gamedata/excel');
  try {
    const { renamed, unknown } = syncRewardNames(root, cnExcel, enExcel);
    for (const line of renamed) console.log(`  ${line}`);
    console.log(`${renamed.length} event reward name(s) replaced with official Global names.`);
    if (unknown.length) console.warn(`${unknown.length} reward name(s) on Global are in neither CN table and stay Chinese (quarantined):\n${unknown.map(line => `  ! ${line}`).join('\n')}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
