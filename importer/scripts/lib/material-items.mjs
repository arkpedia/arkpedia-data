/**
 * Material names <-> game item ids, for the builders that turn the game's item tables into
 * the planner's records (build-material-catalogue, build-ingame-order, import-base-formulas).
 *
 * The site keys every material by its ENGLISH name, because that is what an operator record
 * carries and what material-icons/ files are named after. The game keys them by item id. The
 * EN item table joins the two for everything Global has. A material the CN client has and the
 * EN one does not yet (four of them on 2026-09-25: the 31103/31104 and 31113/31114 lines that
 * Closure, Crackborne and Kal'tsit - Esperanta cost) has only a Chinese name in the game data,
 * so its English name comes from data/material-names.json, a record kept in arkpedia-data.
 * Once the EN client ships the id, its own name wins and the entry is reported as spent.
 */

/** Where this site's name differs from the game's: the icon is filed under the singular. */
export const NAME_ALIASES = { 'Information Fragment': 'Information Fragments' };

/** An item's rarity as 1-6. Kengxxiao's dump names the enum ("TIER_3"), yuanyan3060's numbers
 *  it from 0; cn-tables.mjs may hand either to a refresh. */
export function itemTier(item) {
  const rarity = item?.rarity;
  if (typeof rarity === 'number' && Number.isInteger(rarity)) return rarity + 1;
  const match = /^TIER_(\d)$/.exec(String(rarity ?? ''));
  return match ? Number(match[1]) : null;
}

/** The same fold getMaterialIconPath applies before it builds a path. */
export const iconStem = name => String(name).replace(/[\\/*?:"<>|]/g, '').trim();

/**
 * One view over the EN and CN item tables and the English names for CN-only ids.
 *
 *   nameOf(id)   the site's name for an item id: the EN client's, else data/material-names.json,
 *                else the CN client's (a Chinese name, as a fresh CN import writes it).
 *   idOf(name)   the item id behind a site name, looked up the same three ways. First id wins
 *                in each table: event reprints reuse a few names, and the original has the
 *                lower id and the real place in the depot.
 *   item(id)     the item row, EN first, for its rarity and kind.
 *   sortId(id)   the depot position. From the CN table whenever it has the item: CN is the
 *                superset, and on the 115 materials both clients share its order is exactly the
 *                EN one (checked 2026-09-25), so the two cannot interleave wrongly. CN renumbers
 *                to fit new items in, which is why a CN-only item cannot take its number from
 *                one table and its neighbours from the other.
 */
export function materialItems({ enItems, cnItems, names }) {
  const en = enItems ?? {}, cn = cnItems ?? {}, english = names?.byItemId ?? {};
  const firstIds = table => {
    const ids = new Map();
    for (const [id, item] of Object.entries(table)) if (typeof item?.name === 'string' && !ids.has(item.name)) ids.set(item.name, id);
    return ids;
  };
  const enIds = firstIds(en), cnIds = firstIds(cn);
  const namedIds = new Map(Object.entries(english).map(([id, name]) => [name, id]));
  const nameOf = id => en[id]?.name ?? english[id] ?? cn[id]?.name ?? null;
  const idOf = name => {
    const game = NAME_ALIASES[name] ?? name;
    return enIds.get(game) ?? namedIds.get(name) ?? cnIds.get(game) ?? null;
  };
  const item = id => en[id] ?? cn[id] ?? null;
  const sortId = id => {
    const value = cn[id]?.sortId ?? en[id]?.sortId;
    return typeof value === 'number' ? value : null;
  };
  /** English names the EN client now has under its own name: spent (same name) or renamed. */
  const spentNames = () => Object.entries(english).filter(([id]) => en[id]?.name)
    .map(([id, name]) => ({ id, name, en: en[id].name }));
  return { nameOf, idOf, item, sortId, spentNames };
}

/** data/material-names.json, checked: {"version":1,"byItemId":{"<id>":"<English name>"}}. */
export function readMaterialNames(value) {
  if (value?.version !== 1 || !value.byItemId || typeof value.byItemId !== 'object' || Array.isArray(value.byItemId)
    || !Object.entries(value.byItemId).every(([id, name]) => id && typeof name === 'string' && name.trim() === name && name)) {
    throw new Error('data/material-names.json is not {"version":1,"byItemId":{"<item id>":"<English name>"}}');
  }
  return value;
}
