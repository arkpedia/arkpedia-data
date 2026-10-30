/**
 * A module's stages from the game's own tables (battle_equip_table, uniequip_table), in the
 * shape operator records keep them: { stage, attributesIncreased, effectLabel, effectText, cost }.
 *
 * Shared by the catalogue import (a new operator) and the English refresh (every released
 * operator, every run), so a record's module text is the game's words rather than a copy kept
 * from elsewhere (2026-10-03: "always do game data").
 *
 * - Text is the base-potential line (requiredPotentialRank 0), as records have always kept it;
 *   a Potential 5 line ("+3%") is a different number for the same stage.
 * - A stage lists what CHANGED: the trait at the first stage it appears or changes, and each
 *   talent line where its text is new. Stage 2 repeating Stage 1's trait word for word is left
 *   out, as the records do.
 * - Labels come from the game's fields, in the records' vocabulary: "New trait" for a line the
 *   module adds to the trait (additionalDescription, shown in preference to the whole rewritten
 *   trait the game also carries), "Trait improved" for a trait that is only rewritten
 *   (overrideDescripton); "New talent: <name>" where the module first brings a talent the
 *   operator does not have, and "<name> improved" for its own talents and for that new one at
 *   later stages. (The records' old labels picked between the trait two by hand.)
 * - A summoner's module can carry two lines for one talent in one stage: the summon's own data
 *   ("Invisible for 23 seconds") and the operator's, which says what happens to the summon
 *   ("Drones gain Invisibility for 23 seconds..."). Neither order, tokenKey nor prefabKey tells
 *   them apart across operators (Beanstalk, Magallan, Vigil, Roberta, Phantom, Nightingale); the
 *   operator's is always the longer, since it has to name the summon and restates the rest, so
 *   the longer is the one shown.
 */
import { formatModuleAttributes } from './sync-module-stats.mjs';
import { interpolateBlackboard } from '../lib/gametext.mjs';

const list = (x) => (Array.isArray(x) ? x : []);

/* The game writes some keywords flush against the word before ("duration of<$ba.sluggish>Slow"),
   which reads as one word once the tag is gone. */
const spaceBeforeKeyword = (text) => String(text ?? '').replace(/([a-z])(<[@$][^>]*>)(?=[A-Za-z])/g, '$1 $2');

/**
 * Base-potential candidates of a bundle, as [{ text, replaces, name, talentIndex }]. Placeholders
 * are filled by gametext.mjs interpolateBlackboard, the filler skills and traits use, so a number
 * reads the same everywhere (a {x:0%} of 0.125 is the game's "13%"), and a key the candidate does
 * not carry is refused rather than left on the page as "{key}". `where` names the stage for that
 * error; `kind` is what syncOperatorEnglish quarantines the record under.
 */
function baseLines(bundle, kind, where) {
  return list(bundle?.candidates).filter((c) => !c.requiredPotentialRank && !c.isHideTalent).map((c) => {
    const { text, missing } = interpolateBlackboard(spaceBeforeKeyword(kind === 'trait' ? (c.additionalDescription || c.overrideDescripton) : (c.upgradeDescription || c.description)), c.blackboard);
    if (missing.length) {
      throw Object.assign(new Error(`${where} ${kind} text is missing ${missing.join(', ')}`), { kind: 'has a module whose text names a value its stage does not carry' });
    }
    return {
      /* A bare <Name> left after the tags go is the game naming a summon ("<Substitute> deals..."). */
      text: text.replace(/<([A-Z][A-Za-z' -]*)>/g, '$1').trim(),
      replaces: kind === 'trait' && !c.additionalDescription,
      name: c.name ?? null,
      talentIndex: typeof c.talentIndex === 'number' ? c.talentIndex : -1,
    };
  }).filter((line) => line.text);
}

/**
 * @param equip    uniequip_table equipDict entry (itemCost by stage)
 * @param battle   battle_equip_table entry (phases)
 * @param talentNames every name the operator's own talents go by, at any Elite (to tell "improved" from "New talent")
 * @param itemName id -> the item's name
 */
export function moduleStages(equip, battle, talentNames, itemName) {
  const seen = { trait: null, talents: new Map() };
  return list(battle?.phases).map((phase, index) => {
    const effects = [];
    const talentLines = new Map();
    let trait = null;
    for (const part of list(phase.parts)) {
      /* The trait can come twice in one stage, the operator's and a clone's ("including that of
         its associated Operator", Phantom ISW-α); the same longer-wins rule as talents. */
      const where = `${equip?.uniEquipId ?? 'module'} Stage ${index + 1}`;
      for (const line of baseLines(part.overrideTraitDataBundle, 'trait', where)) {
        if ((trait?.text.length ?? -1) < line.text.length) trait = line;
      }
      for (const line of baseLines(part.addOrOverrideTalentDataBundle, 'talent', where)) {
        /* By name: a summon's line can leave talentIndex out (Nightingale RIN-Y). */
        const key = line.name ?? `#${line.talentIndex}`;
        if ((talentLines.get(key)?.text.length ?? -1) < line.text.length) talentLines.set(key, line);
      }
    }
    if (trait && trait.text !== seen.trait) effects.push({ label: trait.replaces ? 'Trait improved' : 'New trait', text: trait.text });
    if (trait) seen.trait = trait.text;
    for (const [key, line] of talentLines) {
      if (seen.talents.get(key) === line.text) continue;
      const before = seen.talents.has(key);
      seen.talents.set(key, line.text);
      const own = before || (line.name && talentNames.includes(line.name));
      effects.push({ label: own ? `${line.name} improved` : `New talent: ${line.name ?? 'Talent'}`, text: line.text });
    }
    return {
      stage: `Stage ${index + 1}`,
      attributesIncreased: formatModuleAttributes(phase.attributeBlackboard),
      /* One label per line: lib/operators/moduleEffects.ts pairs them back up. */
      effectLabel: effects.length ? effects.map((e) => e.label).join(' · ') : null,
      effectText: effects.length ? effects.map((e) => e.text).join('\n') : null,
      cost: list(equip?.itemCost?.[String(index + 1)]).map((entry) => ({ name: itemName(entry.id), quantity: entry.count })),
    };
  });
}
