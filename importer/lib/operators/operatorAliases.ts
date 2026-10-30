/**
 * The other name an operator goes by.
 *
 * Alters are the problem. Most are named after the operator they came from -- "Texas
 * the Omertosa", "Nearl the Radiant Knight" -- so a plain substring search finds them
 * once it is asked the right way round. Several are not: Phantom's alter is Tragodia,
 * W's is Wiš'adel, Siege's is Vina Victoria. Nothing about those strings connects them
 * to the operator a reader is thinking of, so typing "phantom" found nothing.
 *
 * The records already know. Every base operator carries an `alternate` field naming its
 * alter, 37 of them, and this reads it rather than restating it. Two quirks in the
 * field, both handled: a `[CN]` prefix on alters global has not shipped, and a
 * comma-separated pair for Ch'en, who has two.
 *
 * Bidirectional on purpose. Typing "phantom" should find Tragodia, and typing
 * "tragodia" should find Phantom -- somebody who knows one name and not the other is
 * exactly the person this is for.
 */

export type AliasMap = Record<string, string[]>;

/** Strips the `[CN]` marker the field uses for alters global does not have yet. */
function cleanAlterName(raw: string): string {
  return raw.replace(/^\[CN\]\s*/, '').trim();
}

/**
 * Builds the map from operator records.
 *
 * Throws on an alter name that matches no record. That is the failure worth catching:
 * a typo or a rename leaves an alias pointing at nothing, the search silently stops
 * finding that operator by their other name, and nothing says a word. All 38 resolve
 * as of writing.
 *
 * A name a record had before a rename (its `aliases`, which the catalogue adds on every
 * rename) resolves to that record: on 2026-10-14 Global renamed Kal'tsit - Esperanta to
 * Kal'tsit Esperanta, Kal'tsit's `alternate` still named the old one, and /planner's
 * export threw. The catalogue now renames the field with the record
 * (scripts/sync/catalogue-model.mjs renameAlternates); this keeps a rename it missed
 * from taking the page down.
 */
export function buildAliasMap(operators: { name: string; alternate?: string | null; aliases?: string[] | null }[]): AliasMap {
  const known = new Set(operators.map((o) => o.name));
  const formerly = new Map(operators.flatMap((o) => (o.aliases ?? []).filter((alias) => !known.has(alias)).map((alias) => [alias, o.name] as const)));
  const map: AliasMap = {};
  const add = (name: string, alias: string) => {
    if (alias === name) return;
    const list = map[name];
    if (list) { if (!list.includes(alias)) list.push(alias); }
    else map[name] = [alias];
  };

  const unresolved: string[] = [];
  for (const op of operators) {
    if (!op.alternate) continue;
    for (const part of op.alternate.split(',')) {
      const named = cleanAlterName(part);
      if (!named) continue;
      const alter = known.has(named) ? named : formerly.get(named);
      if (!alter) { unresolved.push(`${op.name} -> ${named}`); continue; }
      add(op.name, alter);
      add(alter, op.name);
    }
  }
  if (unresolved.length) {
    throw new Error(
      `operatorAliases: ${unresolved.length} alternate name(s) match no operator record: ` +
      `${unresolved.join(', ')}. Fix the \`alternate\` field, or the record's name.`,
    );
  }
  return map;
}
