#!/usr/bin/env node
/**
 * Writes data/game-account-map.json: the game's own ids for each operator and module,
 * resolved to the planner's names and positions, for importing a Global account
 * (lib/planner/gameAccount.ts; the sign-in is lib/account-import).
 *
 * The account the game server sends names an operator by its character id
 * ("char_225_haak") and a module by its equipment id ("uniequip_003_haak"). Neither
 * is derivable from our names, so both are mapped here from the operator records and
 * the EN client's tables, and the content release carries the result (the planner's
 * 'game-account-map' table), so a new operator needs no redeploy.
 *
 *   - An operator: the record's internalName IS the character id. Every record has one.
 *   - A module: by its type code, not its position. The client lists an operator's
 *     modules in release order (Fiammetta's Y came before her X); the planner numbers
 *     them as the record does, X before Y. The record writes the code in front of the
 *     name ("ART-X: A Long Journey"), the client in typeName1/typeName2 ("ART", "X"),
 *     with the Greek letters spelled A, B and D. Names are no use: the record and the
 *     client translate some differently ("Memorial Light", "Commemorative Light").
 *   - A skill: by position, which the import reads masteries by. Checked here: every
 *     operator the EN client has must list the same skills, in the same order, as its
 *     record (all 412 did on 2026-10-01).
 *
 * Anything that does not line up fails the run, naming it, and the refresh keeps
 * yesterday's map (its stage). An import with a stale map only misses what is new.
 *
 * Re-run after an upstream refresh:  npx tsx scripts/build/build-game-account-map.ts
 */
import fs from 'fs';
import path from 'path';
import { getFactionIconPath } from '../../lib/operators/classBranchIcons';
import { bannerPoolNames } from '../../lib/gacha/bannerPools';

const root = process.cwd();
const upstream = process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata';
const excel = path.join(upstream, 'en', 'gamedata', 'excel');
const OUTPUT = path.join(root, 'data', 'game-account-map.json');

interface RecordFile {
  name: string;
  rarity?: number;
  internalName?: string;
  modules?: { type?: string; name: string }[];
  skills?: { skillList?: { name?: string }[] };
}

export interface GameAccountMapFile {
  version: 1;
  beginnerPrograms?: { id: string; startTs: number; endTs?: number; missionIds?: string[] }[];
  /** character id -> the record's name, by equipment id the planner's module index, and
   *  whether the Global client has it (the account page's operator count). */
  /** formOf: for another form of one character (Amiya's Guard and Medic), the character id
   *  of its default form, so the account page counts the character once, as the game does. */
  /** nation: the game's nation for it (character_table's nationId), by the name in `nations`,
   *  so the card lights a nation's emblem only once every one of its operators is owned. */
  chars: Record<string, { name: string; rarity: number; modules: Record<string, number>; global?: true; formOf?: string; nation?: string }>;
  /** The profile card's names (the account page): each business card style's, by id, and
   *  each medal's, from the EN client's display_meta_table and medal_table. */
  nameCards: Record<string, string>;
  /** Each card style's subtitle under its name (themeEnName: "An invitation to moons"). */
  nameCardThemes: Record<string, string>;
  /** How many variants a style has, for one with several (skinTmplCnt), and the styles with
   *  no theme of their own (isSpTheme false: Default Skin, Determination), which show the
   *  assistant's illustration and name instead. */
  nameCardVariants: Record<string, number>;
  nameCardPlain: string[];
  /** Each theme's colours, from its bundle in the client (data/namecard-styles.json,
   *  scripts/imports/import-namecard-styles.py): the accent and the text on it, and the
   *  right-hand panels, their text and their icons. */
  nameCardStyles: Record<string, NameCardStyle>;
  medals: Record<string, string>;
  /** The nations whose emblems the card's Operator Hiring Progress shows, in the game's
   *  order (handbook_team_table's nations, powerLevel 0), by the name their emblem
   *  (/faction-icons/) is filed under. */
  nations: string[];
  /** Each module's type mark by its equipment id, and each skill's icon where another
   *  skill's is shared: what a support unit shown full length draws. */
  moduleTypes: Record<string, string>;
  skillIcons: Record<string, string>;
  /** Each Global pool's banner name, by pool id, from the banner records (the pull history). */
  pools: Record<string, string>;
}

