/**
 * Writes the operator records for Amiya's Guard and Medic forms, and the map that lets
 * the operator page offer the switch between all three.
 *
 * WHY THIS IS A SCRIPT. Every other operator record in data/operators-*star came from
 * one bulk import of kukki's wiki scrape, and there is no scraper in the repo to run for
 * two more. Amiya's forms are also the only operators the wiki files under the base
 * character, so they were never going to arrive that way. Generating them from the
 * gamedata means the numbers are the ones global ships, and a rerun picks up a balance
 * pass instead of leaving a hand-written record to rot.
 *
 * WHERE THE FORMS LIVE. Not in character_table. `char_patch_table.json` holds them:
 *
 *   patchChars   char_1001_amiya2 (WARRIOR / artsfghter) and char_1037_amiya3
 *                (MEDIC / incantationmedic), each shaped exactly like a character_table
 *                entry -- phases, skills, talents, potentialRanks, trait.
 *   infos        char_002_amiya -> tmplIds [caster, guard, medic] and a default. This is
 *                the game stating the relationship itself, so the switcher is built from
 *                it rather than from a hardcoded triple that would not notice a fourth.
 *
 * The names are already decided: data/skins.json has filed these forms' skins under the
 * models "Amiya (Guard)" and "Amiya (Medic)" since before this script existed, and the
 * art on disk is named to match. Anything else here would split one operator in two.
 *
 * WHAT IS DERIVED AND WHAT IS INHERITED. The per-form fields -- class, branch, position,
 * trait, skills, talents, potential, promotion, modules -- come from the gamedata. The
 * character-level fields do not exist per form because there is only one Amiya: her
 * profile, voice actors, physical exam, faction and how you obtain her are inherited from
 * data/operators-5star/Amiya.json.
 *
 * Base skills are the exception: they belong to the character, not the form, so they are
 * left EMPTY here rather than copied. /base reads baseSkills off every operator record,
 * and three Amiyas each offering Agreement and Violin Solo would let its optimizer post
 * her to three facilities at once. They stay on Amiya's own page.
 *
 * Two things are deliberately left empty rather than invented here. Module STAGES need the
 * module tables and would mean writing effect text the game did not write, so the modules
 * are listed by name with no stages. The English refresh (operator-english, which runs
 * before this in the content run) builds those stages from the module tables, and the
 * record keeps them: see scripts/lib/amiya-form-modules.mjs. And `guides` is editorial, so
 * a new form's stays empty rather than borrowing a guide written about the Caster; the guides
 * a form's record already has (by hand, or from the guide-videos stage) are kept.
 *
 * Run: node scripts/build/build-amiya-forms.mjs   (wired into scripts/sync/refresh-stage-data.sh)
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripRichText, interpolateBlackboard } from '../lib/gametext.mjs';
import { keepRefreshedModules } from '../lib/amiya-form-modules.mjs';

const ROOT = process.cwd();
const EN = process.env.ARKPEDIA_EN || path.join(ROOT, '.cache/upstream/en-gamedata/en/gamedata');

/**
 * Reads a gamedata table, from the synced upstream checkout first and the loose .cache
 * second. Takes more than one name because the item table is called item_table.json
 * upstream and was cached here as en_item_table.json -- asking for only the local name
 * would have made this script work on this machine and fail on the next refresh, since
 * the sync writes the upstream name.
 */
