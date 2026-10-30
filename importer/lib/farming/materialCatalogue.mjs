/**
 * The planner's material catalogue: data/material-catalogue.json, a game record the content
 * release carries (scripts/build/build-material-catalogue.mjs writes it; lib/content/tables.mjs
 * hands it to /planner). It used to be a hand-typed list in lib/farming/materialSortOrder.ts, so
 * a new material needed a code change and a redeploy, and four that operators already cost were
 * missing from it with nothing to say so.
 *
 * Plain JavaScript so the release scripts (check-completeness, the builder) and the site read
 * the same rules.
 */

const list = value => (Array.isArray(value) ? value : []);

/**
 * Every material list an operator record hands the planner: promotions, skill ranks,
 * masteries and module stages. Not the potential tokens, which the planner never plans.
 */
export function plannerCostLists(op) {
  const skills = Array.isArray(op?.skills) ? op.skills : list(op?.skills?.skillList);
  return [
    ...list(op?.promotion).map(tier => tier?.cost),
    ...Object.values(op?.skills?.skillCost ?? {}),
    ...skills.flatMap(skill => Object.values(skill?.cost ?? {})),
    ...list(op?.modules).flatMap(module => list(module?.stages).map(stage => stage?.cost)),
  ].map(list);
}

/** The material names an operator's planner costs name, first appearance first. */
export function plannerCostNames(op) {
  const names = new Set();
  for (const cost of plannerCostLists(op)) {
    for (const item of cost) if (typeof item?.name === 'string' && item.name.trim()) names.add(item.name);
  }
  return [...names];
}

/** What the depot can hold: every catalogued name but EXP, which is a number, not an item. */
export function depotNames(catalogue) {
  return catalogue.order.filter(name => name !== 'EXP');
}

/** The names an operator costs that the catalogue does not have: the depot cannot hold them. */
export function uncataloguedCosts(op, catalogue) {
  const known = new Set(catalogue.order);
  return plannerCostNames(op).filter(name => !known.has(name));
}

/**
 * The shape the site relies on, checked wherever the table is read from data/ (the build's
 * prerender and the content export), so a malformed table fails the export instead of a page.
 */
export function checkMaterialCatalogue(value) {
  const fail = why => { throw new Error(`data/material-catalogue.json: ${why}. Re-run node scripts/build/build-material-catalogue.mjs.`); };
  if (value?.version !== 1) fail('not version 1');
  if (!Array.isArray(value.order) || !value.order.every(name => typeof name === 'string' && name)) fail('order is not a list of names');
  if (value.order[0] !== 'EXP') fail('order does not lead with EXP');
  if (new Set(value.order).size !== value.order.length) fail('order names a material twice');
  if (!Array.isArray(value.groups) || !value.groups.every(g => typeof g?.tag === 'string' && Array.isArray(g.names))) fail('groups is not [{ tag, names }]');
  const grouped = value.groups.flatMap(g => g.names);
  const depot = depotNames(value);
  const missing = depot.filter(name => !grouped.includes(name));
  const extra = grouped.filter(name => !depot.includes(name));
  const twice = grouped.filter((name, i) => grouped.indexOf(name) !== i);
  if (missing.length || extra.length || twice.length) {
    fail(`groups and order disagree${missing.length ? `; ungrouped: ${missing.join(', ')}` : ''}${extra.length ? `; not in order: ${extra.join(', ')}` : ''}${twice.length ? `; in two groups: ${twice.join(', ')}` : ''}`);
  }
  if (!value.items || typeof value.items !== 'object' || depot.some(name => !value.items[name]?.itemId)) fail('an ordered material has no item id');
  return value;
}
