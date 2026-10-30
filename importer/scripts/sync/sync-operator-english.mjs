import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interpolateBlackboard, stripRichText } from '../lib/gametext.mjs';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { materialItems, readMaterialNames } from '../lib/material-items.mjs';
import { pinnedRef } from '../content/pin-upstream.mjs';
import { moduleStages } from './module-stages.mjs';
import { voiceType } from '../lib/voice-pack-metadata.mjs';
import { BASE_ROOMS, facilityLabel } from '../lib/base-rooms.mjs';


/** The quarantine stage this refresh reports under (data/quarantine.json). */
export const STAGE = 'operator-english';

const hasChinese = text => typeof text === 'string' && /\p{Script=Han}/u.test(text);
const isEnglish = text => typeof text === 'string' && /[A-Za-z]/.test(text) && !hasChinese(text);

const RECOVERY = {
  INCREASE_WITH_TIME: 'Auto Recovery',
  INCREASE_WHEN_ATTACK: 'Offensive Recovery',
  INCREASE_WHEN_TAKEN_DAMAGE: 'Defensive Recovery',
  ON_DEPLOY: 'Deployment Recovery',
};
const ACTIVATION = { MANUAL: 'Manual', AUTO: 'Auto', PASSIVE: 'Passive' };
const ROOM = BASE_ROOMS;
const PHASE = { PHASE_0: 'Base', PHASE_1: 'Elite 1', PHASE_2: 'Elite 2' };
const VOICE_LANGUAGE = {
  EN: 'English', JP: 'Japanese', KR: 'Korean', CN_MANDARIN: 'Chinese',
  CN_TOPOLECT: 'Regional Chinese', ITA: 'Italian', GER: 'German', RUS: 'Russian',
  FRE: 'French', SPA: 'Spanish', LINKAGE: 'Collaboration',
};
// Only when ARKPEDIA_EN_SUPPLEMENTAL_CHARWORDS is unset; at the commit this run pinned, else the branch.
const SUPPLEMENTAL_CHARWORDS = `https://raw.githubusercontent.com/PuppiizSunniiz/ArknightsGameData_YoStar/${pinnedRef('PuppiizSunniiz/ArknightsGameData_YoStar')}/en_US/gamedata/excel/charword_table.json`;
const rows = value => Array.isArray(value) ? value : [];
/* A record the refresh will not rewrite: a table cannot describe it, or the rebuild would lose
   what people wrote. syncOperatorEnglish keeps that one record as it was and quarantines it;
   `kind` is the entry's reason, the same words every night (data/quarantine.json names the kind
   of failure, never the error's own text), and the message, with the details, goes to the log.
   An error without a kind (a TypeError, a broken call) is a bug in this code, not a record the
   tables cannot describe, and fails the stage: held instead, it would hold every record while
   the stage reported ok. */
const refusal = (kind, message) => Object.assign(new Error(message), { kind });

const costList = (entries, items) => (Array.isArray(entries) ? entries : []).map(entry => ({
  name: items?.items?.[entry.id]?.name ?? `item ${entry.id}`,
  quantity: entry.count,
}));

export function skillRows(skill) {
  return rows(skill.levels).map((level, index) => {
    const blackboard = rows(level.blackboard);
    const values = level.duration == null || blackboard.some(entry => String(entry?.key).toLowerCase() === 'duration')
      ? blackboard
      : [...blackboard, { key: 'duration', value: level.duration }];
    const { text, missing } = interpolateBlackboard(level.description, values);
    if (missing.length) throw refusal('has a skill whose text names a value its level does not carry', `${skill.skillId} level ${index + 1} is missing ${missing.join(', ')}`);
    return {
      level: index < 7 ? index + 1 : null,
      mastery: index < 7 ? null : index - 6,
      description: text,
      initialSp: level.spData?.initSp ?? 0,
      spCost: level.spData?.spCost ?? 0,
      duration: level.duration != null && level.duration > 0 ? Math.round(level.duration) : null,
    };
  });
}

/*
 * A name as a key, without the typography the wiki import added: straight vs curly quotes,
 * "Pharmacology α" vs the game's "Pharmacology·α", case, full-width "？？？", and the scrape's
 * "…Replaces <older name>" tail. Measured 2026-10-03 against every record: all 42 skill and
 * all 174 base-skill name differences were typography, and the names are keys (icon
 * filenames, /base's slot table and handlers, technique lookups), so a record keeps its own
 * spelling of the game's name. A real rename (the wiki's "Symphaticus Simulation" for Doc's
 * "Sympathicus Simulation") takes the game's.
 */