function readTable(...names) {
  for (const name of names) {
    for (const p of [path.join(EN, 'excel', name), path.join(ROOT, '.cache', name)]) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  throw new Error(
    `${names[0]} not found. Run \`npm run stages:refresh\` to sync the gamedata, `
    + `or fetch it to .cache/${names[0]}.`,
  );
}

const patchTable = readTable('char_patch_table.json');
const skillTable = readTable('skill_table.json');
const equipTable = readTable('uniequip_table.json');
const itemTable = readTable('item_table.json', 'en_item_table.json');

const problems = [];

/* --- the vocabulary the site already speaks -------------------------------------------
   Our records say "Guard", not "WARRIOR", and "Melee", not "MELEE". Branch names are not
   mapped here at all: subProfDict names them, and its spellings ("Arts Fighter",
   "Incantation Medic") are already the ones our other 425 records use. */
const CLASS_BY_PROFESSION = {
  WARRIOR: 'Guard', MEDIC: 'Medic', CASTER: 'Caster', SNIPER: 'Sniper',
  TANK: 'Defender', PIONEER: 'Vanguard', SPECIAL: 'Specialist', SUPPORT: 'Supporter',
};
const POSITION = { MELEE: 'Melee', RANGED: 'Ranged' };
const RARITY = { TIER_1: 1, TIER_2: 2, TIER_3: 3, TIER_4: 4, TIER_5: 5, TIER_6: 6 };

/* How a skill charges and how it fires, in the words our records use. */
const RECOVERY = {
  INCREASE_WITH_TIME: 'Auto Recovery',
  INCREASE_WHEN_ATTACK: 'Offensive Recovery',
  INCREASE_WHEN_TAKEN_DAMAGE: 'Defensive Recovery',
  ON_DEPLOY: 'Deployment Recovery',
};
const ACTIVATION = { MANUAL: 'Manual', AUTO: 'Auto', PASSIVE: 'Passive' };

/* The form's label, which is also the suffix on its name and on its module ids. */
const FORMS = {
  char_002_amiya: { label: 'Caster', suffix: '' },
  char_1001_amiya2: { label: 'Guard', suffix: '2' },
  char_1037_amiya3: { label: 'Medic', suffix: '3' },
};

const itemName = (id) => {
  const n = itemTable?.items?.[id]?.name;
  if (!n) problems.push(`item ${id} has no name in en_item_table.json`);
  return n ?? `item ${id}`;
};

const costList = (entries) => (Array.isArray(entries) ? entries : [])
  .map((c) => ({ name: itemName(c.id), quantity: c.count }));

/** A skill's ten rows: levels 1-7, then M1-M3, the way our records lay them out. */
function skillRows(skill, who) {
  const rows = [];
  for (let i = 0; i < (skill.levels || []).length; i += 1) {
    const lv = skill.levels[i];
    const { text, missing } = interpolateBlackboard(lv.description, lv.blackboard);
    if (missing.length) {
      problems.push(`${who} "${lv.name}" level ${i + 1}: no blackboard value for ${missing.join(', ')}`);
    }
    rows.push({
      level: i < 7 ? i + 1 : null,
      mastery: i < 7 ? null : i - 6,
      description: text,
      initialSp: lv.spData?.initSp ?? 0,
      spCost: lv.spData?.spCost ?? 0,
      duration: lv.duration != null && lv.duration > 0 ? Math.round(lv.duration) : null,
    });
  }
  return rows;
}

/** Talent candidates collapsed into one entry per talent, one row per unlock. */
function talentsOf(character) {
  const out = [];
  for (const talent of character.talents || []) {
    const rows = [];
    let name = null;
    for (const c of talent.candidates || []) {
      name = c.name || name;
      const phase = Number(String(c.unlockCondition?.phase ?? '').replace('PHASE_', '')) || 0;
      rows.push({
        stage: phase === 0 ? 'Base' : `Elite ${phase}`,
        potential: c.requiredPotentialRank ? `Potential ${c.requiredPotentialRank + 1}` : null,
        description: stripRichText(c.description),
      });
    }
    if (name) out.push({ name, rows });
  }
  return out;
}

/**
 * Elite 1 and Elite 2.
 *
 * The materials are the form's own, and they read as CASTER chips, which looks wrong and
 * is not: the game bills all three forms to one promotion, so char_1001_amiya2's own
 * evolveCost is Amiya's. Promoting the Guard is promoting Amiya.
 *
 * The LMD is not in the table at all -- promotion LMD is a flat amount per rarity -- so
 * it is taken from the Caster's record, which is the same character at the same rarity
 * and already carries the right figure.
 */
function promotionOf(character, baseRecord, displayName) {
  const phases = character.phases || [];
  const out = [];
  for (let phase = 1; phase < phases.length; phase += 1) {
    const prev = phases[phase - 1];
    const upgrades = ['Maximum attributes increased.'];

    /* A skill whose unlock names this phase is new at this promotion. */
    for (const s of character.skills || []) {
      const at = Number(String(s.unlockCond?.phase ?? '').replace('PHASE_', ''));
      if (at === phase) {
        const nm = skillTable[s.skillId]?.levels?.[0]?.name;
        if (nm) upgrades.push(`New skill: ${nm}.`);
      }
    }
    /* DP cost is per phase, read off the first keyframe because it does not move with
       level within a phase. Only mentioned when it actually changes: the Guard gains 2 at
       Elite 1 and nothing at Elite 2. */
    const dpAt = (p) => p?.attributesKeyFrames?.[0]?.data?.cost ?? null;
    const dpBefore = dpAt(prev);
    const dpAfter = dpAt(phases[phase]);
    if (dpBefore != null && dpAfter != null && dpAfter !== dpBefore) {
      const delta = dpAfter - dpBefore;
      upgrades.push(`DP cost ${delta > 0 ? '+' : ''}${delta}.`);
    }
    if (phases[phase].rangeId !== prev.rangeId) upgrades.push('Range extended.');
    if (phase === 2) upgrades.push('Operator Modules available.');

    const lmd = (baseRecord.promotion?.[phase - 1]?.cost || [])
      .filter((c) => c.name === 'LMD');
    if (!lmd.length) problems.push(`${displayName}: no promotion LMD on Amiya's own Elite ${phase} to borrow`);

    out.push({
      tier: `Elite ${phase}`,
      upgrades,
      prerequisite: phase === 1
        ? `Raise ${displayName} to Level ${prev.maxLevel}.`
        : `Raise ${displayName} to Elite ${phase - 1} Level ${prev.maxLevel}.`,
      cost: [...lmd, ...costList(phases[phase].evolveCost)],
    });
  }
  return out;
}

/**
 * The form's modules.
 *
 * All three forms' modules are filed under char_002_amiya, told apart only by the id
 * suffix -- uniequip_002_amiya2 is the Guard's. Named the way our records name them:
 * "AFT-X: Anger to be Tuned", from the two type words and the module's own name.
 */
function modulesOf(charId) {
  const { suffix } = FORMS[charId];
  const out = [];
  for (const [equipId, eq] of Object.entries(equipTable.equipDict || {})) {
    const m = /^uniequip_\d+_amiya(\d?)$/.exec(equipId);
    if (!m || m[1] !== suffix) continue;
    if (eq.typeName1 === 'ORIGINAL' || !eq.typeName2) {
      out.push({ type: 'Original', name: eq.uniEquipName, stages: [] });
    } else {
      out.push({ type: 'Upgrade', name: `${eq.typeName1}-${eq.typeName2}: ${eq.uniEquipName}`, stages: [] });
    }
  }
  /* Original first, the way the page reads them and the way our other records store them. */
  return out.sort((a, b) => (a.type === 'Original' ? -1 : 1) - (b.type === 'Original' ? -1 : 1));
}

function buildForm(charId, baseRecord, skinsByModel) {
  const c = patchTable.patchChars?.[charId];
  if (!c) { problems.push(`${charId} is not in char_patch_table.patchChars`); return null; }

  const { label } = FORMS[charId];
  const displayName = `${baseRecord.name} (${label})`;
  const branch = equipTable.subProfDict?.[c.subProfessionId]?.subProfessionName;
  if (!branch) problems.push(`${displayName}: subProfDict has no name for "${c.subProfessionId}"`);
  const klass = CLASS_BY_PROFESSION[c.profession];
  if (!klass) problems.push(`${displayName}: no class name for profession "${c.profession}"`);

  const skillList = (c.skills || []).map((s) => {
    const skill = skillTable[s.skillId];
    if (!skill) { problems.push(`${displayName}: skill "${s.skillId}" is not in skill_table.json`); return null; }
    const first = skill.levels?.[0] || {};
    const masteries = s.levelUpCostCond || [];
    return {
      name: first.name,
      recoveryType: RECOVERY[first.spData?.spType] ?? null,
      activationType: ACTIVATION[first.skillType] ?? null,
      duration: first.duration > 0 ? `${Math.round(first.duration)} seconds` : null,
      levels: skillRows(skill, displayName),
      recommendation: [],
      cost: {
        m1: costList(masteries[0]?.levelUpCost),
        m2: costList(masteries[1]?.levelUpCost),
        m3: costList(masteries[2]?.levelUpCost),
      },
      pairings: [],
      techniques: [],
    };
  }).filter(Boolean);

  /* Skill LEVELS 2-7 cost the same for every skill an operator has, which is why our
     records keep them once per operator rather than once per skill. */
  const skillCost = {};
  (c.allSkillLvlup || []).forEach((step, i) => {
    skillCost[String(i + 2)] = costList(step.lvlUpCost);
  });

  return {
    name: displayName,
    internalName: charId,
    rarity: RARITY[c.rarity] ?? null,
    class: klass ?? null,
    branch: branch ?? null,
    position: POSITION[c.position] ?? null,
    trait: stripRichText(c.description),
    tags: c.tagList || [],
    /* One character, so these are hers whichever form is on the field. */
    faction: baseRecord.faction,
    region: baseRecord.region,
    subRegion: baseRecord.subRegion,
    umbrellaFactions: baseRecord.umbrellaFactions,
    connectedFactions: baseRecord.connectedFactions,
    ep: baseRecord.ep,
    howToObtain: baseRecord.howToObtain,
    characterInfo: baseRecord.characterInfo,
    characterVoices: baseRecord.characterVoices,
    basicInfo: baseRecord.basicInfo,
    physicalExam: baseRecord.physicalExam,
    otherLanguages: baseRecord.otherLanguages,
    review: baseRecord.review,
    /* EMPTY ON PURPOSE, and the one inherited field that is not inherited.
       A base skill belongs to the character: building_data has no entry for either form,
       and in game you assign Amiya to a facility, not a form of her. Copying them here
       would put the same two skills on three operators, and /base reads baseSkills off
       every operator record -- so the optimizer would happily post Amiya to the Control
       Center and both Dormitories at once. They stay on Amiya's own page, which the
       switcher in the header is one click away from. */
    baseSkills: [],
    potential: {
      levels: (c.potentialRanks || []).map((p, i) => ({
        level: i + 2,
        benefit: stripRichText(p.description),
      })),
      totalCost: baseRecord.potential?.totalCost ?? [],
    },
    promotion: promotionOf(c, baseRecord, displayName),
    modules: modulesOf(charId),
    skills: { skillList, skillCost },
    talents: talentsOf(c),
    skins: skinsByModel.get(displayName) ?? [],
    synergies: [],
    techniques: [{ technique: null, techniqueDescription: null, description: null }],
    /* `alternate` names an operator's ALTERS, which is a different relationship: an alter
       is its own operator. A form is the same operator, and lives in operator-forms.json. */
    alternate: null,
    guides: [],
  };
}

/* --- go ------------------------------------------------------------------------------ */

const basePath = path.join(ROOT, 'data/operators-5star/Amiya.json');
if (!fs.existsSync(basePath)) {
  console.error(`[amiya-forms] ${basePath} is missing, and the forms inherit from it.`);
  process.exit(1);
}
const baseRecord = JSON.parse(fs.readFileSync(basePath, 'utf8'));

const skinsByModel = new Map();
for (const skin of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/skins.json'), 'utf8'))) {
  if (!skin.model) continue;
  if (!skinsByModel.has(skin.model)) skinsByModel.set(skin.model, []);
  skinsByModel.get(skin.model).push(skin.name);
}

/* The switcher's contents, taken from the game's own statement of the relationship. */
const infos = patchTable.infos?.[baseRecord.internalName];
if (!infos) {
  console.error(`[amiya-forms] char_patch_table.infos has no entry for ${baseRecord.internalName},`);
  console.error('which is where the list of forms comes from. The table shape may have changed.');
  process.exit(1);
}

const written = [];
for (const charId of infos.tmplIds) {
  if (!FORMS[charId]) {
    problems.push(`char_patch_table lists a form this script has no label for: ${charId}`);
    continue;
  }
  if (charId === baseRecord.internalName) continue; // the Caster already has a record
  const record = buildForm(charId, baseRecord, skinsByModel);
  if (!record) continue;
  written.push({ charId, record });
}

/* The map the page reads: every form of an operator, by that operator's own name. Built
   from tmplIds so a future form appears without another edit here. */
const formsIndex = {};
{
  const nameOf = (charId) => (charId === baseRecord.internalName
    ? baseRecord.name
    : `${baseRecord.name} (${FORMS[charId]?.label})`);
  const forms = infos.tmplIds
    .filter((id) => FORMS[id])
    .map((id) => ({ name: nameOf(id), label: FORMS[id].label, internalName: id }));
  for (const f of forms) {
    formsIndex[f.name] = { forms, default: nameOf(infos.default) };
  }
}

if (problems.length) {
  console.error('\n[amiya-forms] the gamedata and our records disagree:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nNothing was written. A missing blackboard value would print a raw {key}');
  console.error('on the page, and a form with no label would vanish from the switcher.');
  process.exit(1);
}

for (const { record } of written) {
  const file = path.join(ROOT, `data/operators-${record.rarity}star/${record.name}.json`);
  // CSV stats and archives are imported independently and belong to THIS form.
  // A later skill/module refresh must not erase them or copy the Caster's files.
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.internalName === record.internalName) {
      if (existing.stats) record.stats = existing.stats;
      if (existing.files) record.files = existing.files;
      // The form's own guides, added by hand or by the guide-videos stage, never the Caster's.
      if (Array.isArray(existing.guides) && existing.guides.length) record.guides = existing.guides;
      // The English refresh, which ran first, built the modules' stages and costs.
      record.modules = keepRefreshedModules(record.modules, existing.modules);
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, file)} -- ${record.class} / ${record.branch}, `
    + `${record.skills.skillList.length} skills, ${record.talents.length} talents, ${record.skins.length} skins`);
}

fs.writeFileSync(
  path.join(ROOT, 'data/operator-forms.json'),
  `${JSON.stringify(formsIndex, null, 2)}\n`,
);
console.log(`  wrote data/operator-forms.json -- ${Object.keys(formsIndex).length} names share ${infos.tmplIds.length} forms`);
