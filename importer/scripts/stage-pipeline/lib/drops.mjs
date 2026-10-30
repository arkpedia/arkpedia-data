// What a stage pays out, from gamedata: which items, whether they repeat, and the
// game's own wording for how often.
//
// Measured per-run rates from Penguin Statistics used to be attached here too. They
// were the only input to this pipeline that was not gamedata, and the only one that
// changed without the game changing, so the daily refresh opened a pull request most
// days for sample counts nobody read. Removed on request.
import { excel } from './gamedata.mjs';
import { text, list } from './text.mjs';
import { SlugSet, slug } from './names.mjs';

export const DROP_RARITY = {
  ALWAYS: 'Guaranteed', ALMOST: 'Common', USUAL: 'Uncommon', OFTEN: 'Rare', SOMETIMES: 'Very Rare',
};
export const DROP_RARITY_ORDER = ['Guaranteed', 'Common', 'Uncommon', 'Rare', 'Very Rare'];

// ONCE is the first-clear reward (an operator, usually); COMPLETE the full-clear
// bonus. Neither repeats, so neither belongs in a farming calculation.
export const DROP_KIND = {
  ONCE: 'one_time', COMPLETE: 'one_time', NORMAL: 'farmable',
  ADDITIONAL: 'farmable', SPECIAL: 'farmable', CONDITION_DROP: 'farmable',
};

/**
 * Resolves a (type, id) reward to a display name and a stable slug.
 *
 * Slugs come from a SlugSet run over each WHOLE source table, never over the
 * subset that happens to drop somewhere, so a slug is a property of the table and
 * any sibling script slugging the same table lands on the same answer. No rank is
 * passed, so a colliding display name suffixes EVERY member -- nobody keeps the
 * bare slug, which is why both Anonymous Tags items are suffixed.
 */
export class Rewards {
  constructor() {
    this.tables = {
      item: excel('item_table').items,
      // Operators are not items; a CHAR reward resolves through character_table.
      char: excel('character_table'),
      furniture: excel('building_data').customData.furnitures,
      charm: Object.fromEntries(list(excel('charm_table').charmList ?? excel('charm_table')).map((c) => [c.id, c])),
    };
    this.slugs = {};
    for (const [name, table] of Object.entries(this.tables)) {
      const ss = new SlugSet(slug);
      for (const [key, row] of Object.entries(table)) ss.add(key, text(row.name));
      this.slugs[name] = ss.resolve();
    }
  }

  resolve(rtype, rid) {
    const order = rtype === 'CHAR' ? ['char'] : ['item', 'furniture', 'charm'];
    for (const name of order) {
      const row = this.tables[name][rid];
      if (row == null) continue;
      return {
        slug: this.slugs[name].get(rid) ?? null,
        id: rid,
        name: text(row.name),
        is_operator: name === 'char',
      };
    }
    return null;
  }
}

const rarityRank = (occ) => {
  const label = DROP_RARITY[occ];
  const i = DROP_RARITY_ORDER.indexOf(label);
  return i === -1 ? DROP_RARITY_ORDER.length : i;
};

/** The drops array for one stage, in published order. */
export function buildDrops(sid, stage, rewards) {
  const entries = list(stage.stageDropInfo?.displayDetailRewards);

  // One item can be listed several times under different dropTypes (2001 as both
  // ONCE and NORMAL). Merge only WITHIN a kind: farmable vs one_time is a real
  // distinction, but two farmable rows for one item would double-count.
  const grouped = new Map();
  for (const e of entries) {
    const kind = DROP_KIND[e.dropType] ?? null;
    const key = JSON.stringify([e.type ?? null, e.id ?? null, kind]);
    if (!grouped.has(key)) grouped.set(key, { rtype: e.type ?? null, rid: e.id ?? null, kind, rows: [] });
    grouped.get(key).rows.push(e);
  }

  const drops = [];
  for (const { rtype, rid, kind, rows } of grouped.values()) {
    const item = rewards.resolve(rtype, rid);
    const occs = [...new Set(rows.map((r) => r.occPercent))].sort((a, b) => rarityRank(a) - rarityRank(b));
    const rarity = occs.length ? (DROP_RARITY[occs[0]] ?? null) : null;

    drops.push({
      item,
      kind,
      rarity,
      raw: {
        type: rtype,
        drop_type: [...new Set(rows.map((r) => r.dropType))].sort(),
        occ_percent: occs,
      },
    });
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  drops.sort((a, b) => {
    const ra = DROP_RARITY_ORDER.indexOf(a.rarity); const rb = DROP_RARITY_ORDER.indexOf(b.rarity);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
      || cmp(a.kind || '', b.kind || '')
      || cmp(a.item?.name || '', b.item?.name || '')
      || cmp(a.item?.id || '', b.item?.id || '');
  });
  return drops;
}