export const nameKey = name => String(name ?? '').split('Replaces')[0]
  .replace(/[’‘＂"]/g, "'").replace(/？/g, '?').replace(/[·\s]+/g, ' ').trim().toLowerCase();
export const keepSpelling = (recorded, game) => (recorded && nameKey(recorded) === nameKey(game) ? recorded : game);
// A potential-upgraded talent's rank ("Tactical Configuration 2", "Medic Mastery II"), in a key
// (withoutRank) or a display name alike.
const RANK = /\s+(?:vi|iv|iii|ii|i|v|[1-6])$/i;
const withoutRank = key => key.replace(RANK, '');
/** Every name the character's talents go by, at any Elite or potential. */
const talentNamesOf = character => rows(character?.talents).flatMap(talent => rows(talent.candidates).map(c => c.name)).filter(Boolean);
// The name a record wrote, without the import's "…Replaces <older name>" tail.
const shownName = name => String(name ?? '').split('Replaces')[0].trim();

/*
 * The game's talents, each carrying what was written on the record's talents of the same name.
 * Matched by name (any of the talent's names at any Elite, rank aside), not position: the wiki
 * import split some talents per Elite (Manticore's "Hidden Killer - Medium" and "- Elite" are one
 * talent in the game), so positions drift, and position once dropped Manticore's technique.
 * A talent the game renamed outright falls back to the record's talent at its position, if no
 * other talent took that one by name.
 *
 * Returns { talents, renames }. `renames` are the [before, after] names promotion text has to
 * follow, and come only from that fallback: a record name that is one of the game talent's own
 * names is the talent at another Elite ("Lavender" is Perfumer's Elite 1 talent, "Lavender's
 * Fragrance" her Elite 2 one), not a rename, and renaming it by position once rewrote "Lavender
 * becomes Lavender's Fragrance" into "Lavender's Fragrance becomes Lavender's Fragrance's
 * Fragrance". A real rename (Harmonie's "Unexpected Arrive", the game's "A Surprise Visitor")
 * still applies. A record talent no game talent took is kept after them as recorded, as
 * officialModules keeps a module neither table has: Raidian's six Integrated Strategies talents
 * are in no character_table entry, and a refresh that dropped them wrote 2 talents for 8.
 *
 * `unpaired` is set when that happened beside a game talent that took no record talent at all
 * ({ game, record }, the names on each side), else null: a talent the game renamed while its
 * position was taken by name (a per-Elite split ahead of it) is published twice, the record's
 * old name next to the game's new one, and the caller reports it. Raidian's talents all pair (his
 * "Casette Inspiration" by position), so his kept six are not reported.
 *
 * `unnamed` lists the record talents published as recorded, at their place, because the game's
 * talent there has no name on any candidate: nothing to publish it under, and dropping the
 * record's talent would drop a technique on it (the hand-written guard then holds the whole
 * record). It is the record's talent at that position, so it is that talent's and is used there;
 * left for the kept list, it was appended after the game's talents, out of place and unreported.
 */
function officialTalents(character, current) {
  const previous = rows(current);
  const talents = rows(character.talents);
  const keysOf = talent => new Set(rows(talent.candidates).map(c => c.name).filter(Boolean).map(n => withoutRank(nameKey(n))));
  const byName = talents.map(talent => previous.filter(entry => keysOf(talent).has(withoutRank(nameKey(entry.name)))));
  const claimed = new Set(byName.flat());
  const used = new Set();
  const renames = [];
  const bare = [];
  const unnamed = [];
  const official = talents.flatMap((talent, index) => {
    let name = null;
    const own = byName[index].length ? byName[index]
      : previous[index] && !claimed.has(previous[index]) ? [previous[index]] : [];
    const candidates = rows(talent.candidates).map(candidate => {
      name = candidate.name || name;
      const phase = Number(String(candidate.unlockCondition?.phase ?? '').replace('PHASE_', '')) || 0;
      return {
        name: candidate.name || name,
        stage: phase === 0 ? 'Base' : `Elite ${phase}`,
        potential: candidate.requiredPotentialRank ? `Potential ${candidate.requiredPotentialRank + 1}` : null,
        description: stripRichText(candidate.description),
      };
    });
    // No name on any candidate. Most such slots are the game's hidden internal talents (every
    // candidate isHideTalent with no description: 448 of 460 nameless slots in the EN table), which
    // no reader sees and which take no record talent: the record's talent at this place stays where
    // the kept list puts it, and an unpaired one is still reported as such. A visible nameless
    // talent keeps the record's talent here as recorded, used and reported (`unnamed` above),
    // before the kept list below could take it.
    if (!name) {
      const visible = rows(talent.candidates).some(candidate => !candidate.isHideTalent || candidate.description);
      if (!visible) return [];
      for (const entry of own) used.add(entry);
      unnamed.push(...own.map(entry => shownName(entry.name)));
      return own;
    }
    /* A talent whose name changes along the way names each row: by Elite (Manticore's "Hidden
       Killer - Medium", then "- Elite") or by potential, where the talent itself is then the
       name without the rank (Castle-3's "Tactical Configuration 1" to "6" are one talent,
       "Tactical Configuration"). A talent with one name keeps rows without one. */
    const names = [...new Set(candidates.map(row => row.name))];
    for (const row of candidates) if (names.length < 2) delete row.name;
    const ranked = names.length > 1 && new Set(names.map(n => withoutRank(nameKey(n)))).size === 1;
    if (ranked) name = name.replace(RANK, '');
    if (!own.length) bare.push(name);
    const techniques = own.flatMap(entry => rows(entry.technique));
    const merged = Object.assign({}, ...own);
    delete merged.technique;
    // Without the import's "…Replaces <older>" tail: the game's talent is the whole chain now,
    // and no file or lookup is named after a talent (base skills keep theirs: icon filenames).
    const recorded = own.map(entry => shownName(entry.name)).find(shown => nameKey(shown) === nameKey(name));
    const finalName = keepSpelling(recorded, name);
    for (const entry of own) {
      used.add(entry);
      const before = shownName(entry.name);
      // A name with no letter or digit ("???", Amiya's before Elite 2) would match anywhere.
      if (!/[\p{L}\p{N}]/u.test(before) || keysOf(talent).has(withoutRank(nameKey(before))) || nameKey(before) === nameKey(finalName)) continue;
      renames.push([before, finalName]);
    }
    return [{
      ...merged,
      name: finalName,
      rows: candidates,
      ...(techniques.length ? { technique: techniques.filter((t, i) => techniques.findIndex(o => o.name === t.name) === i) } : {}),
    }];
  });
  const kept = previous.filter(entry => !used.has(entry));
  const unpaired = kept.length && bare.length ? { game: bare, record: kept.map(entry => shownName(entry.name)) } : null;
  return { talents: [...official, ...kept], renames, unpaired, unnamed };
}

/*
 * Promotion text names talents and skills ("Lavender becomes Lavender's Fragrance", "New skill:
 * Fine Blending"), so a rename follows into it. All renames go in one pass over a whole-name
 * alternation, longest name first: a replacement is never read again, and a name never matches
 * inside a longer name that is renamed too, where a replaceAll per rename matched "Lavender"
 * inside the "Lavender's Fragrance" an earlier rename had just written. Whole name: no letter or
 * digit on either side (\b fails beside "?", "~" or a closing quote, which names end with). So a
 * possessive follows its name ("Lavender's" is "Lavender" and an apostrophe).
 *
 * `names` is every name the text may carry that stands for itself, required: the operator's
 * final talent and skill names and every name the game's talent candidates go by. Each joins the
 * alternation as itself, so a longer name is read whole before a rename can take its start or
 * its end: under a rename of "Arrow" alone, the skill "Arrow Storm" stays "Arrow Storm" (a space
 * is no letter, so "Arrow" alone matched it, and "Storm Arrow" too). A rename of a name wins
 * over the same name kept: an explicit [before, after] is never undone by the list. A name
 * neither renamed nor listed still follows a rename it starts with ("X's Fragrance" for
 * "Lavender's Fragrance" under "Lavender" alone), which is why the list must hold every name.
 */
export function renameInText(text, renames, names) {
  if (!Array.isArray(names)) throw new Error('renameInText needs the names that stand for themselves: every final talent and skill name and every game candidate name');
  const to = new Map();
  for (const [before, after] of renames) if (before && after && before !== after && !to.has(before)) to.set(before, after);
  if (typeof text !== 'string' || !to.size) return text;
  // A name with no letter or digit ("???") would match anywhere; as itself it changes nothing anyway.
  for (const name of names) if (typeof name === 'string' && /[\p{L}\p{N}]/u.test(name) && !to.has(name)) to.set(name, name);
  const alternation = [...to.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation.join('|')})(?![\\p{L}\\p{N}])`, 'gu'), match => to.get(match));
}

/*
 * The trait as the game prints it at each promotion. character.description is a template, and
 * trait.candidates carry each phase's values and, for most of the operators that have them, a
 * rewritten text (overrideDescripton): Ceylon's "reduced to {heal_scale:0%}" reads 80% only
 * through her candidate's blackboard, and Pudding jumps between 3 enemies, 4 from Elite 2. Read
 * from character.description alone, 14 records were written with a raw {placeholder} and 12 lost
 * their later phases. A trait that reads the same at every phase is one string; one that changes
 * is { Base, "Elite 1", "Elite 2" }, the shape the records already keep (lib/operators/
 * operatorTypes.ts). Base potential only, as module stages are; no trait candidate carries a
 * potential requirement (checked 2026-10-05). A value the text names and the game does not carry
 * is refused, never written.
 */
export function officialTrait(character) {
  const candidates = rows(character.trait?.candidates).filter(candidate => !candidate.requiredPotentialRank);
  const phases = (candidates.length ? candidates : [{ unlockCondition: { phase: 'PHASE_0' }, blackboard: [] }]).map(candidate => {
    const { text, missing } = interpolateBlackboard(candidate.overrideDescripton || character.description, candidate.blackboard);
    if (missing.length) throw refusal('has a trait whose text names a value the game\'s trait data does not carry', `trait is missing ${missing.join(', ')}`);
    return [PHASE[candidate.unlockCondition?.phase] ?? PHASE.PHASE_0, text];
  });
  return new Set(phases.map(([, text]) => text)).size === 1 ? phases[0][1] : Object.fromEntries(phases);
}

/** A placeholder ("{heal_scale:0%}") left in a trait, string or per phase, or null. */
export function traitPlaceholder(trait) {
  const texts = typeof trait === 'string' ? [trait] : trait && typeof trait === 'object' ? Object.values(trait) : [];
  return texts.map(text => String(text).match(/\{[^{}]*\}/)?.[0]).find(Boolean) ?? null;
}

/*
 * The game's base skills with their place in it: `slot` is the entry of buffChar the skill
 * belongs to (same slot = a later skill replaces an earlier one), `phase` and `level` what
 * unlocks it. /base reads these first (pages/base.tsx), so the record says outright what
 * data/base-skill-slots.json, a table nothing regenerates, said only for operators it knew.
 */
function officialBaseSkills(characterId, building, current) {
  const previous = rows(current);
  const slots = rows(building?.chars?.[characterId]?.buffChar);
  return slots.flatMap((slot, slotIndex) => rows(slot.buffData).map(entry => ({ entry, slotIndex }))).map(({ entry, slotIndex }, index) => {
    const buff = building.buffs?.[entry.buffId];
    if (!buff) throw refusal('has a base skill building_data does not describe', `${characterId} base skill ${entry.buffId} is missing`);
    const facility = ROOM[buff.roomType] ?? buff.roomType;
    const phase = Number(String(entry.cond?.phase ?? 'PHASE_0').replace('PHASE_', '')) || 0;
    const level = entry.cond?.level ?? 1;
    const prior = previous.find(p => facilityLabel(p.facility) === facility && nameKey(p.name) === nameKey(buff.buffName))
      ?? (facilityLabel(previous[index]?.facility) === facility ? previous[index] : {});
    return {
      ...prior,
      name: keepSpelling(prior.name, buff.buffName),
      facility,
      // 1★/2★ operators and Durin unlock a skill at a level, not a promotion: "Level 30".
      eliteLevel: phase === 0 && level > 1 ? `Level ${level}` : PHASE[`PHASE_${phase}`],
      description: stripRichText(buff.description),
      buffId: entry.buffId,
      slot: slotIndex,
      phase,
      level,
    };
  });
}

/**
 * The operator's modules from uniequip_table, each Upgrade's stages built from battle_equip_table
 * (module-stages.mjs). battleEquip, talentNames and items are required: stages kept from a record
 * instead of rebuilt are the wiki's words, which is what this refresh exists to replace.
 * cn is the CN tables (cnModuleTables) or null; gaps is where a stage that kept the record's own
 * cost (or none) is reported, as { key, text }: required, as the list the caller quarantines.
 */
export function officialModules(characterId, modules, current, battleEquip, talentNames, items, cn, gaps) {
  if (!battleEquip || typeof battleEquip !== 'object') throw new Error('officialModules needs battle_equip_table');
  // Required, as null where there is no second table (the catalogue's CN-sourced operators).
  if (cn === undefined) throw new Error('officialModules needs the CN tables, or null');
  if (cn && cn.materialNames === undefined) throw new Error('officialModules needs the CN tables with data/material-names.json (cnModuleTables)');
  if (!Array.isArray(gaps)) throw new Error('officialModules needs a list to report the costs it kept from the record');
  const previous = rows(current);
  const matched = new Set();
  const normalizeCode = value => String(value ?? '').replace(/α/gi, 'A').replace(/β/gi, 'B').replace(/δ/gi, 'D').replace(/[^a-z0-9]/gi, '').toLowerCase();
  // charEquip is the per-character list. equipDict's charId is not: Amiya's Guard and Medic
  // modules carry char_002_amiya too, so filtering on it handed the Caster all six.
  const ownModules = table => {
    const own = Array.isArray(table?.charEquip?.[characterId]) ? new Set(table.charEquip[characterId]) : null;
    return Object.values(table?.equipDict ?? {})
      .filter(module => (own ? own.has(module.uniEquipId) : module.charId === characterId))
      .sort((a, b) => a.charEquipOrder - b.charEquipOrder);
  };
  const build = (list, table, battles, names, itemName) => list.map(module => {
    const type = module.type === 'INITIAL' ? 'Original' : 'Upgrade';
    const suffix = { A: 'α', B: 'β', D: 'Δ' }[module.typeName2] ?? module.typeName2;
    const code = `${module.typeName1}-${suffix}`;
    const prefix = type === 'Original' ? '' : `${code}: `;
    // Several upgrades share type=Upgrade. Never copy one module's stages,
    // costs or trait into another merely because they have the same type.
    const prior = previous.find(entry => entry.moduleId === module.uniEquipId)
      ?? previous.find(entry => !matched.has(entry) && entry.type === type && (type === 'Original'
        || normalizeCode(entry.name?.split(':')[0]) === normalizeCode(code)
        || entry.name?.split(':').slice(1).join(':').trim() === module.uniEquipName))
      ?? { stages: [] };
    matched.add(prior);
    const missions = (Array.isArray(module.missionList) ? module.missionList : [])
      .map(id => table.missionList?.[id]?.desc).filter(Boolean);
    const battle = type === 'Upgrade' ? battles[module.uniEquipId] : null;
    /* A cost in a material itemName cannot name (null) keeps the stage's previous cost, reported,
       as sync-operator-costs does for every other cost: a Chinese name is a material the planner's
       catalogue never has, so check-completeness held the operator and /planner dropped it. A
       stage the record has no cost for (a module CN has just announced, costing a material line
       data/material-names.json does not name yet: the usual case) gets an empty list, never no
       cost at all: validate-release requires the list on every stage, and a stage without one
       failed the whole day's release where this one module is reported. */
    const unnamed = [];
    const stages = battle && moduleStages(module, battle, names, itemName).map((stage, index) => {
      const ids = rows(module.itemCost?.[String(index + 1)]).map(entry => entry.id).filter(id => !itemName(id));
      if (!ids.length) return stage;
      unnamed.push(`${stage.stage}: item ${ids.join(', ')}`);
      const kept = rows(prior.stages).find(old => old.stage === stage.stage)?.cost;
      return { ...stage, cost: kept ?? [] };
    });
    if (unnamed.length) {
      gaps.push({ key: `module:${module.uniEquipId}`, text: `${code} module (CN only) costs a material with no English name yet (${unnamed.join('; ')}), `
        + `so ${unnamed.length === 1 ? 'that stage keeps its' : 'those stages keep their'} previous cost, or none, until data/material-names.json names it` });
    }
    return {
      ...prior,
      type,
      moduleId: module.uniEquipId,
      name: `${prefix}${module.uniEquipName}`,
      ...(stages ? { stages } : {}),
      ...(missions.length ? { mission: { requirement1: missions[0] ?? '', requirement2: missions[1] ?? '' } } : {}),
    };
  });
  const enItem = id => items?.items?.[id]?.name;
  const global = ownModules(modules);
  const updated = build(global, modules, battleEquip, talentNames, id => enItem(id) ?? `item ${id}`);
  /* A module CN has and Global does not yet is built from the CN tables, in the CN client's own
     words (2026-10-03: "CN only stuff you can keep in CN till global release"), and rebuilt
     every night: the night the Global tables carry it, it is in `global` above, matched by its
     id, and the English replaces the Chinese with no one touching it. Costs take the site's
     material name (scripts/lib/material-items.mjs): the EN client's where Global has the item,
     else data/material-names.json's. */
  const onGlobal = new Set(global.map(module => module.uniEquipId));
  const siteName = cn && materialItems({ enItems: items?.items, cnItems: cn.items?.items, names: cn.materialNames }).nameOf;
  const englishName = id => (isEnglish(siteName(id)) ? siteName(id) : null);
  const cnOnly = cn ? build(ownModules(cn.modules).filter(module => !onGlobal.has(module.uniEquipId) && module.type !== 'INITIAL'),
    cn.modules, cn.battleEquip ?? {}, talentNamesOf(cn.characters?.[characterId]), englishName) : [];
  // A module neither table has (a record's own) is kept as recorded.
  return [...updated, ...cnOnly, ...previous.filter(entry => !matched.has(entry))];
}

/**
 * The CN tables officialModules builds a Global operator's CN-only modules from, each read by
 * its sync-catalogue.mjs table key, with data/material-names.json: the English names of the
 * materials only CN has. materialNames is required, as null where a caller has not loaded it;
 * a cost in such a material then keeps the stage's previous cost, reported.
 */
export function cnModuleTables(read, materialNames) {
  if (typeof read !== 'function') throw new Error('cnModuleTables reads each CN table by its key');
  if (materialNames === undefined) throw new Error('cnModuleTables needs data/material-names.json, or null');
  return {
    modules: read('modules'), battleEquip: read('battleEquip'), characters: read('characters'), items: read('items'),
    materialNames: materialNames === null ? null : readMaterialNames(materialNames),
  };
}

export function officialVoiceActors(characterId, tables, current = null) {
  const voices = { ...current };
  for (const table of tables ?? []) {
    const entries = table?.voiceLangDict?.[characterId]?.dict;
    if (!entries || typeof entries !== 'object') continue;
    for (const [key, entry] of Object.entries(entries)) {
      const type = voiceType(key, entry);
      const language = VOICE_LANGUAGE[type] ?? table.voiceLangTypeDict?.[type]?.name ?? type;
      const actors = (Array.isArray(entry?.cvName) ? entry.cvName : []).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
      if (actors.length) voices[language] = actors.join(' / ');
    }
  }
  return Object.keys(voices).length ? voices : current;
}

/*
 * The game's entry for a record, when it is the same operator: by id, in character_table or, for
 * an alternate form, char_patch_table (Amiya's Guard and Medic forms live only there), with a
 * name check against an id reused for someone else. The name check ignores word order and quotes,
 * since records keep the name order the site uses ("Yahata Umiri" for the game's "Umiri Yahata",
 * five BanG Dream operators that otherwise were never refreshed), and a form's record names it
 * in brackets ("Amiya (Guard)").
 */
const nameWords = name => String(name ?? '').normalize('NFC').replace(/[’‘'"]/g, '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
export function sameOperator(recordName, gameName) {
  return nameWords(recordName) === nameWords(gameName) || String(recordName ?? '').startsWith(`${gameName} (`);
}
export function characterOf(operator, tables) {
  const character = tables?.characters?.[operator.internalName] ?? tables?.patch?.patchChars?.[operator.internalName];
  return character && sameOperator(operator.name, character.name) ? character : null;
}

/** The quarantine reason for one of localizeReleasedMechanics' gaps, written after `name` (the
 *  operator's public name). Both stages that rebuild a record (syncOperatorEnglish here and the
 *  catalogue's reconcileOperators) write their published-partial entries with it, so one gap
 *  reads the same under either stage, ending as their kept-previous reasons do. */
export const gapReason = (name, gap) => `${name}'s ${gap.text}.`;

/**
 * A released operator rebuilt from the game's tables. gaps: where the rebuild kept part of the
 * record because the game's data could not fill it (a CN-only module cost in a material with no
 * English name yet, a talent it could not pair), as { key, text }: required, as the list the
 * caller quarantines. `text` follows the operator's name ("Bob's <text>", gapReason) and says what was kept.
 */
export function localizeReleasedMechanics(operator, tables, gaps) {
  if (!Array.isArray(gaps)) throw new Error('localizeReleasedMechanics needs a list to report what it kept from the record');
  const character = characterOf(operator, tables);
  if (!character) return operator;
  const next = structuredClone(operator);
  const previousSkills = next.skills?.skillList ?? [];
  next.trait = officialTrait(character);
  next.tags = character.tagList ?? next.tags;
  next.potential = {
    ...next.potential,
    levels: rows(character.potentialRanks).map((rank, index) => ({
      level: index + 2,
      benefit: stripRichText(rank.description),
    })),
  };
  const talents = officialTalents(character, next.talents);
  next.talents = talents.talents;
  /* Both of officialTalents' reports share one entry: the quarantine keeps one entry per key, the
     first reported, and both are about the operator's talents as a whole. */
  const talentGaps = [];
  if (talents.unpaired) {
    const { game, record } = talents.unpaired;
    talentGaps.push(`talent${game.length > 1 ? 's' : ''} ${game.join(', ')} pair${game.length > 1 ? '' : 's'} with none of the record's talents, and the record's ${record.join(', ')} with none of the game's, `
      + 'so both are published: the same talent twice if the game renamed one to the other');
  }
  if (talents.unnamed.length) {
    const many = talents.unnamed.length > 1;
    talentGaps.push(`talent${many ? 's' : ''} ${talents.unnamed.join(', ')} ${many ? 'are' : 'is'} published as the record has ${many ? 'them' : 'it'}: `
      + `the game's talent${many ? 's' : ''} at ${many ? 'their places have' : 'its place has'} no name`);
  }
  if (talentGaps.length) gaps.push({ key: `operator:${operator.internalName}`, text: talentGaps.join('; ') });
  next.baseSkills = officialBaseSkills(operator.internalName, tables.building, next.baseSkills);
  next.modules = officialModules(operator.internalName, tables.modules, next.modules, tables.battleEquip, talentNamesOf(character), tables.items, tables.cn, gaps);
  next.characterVoices = officialVoiceActors(operator.internalName, tables.voiceTables, next.characterVoices);
  next.skills = {
    ...next.skills,
    skillList: rows(character.skills).map((entry, index) => {
      const skill = tables.skills?.[entry.skillId];
      if (!skill) throw refusal('has a skill skill_table does not describe', `${operator.name} is missing ${entry.skillId}`);
      const first = skill.levels?.[0] ?? {};
      const prior = previousSkills[index] ?? {};
      const masteries = rows(entry.levelUpCostCond);
      return {
        ...prior,
        name: keepSpelling(prior.name, first.name),
        recoveryType: RECOVERY[first.spData?.spType] ?? null,
        activationType: ACTIVATION[first.skillType] ?? null,
        duration: first.duration > 0 ? `${Math.round(first.duration)} seconds` : null,
        levels: skillRows(skill),
        cost: {
          m1: costList(masteries[0]?.levelUpCost, tables.items),
          m2: costList(masteries[1]?.levelUpCost, tables.items),
          m3: costList(masteries[2]?.levelUpCost, tables.items),
        },
      };
    }),
    skillCost: Object.fromEntries(rows(character.allSkillLvlup).map((step, index) => [
      String(index + 2), costList(step.lvlUpCost, tables.items),
    ])),
  };
  // A skill is the record's skill at its place (prior above), so its rename is too; keepSpelling
  // left every name that differs only in typography as the record wrote it.
  const skillRenames = previousSkills.map((skill, index) => [skill.name, next.skills.skillList[index]?.name])
    .filter(([before, after]) => before && after && /[\p{L}\p{N}]/u.test(before) && nameKey(before) !== nameKey(after));
  const renames = [...talents.renames, ...skillRenames];
  // Every name the text may carry as itself (renameInText): a rename never takes its start or end.
  const names = [...next.talents.map(talent => shownName(talent.name)), ...talentNamesOf(character),
    ...next.skills.skillList.map(skill => skill.name)];
  next.promotion = rows(next.promotion).map(tier => ({
    ...tier,
    upgrades: rows(tier.upgrades).map(upgrade => renameInText(upgrade, renames, names)),
  }));
  return next;
}

export function localizeOperator(operator, handbook) {
  if (!handbook || handbook.charID !== operator.internalName) return operator;
  // Multiple stories can be alternate-form or conditional archives. Do not
  // flatten them or assign another form's text to this operator.
  const sections = new Map((handbook.storyTextAudio ?? [])
    .filter(group => group.stories?.length === 1 && isEnglish(group.stories[0].storyText))
    .map(group => [group.storyTitle, group.stories[0].storyText]));
  const next = structuredClone(operator);
  const profile = sections.get('Profile');
  if (profile && next.review?.official !== profile) {
    next.review = { ...next.review, official: profile };
  }
  for (const file of next.files ?? []) {
    const text = sections.get(file.section);
    if (text && file.description !== text) file.description = text;
  }
  return next;
}

/**
 * Whether a record takes the game's voice credits (syncOperatorEnglish rebuilds everything else
 * for every operator): a release in the last 90 days, or a record still carrying untranslated
 * text, does; an older one keeps what the records add to the game's list.
 */
export function usesGameVoiceCredits(operator, now = Date.now(), windowDays = 90) {
  if (hasChinese(operator.review?.official)
    || (operator.files ?? []).some(file => hasChinese(file.description))) return true;
  const match = String(operator.characterInfo?.['Release Date'] ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return false;
  const release = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const age = now - release;
  return age >= 0 && age <= windowDays * 24 * 60 * 60 * 1000;
}

/* What people wrote on a record, which no table holds. A refresh that loses any of it is a bug
   (a talent list that changed length once dropped Manticore's talent technique). */
export function handWrittenFields(operator) {
  return JSON.stringify({
    review: [operator.review?.editor ?? null, operator.review?.rating ?? null],
    skills: rows(operator.skills?.skillList).map(skill => [skill.techniques ?? null, skill.recommendation ?? null, skill.pairings ?? null, skill.icon ?? null]),
    // By technique, not by talent: merging the import's per-Elite talents moves a technique
    // between entries without losing it.
    talents: [...new Set(rows(operator.talents).flatMap(talent => rows(talent.technique).map(t => JSON.stringify(t))))].sort(),
    baseSkillIcons: rows(operator.baseSkills).map(skill => skill.icon).filter(Boolean).sort(),
    topLevel: [operator.synergies ?? null, operator.techniques ?? null, operator.guides ?? null],
  });
}

/**
 * Every operator record rebuilt from the game's tables (handbook alone when tables is null),
 * written where it changed. A record the refresh cannot rebuild, or whose rebuild would lose what
 * people wrote, keeps its previous version and is quarantined on its own (stage operator-english,
 * kept-previous); a stage that kept part of a record is reported as published-partial. One bad
 * record once threw and rolled back the whole roster's refresh for the night. Only a refusal
 * (an error with a `kind`) is held so: any other error is a bug, which would hold the whole roster
 * as easily as one record, and fails the stage.
 */
export function syncOperatorEnglish(root, handbook, tables = null, now = defaultNow()) {
  if (!handbook?.handbookDict || typeof handbook.handbookDict !== 'object') throw new Error('Invalid English handbook table');
  const holds = beginStage(root, STAGE, now);
  let changed = 0;
  for (const directory of fs.readdirSync(path.join(root, 'data')).filter(name => /^operators-\dstar$/.test(name)).sort()) {
    for (const file of fs.readdirSync(path.join(root, 'data', directory)).filter(name => name.endsWith('.json')).sort()) {
      const at = path.join(root, 'data', directory, file);
      const operator = JSON.parse(fs.readFileSync(at, 'utf8'));
      const id = operator.internalName || operator.name;
      const gaps = [];
      let next;
      try {
        // Every released operator is rebuilt from the game's tables on every run, mechanics and
        // archive text alike: a record kept as it was is the wiki import's text, and the game's is
        // the source (2026-10-03). Names stay keys (keepSpelling), talents match by name, and the
        // guard below refuses to lose anything written by hand.
        const rebuilt = localizeOperator(tables ? localizeReleasedMechanics(operator, tables, gaps) : operator, handbook.handbookDict[operator.internalName]);
        // Except voice credits, outside the recent-release window: the records carry what the EN
        // table does not (the actor's own name beside the EN credit, the dialect where the game says
        // "Regional Chinese", languages the table lacks), so the game's list would drop it.
        next = usesGameVoiceCredits(operator) || !operator.characterVoices ? rebuilt
          : { ...rebuilt, characterVoices: { ...rebuilt.characterVoices, ...operator.characterVoices } };
        if (handWrittenFields(next) !== handWrittenFields(operator)) {
          throw refusal('would lose or move hand-written techniques or recommendations', `${operator.name}: the refresh would lose or move hand-written techniques or recommendations`);
        }
        const placeholder = traitPlaceholder(next.trait);
        if (placeholder) throw refusal('would carry an unfilled placeholder in its trait', `${operator.name}: the rebuilt trait still carries ${placeholder}`);
      } catch (error) {
        if (!error.kind) throw error;
        console.error(`Global operator data: ${operator.name} kept as it was: ${error.message}`);
        holds.add({ key: `operator:${id}`, action: 'kept-previous', reason: `${operator.name} (${id}) ${error.kind}, so its previous version is kept.` });
        continue;
      }
      for (const gap of gaps) holds.add({ key: gap.key, action: 'published-partial', reason: gapReason(operator.name, gap) });
      if (JSON.stringify(next) === JSON.stringify(operator)) continue;
      fs.writeFileSync(at, JSON.stringify(next, null, 2) + '\n');
      console.log(`Global operator data: ${operator.name}`);
      changed++;
    }
  }
  const held = holds.commit();
  if (held.length) console.log(`${held.length} operator record(s) or module(s) quarantined by ${STAGE}:\n${held.map(entry => `  ! ${entry.key}: ${entry.reason}`).join('\n')}`);
  return changed;
}

async function main() {
  const root = process.env.ARKPEDIA_OPERATOR_ROOT || process.cwd();
  /* The nightly runs this before the catalogue stage, so a skill whose name it changes gets its
     icon in the same run's media plan (sync-catalogue.mjs assetPlan publishes every icon path a
     record implies that is not published yet). That is before refresh-stage-data.sh checks out
     the EN tables, so it reads them the way the catalogue does: the run's pinned commit of the
     Global mirror, cached in .cache/catalogue, where the catalogue then finds them. ARKPEDIA_EN
     points at a local checkout instead. */
  // Imported here, not at the top: sync-catalogue.mjs imports catalogue-model.mjs, which imports this file.
  const catalogue = await import('./sync-catalogue.mjs');
  const pinned = process.env.ARKPEDIA_EN ? null : await catalogue
    .source('ArknightsAssets/ArknightsGamedata', 'en/gamedata/excel', path.join(process.cwd(), '.cache/catalogue'));
  const excel = process.env.ARKPEDIA_EN;
  /* A table by its key in sync-catalogue's tableFiles, the list source() fetches: from the pinned
     tables, or the same file in the ARKPEDIA_EN checkout. A key the list does not have is an error:
     the hand-kept reverse copy of the list this replaces read a renamed key as no table at all, so
     Amiya's forms (char_patch_table) would have stopped refreshing without a word. */
  const fileOf = key => catalogue.tableFiles[key] ?? (() => { throw new Error(`sync-catalogue.mjs tableFiles has no ${key} table`); })();
  const read = key => {
    const file = fileOf(key);
    if (!pinned) return JSON.parse(fs.readFileSync(path.join(excel, 'excel', file), 'utf8'));
    if (pinned[key] == null) throw new Error(`The pinned Global tables have no ${file}`);
    return pinned[key];
  };
  const supplementalPath = process.env.ARKPEDIA_EN_SUPPLEMENTAL_CHARWORDS;
  const supplementalCharwords = supplementalPath
    ? JSON.parse(fs.readFileSync(supplementalPath, 'utf8'))
    : await (async () => {
      const response = await fetch(SUPPLEMENTAL_CHARWORDS);
      if (!response.ok) throw new Error(`Supplemental Global voice credits: ${response.status} ${response.statusText}`);
      return response.json();
    })();
  /* The CN tables, for modules Global does not have yet (officialModules). The run's pinned CN
     mirror (cn-tables.mjs settles it before this stage), or ARKPEDIA_CN, a checkout holding
     gamedata/excel, beside ARKPEDIA_EN. A CN mirror the catalogue would refuse (one that numbers
     the game's enums) leaves them out for the night: those modules keep what they had. */
  // The English names of the materials only CN has, for CN-only module costs (cnModuleTables).
  const materialNames = JSON.parse(fs.readFileSync(path.join(root, 'data/material-names.json'), 'utf8'));
  const cnRead = key => JSON.parse(fs.readFileSync(path.join(process.env.ARKPEDIA_CN, 'gamedata', 'excel', fileOf(key)), 'utf8'));
  let cn;
  if (process.env.ARKPEDIA_CN) {
    cn = cnModuleTables(cnRead, materialNames);
  } else if (excel) {
    throw new Error('ARKPEDIA_EN needs ARKPEDIA_CN beside it: the CN tables build the modules Global does not have yet');
  } else {
    try {
      const tables = await catalogue.cnSource(path.join(process.cwd(), '.cache/catalogue'));
      cn = cnModuleTables(key => tables[key], materialNames);
    } catch (error) {
      console.warn(`CN tables unavailable, CN-only modules keep what they had: ${error.message}`);
      cn = null;
    }
  }
  const handbook = process.env.ARKPEDIA_EN_HANDBOOK ? JSON.parse(fs.readFileSync(process.env.ARKPEDIA_EN_HANDBOOK, 'utf8')) : read('handbook');
  const changed = syncOperatorEnglish(root, handbook, {
    characters: read('characters'),
    skills: read('skills'),
    building: read('building'),
    modules: read('modules'),
    battleEquip: read('battleEquip'),
    items: read('items'),
    patch: read('patch'),
    cn,
    voiceTables: [read('voices'), supplementalCharwords],
  });
  console.log(`${changed} operator record(s) refreshed from published Global data.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