export interface NameCardStyle { theme: string; themeText: string; panel: string; panelText: string; panelIcon: string }

const GREEK: Record<string, string> = { A: 'α', B: 'β', D: 'Δ' };
// This mirror writes an empty list as {} (Lancet-2's skills).
const list = <T>(value: T[] | Record<string, never> | null | undefined): T[] => (Array.isArray(value) ? value : []);
const norm = (text: string | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function buildGameAccountMap(
  records: RecordFile[],
  tables: {
    uniequip: { charEquip: Record<string, string[] | Record<string, never>>; equipDict: Record<string, { type?: string; typeName1?: string; typeName2?: string | null; typeIcon?: string | null }> };
    characters: Record<string, { skills?: { skillId?: string | null }[] | Record<string, never> | null; nationId?: string | null }>;
    skills: Record<string, { levels?: { name?: string }[]; iconId?: string | null }>;
    displayMeta?: { nameCardV2Data?: { skinData?: Record<string, { name?: string; themeEnName?: string; skinTmplCnt?: number; isSpTheme?: boolean }> } };
    teams?: Record<string, { powerLevel?: number; powerName?: string; orderNum?: number }>;
    /** data/namecard-styles.json's themes. */
    styles?: Record<string, NameCardStyle & { md5?: string }>;
    /** data/operator-forms.json: each form's name and character id, and the default form. */
    forms?: Record<string, { forms?: { name: string; internalName?: string }[]; default?: string }>;
    medalTable?: { medalList?: { medalId?: string; medalName?: string }[] };
    /** data/headhunting_banners.json. */
    banners?: { name?: string; globalPoolId?: string | null }[];
    openServer?: { schedule?: { id: string; startTs: number; endTs?: number }[]; dataMap?: Record<string, { openServerMissionGroup?: { missionIds?: unknown } | null; openServerMissionData?: unknown[] }> };
  },
): GameAccountMapFile {
  const problems: string[] = [];
  const chars: GameAccountMapFile['chars'] = {};
  for (const record of [...records].sort((a, b) => (a.internalName ?? '').localeCompare(b.internalName ?? ''))) {
    const id = record.internalName;
    if (!id) { problems.push(`${record.name} has no internalName`); continue; }
    if (chars[id]) { problems.push(`${record.name} and ${chars[id].name} share ${id}`); continue; }

    const codes = (record.modules ?? []).filter((module) => module.type !== 'Original')
      .map((module) => /^([A-Z]{2,4})-([^:\s]{1,3}):/.exec(module.name)?.slice(1, 3) ?? null);
    const modules: Record<string, number> = {};
    for (const equipId of list(tables.uniequip.charEquip[id])) {
      const equip = tables.uniequip.equipDict[equipId];
      if (!equip || equip.type === 'INITIAL') continue;
      const letter = equip.typeName2 ?? '';
      const matches = codes.flatMap((code, index) => (code && code[0] === equip.typeName1 && (code[1] === letter || code[1] === GREEK[letter]) ? [index] : []));
      if (matches.length === 1) modules[equipId] = matches[0];
      else problems.push(`${record.name}: the client's ${equipId} (${equip.typeName1}-${letter}) matches ${matches.length} of the record's modules (${codes.map((code) => code?.join('-') ?? '?').join(', ') || 'none'})`);
    }

    const character = tables.characters[id];
    if (character) {
      const game = list(character.skills).filter((skill) => skill.skillId).map((skill) => norm(tables.skills[skill.skillId!]?.levels?.[0]?.name));
      const ours = (record.skills?.skillList ?? []).map((skill) => norm(skill.name));
      if (game.join('|') !== ours.join('|')) problems.push(`${record.name}: the client's skills (${game.join(', ')}) are not the record's (${ours.join(', ')}), in order`);
    }
    const nation = character?.nationId ? tables.teams?.[character.nationId] : undefined;
    chars[id] = { name: record.name, rarity: record.rarity ?? 1, modules, ...(character ? { global: true as const } : {}),
      ...(nation?.powerLevel === 0 && nation.powerName && character!.nationId !== 'none' ? { nation: nation.powerName } : {}) };
  }
  for (const entry of Object.values(tables.forms ?? {})) {
    const base = entry.forms?.find((form) => form.name === entry.default)?.internalName;
    for (const form of entry.forms ?? []) {
      if (base && form.internalName && form.internalName !== base && chars[form.internalName]) chars[form.internalName].formOf = base;
    }
  }
  if (problems.length) throw new Error(`build-game-account-map: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  const nameCards = Object.fromEntries(Object.entries(tables.displayMeta?.nameCardV2Data?.skinData ?? {})
    .filter(([, skin]) => typeof skin?.name === 'string').map(([id, skin]) => [id, skin.name as string]).sort(([a], [b]) => a.localeCompare(b)));
  const medals = Object.fromEntries((tables.medalTable?.medalList ?? [])
    .filter((medal) => medal.medalId && medal.medalName).map((medal) => [medal.medalId as string, medal.medalName as string]).sort(([a], [b]) => a.localeCompare(b)));
  const nameCardThemes = Object.fromEntries(Object.entries(tables.displayMeta?.nameCardV2Data?.skinData ?? {})
    .filter(([, skin]) => typeof skin?.themeEnName === 'string' && skin.themeEnName).map(([id, skin]) => [id, skin.themeEnName as string]).sort(([a], [b]) => a.localeCompare(b)));
  const nations = Object.entries(tables.teams ?? {})
    .filter(([id, team]) => id !== 'none' && team.powerLevel === 0 && typeof team.powerName === 'string')
    .sort(([, a], [, b]) => (a.orderNum ?? 0) - (b.orderNum ?? 0)).map(([, team]) => team.powerName as string);
  const styles = Object.entries(tables.displayMeta?.nameCardV2Data?.skinData ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const nameCardVariants = Object.fromEntries(styles.filter(([, skin]) => (skin.skinTmplCnt ?? 0) > 1).map(([id, skin]) => [id, skin.skinTmplCnt as number]));
  const nameCardPlain = styles.filter(([, skin]) => skin.isSpTheme === false).map(([id]) => id);
  const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
  const nameCardStyles = Object.fromEntries(Object.entries(tables.styles ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, style]) => [style.theme, style.themeText, style.panel, style.panelText, style.panelIcon].every((value) => HEX.test(value)))
    .map(([id, { theme, themeText, panel, panelText, panelIcon }]) => [id, { theme, themeText, panel, panelText, panelIcon }]));
  /* What a support unit shown full length carries (components/account/ProfileCard): its
     module's mark, by the game's type icon (arkpedia-image-assets' profile-modules), and its
     skill's icon, which is the skill id except where the skill shares another's icon. */
  const moduleTypes = Object.fromEntries(Object.entries(tables.uniequip.equipDict)
    .filter(([, equip]) => equip.type === 'ADVANCED' && typeof equip.typeIcon === 'string' && /^[\w-]+$/.test(equip.typeIcon))
    .map(([id, equip]) => [id, (equip.typeIcon as string).toLowerCase()]).sort(([a], [b]) => a.localeCompare(b)));
  const skillIcons = Object.fromEntries(Object.entries(tables.skills)
    .filter(([id, skill]) => typeof skill.iconId === 'string' && skill.iconId && skill.iconId !== id)
    .map(([id, skill]) => [id, skill.iconId as string]).sort(([a], [b]) => a.localeCompare(b)));
  return { version: 1, chars, nameCards, nameCardThemes, nameCardVariants, nameCardPlain, nameCardStyles, medals, nations, moduleTypes, skillIcons,
    ...(tables.openServer ? { beginnerPrograms: beginnerPrograms(tables.openServer) } : {}),
    pools: bannerPoolNames(tables.banners ?? []) };
}

/** The Global beginner programmes (open_server_table), oldest first: each one's window, and the
 *  ids of its missions, which the save marks done as a whole under the programme's own id in
 *  mission.missionGroups (lib/account/rewardClaims.ts). */
function beginnerPrograms(openServer: NonNullable<Parameters<typeof buildGameAccountMap>[1]['openServer']>) {
  return (openServer.schedule ?? []).filter(row => /^[\w-]+$/.test(row.id) && Number.isSafeInteger(row.startTs)).sort((a, b) => a.startTs - b.startTs).map(row => {
    const ids = openServer.dataMap?.[row.id]?.openServerMissionGroup?.missionIds;
    const missionIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && /^[\w-]+$/.test(id)) : [];
    // A programme with missions and no group to name them would silently stop the import's
    // group tick (lib/account/rewardClaims.ts): fail the run instead.
    if (openServer.dataMap?.[row.id]?.openServerMissionData?.length && !missionIds.length) throw new Error(`build-game-account-map: beginner programme ${row.id} has missions but no openServerMissionGroup.missionIds`);
    return { id: row.id, startTs: row.startTs, ...(Number.isSafeInteger(row.endTs) ? { endTs: row.endTs } : {}), ...(missionIds.length ? { missionIds } : {}) };
  });
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  for (const file of ['uniequip_table.json', 'character_table.json', 'char_patch_table.json', 'skill_table.json', 'display_meta_table.json', 'medal_table.json', 'handbook_team_table.json']) {
    if (!fs.existsSync(path.join(excel, file))) {
      console.error(`Missing ${path.join(excel, file)}.\nRun scripts/sync/refresh-stage-data.sh to populate .cache/upstream, or set ARKPEDIA_EN.`);
      process.exit(1);
    }
  }
  const records = fs.readdirSync(path.join(root, 'data'))
    .filter((folder) => /^operators-[1-6]star$/.test(folder))
    .flatMap((folder) => fs.readdirSync(path.join(root, 'data', folder)).filter((file) => file.endsWith('.json'))
      .map((file) => readJson<RecordFile>(path.join(root, 'data', folder, file))));
  const patch = readJson<{ patchChars?: Record<string, { skills?: { skillId?: string | null }[] | Record<string, never> | null }> }>(path.join(excel, 'char_patch_table.json'));
  const map = buildGameAccountMap(records, {
    uniequip: readJson(path.join(excel, 'uniequip_table.json')),
    characters: { ...readJson<Record<string, { skills?: { skillId?: string | null }[] | Record<string, never> | null; nationId?: string | null }>>(path.join(excel, 'character_table.json')), ...(patch.patchChars ?? {}) },
    skills: readJson(path.join(excel, 'skill_table.json')),
    displayMeta: readJson(path.join(excel, 'display_meta_table.json')),
    medalTable: readJson(path.join(excel, 'medal_table.json')),
    teams: readJson(path.join(excel, 'handbook_team_table.json')),
    styles: fs.existsSync(path.join(root, 'data', 'namecard-styles.json')) ? readJson<{ themes: Record<string, NameCardStyle> }>(path.join(root, 'data', 'namecard-styles.json')).themes : {},
    forms: fs.existsSync(path.join(root, 'data', 'operator-forms.json')) ? readJson(path.join(root, 'data', 'operator-forms.json')) : {},
    banners: readJson(path.join(root, 'data', 'headhunting_banners.json')),
    openServer: readJson(path.join(excel, 'open_server_table.json')),
  });
  // Each nation's emblem must be published, or the card shows a broken image: a nation the
  // game adds, or an emblem filed under another name, fails the run (the stage keeps yesterday's).
  const published = new Set(readJson<{ files: string[] }>(path.join(root, 'data', 'assets', 'external-asset-index.json')).files.map((file) => file.normalize('NFC')));
  const unfiled = map.nations.filter((nation) => !published.has(getFactionIconPath(nation)!.slice(1).normalize('NFC')));
  if (!map.nations.length || unfiled.length) {
    console.error(`build-game-account-map: ${map.nations.length ? `no emblem in faction-icons/ for ${unfiled.join(', ')}; publish one or alias it in lib/operators/classBranchIcons.ts` : 'handbook_team_table lists no nations'}.`);
    process.exit(1);
  }
  fs.writeFileSync(OUTPUT, `${JSON.stringify(map)}\n`);
  const modules = Object.values(map.chars).reduce((sum, char) => sum + Object.keys(char.modules).length, 0);
  console.log(`Wrote ${path.relative(root, OUTPUT)}: ${Object.keys(map.chars).length} operators, ${modules} modules, ${Object.keys(map.nameCards).length} card styles, ${Object.keys(map.medals).length} medals, ${map.nations.length} nations, ${Object.keys(map.nameCardStyles).length} theme colours.`);
  const uncoloured = Object.keys(map.nameCards).filter((id) => !map.nameCardStyles[id]);
  if (uncoloured.length) console.warn(`build-game-account-map: no colours for ${uncoloured.join(', ')}; the card draws them in the default blue until import-namecard-styles.py reads their bundles.`);
}
