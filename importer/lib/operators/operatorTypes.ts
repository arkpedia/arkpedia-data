import type { OperatorStats, OperatorFile } from './operatorStats';
import type { ObtainMethod, WelfareSource } from './obtainMethods';

export interface CostItem {
  name: string;
  quantity: number | string;
}

export type CostGroup = CostItem[];

export interface PotentialLevel {
  level: number;
  benefit: string;
}

export interface Potential {
  levels: PotentialLevel[];
  totalCost: CostGroup;
}

export interface PromotionTier {
  tier: string;
  upgrades: string[];
  prerequisite: string | null;
  cost: CostGroup;
}

export interface SkillLevel {
  level: number | null;
  mastery: number | null;
  description: string | null;
  initialSp: number | string | null;
  spCost: number | string | null;
  duration: number | string | null;
}

export interface SkillMasteryCost {
  m1: CostGroup;
  m2: CostGroup;
  m3: CostGroup;
}

export interface PairingEntry {
  class: string | null;
  branch: string | null;
  technique: string | null;
  techniqueDescription: string | null;
  description: string | null;
}

export interface SkillTechnique {
  name: string | null;
  unit?: string | null; // references another operator by name -- their icon should display instead of a text name
  branch?: string | null; // references a real Arknights branch (has an icon) -- up to 5 operators of that branch should display alongside the technique
  group?: string | null; // references a custom/fictional grouping with no real icon (e.g. "Laios's Party") -- shown as a text label instead of an icon
  members?: string[] | null; // operator names belonging to "group" -- supplied directly in the JSON since there's no confirmed roster or icon to resolve this from
  description: string | null;
}

export interface SkillRecommendationEntry {
  mastery: string | null; // e.g. "m1", "m2", "m3"
  order: string | null; // e.g. "1st", "2nd" -- overall priority ranking across this operator's skills
  priority: 'main' | 'sub' | null;
  explanation: string | null;
}

export interface Skill {
  name: string | null;
  icon: string | null;
  recoveryType: string | null;
  activationType: string | null;
  duration: string | null;
  recommendation?: SkillRecommendationEntry[] | null; // manually populated -- one or more per-mastery-level recommendations
  levels: SkillLevel[];
  cost?: SkillMasteryCost | null; // new schema: this skill's own mastery 1/2/3 material costs
  pairings?: PairingEntry[] | null; // manually populated -- recommended class/branch/technique pairings for this skill (the refresh guard, handWrittenFields, compares it by this name)
  techniques?: SkillTechnique[] | null; // manually populated -- named play patterns/tips for this specific skill
}

export interface TalentRow {
  name?: string | null;
  stage: string | null;
  potential: string | null;
  description: string | null;
}

export interface Talent {
  name: string | null;
  rows: TalentRow[];
  technique?: SkillTechnique[] | null; // manually populated -- not every talent has one
}

/** A keyword the game explains in a base skill's description, with the game's own definition
 *  (gamedata_const termDescriptionDict, via scripts/imports/import-base-skills.mjs). */
export interface BaseSkillKeyword {
  /** The words in `description` that carry it. */
  text: string;
  term: string;
  name: string;
  definition: string;
}

export interface BaseSkill {
  buffId?: string;
  name: string | null;
  rawName?: string | null; // original un-cleaned name (before stripping any "ReplacesX" suffix) -- icon filenames match this, not the cleaned display name
  icon: string | null;
  facility: string | null;
  eliteLevel: string | null;
  description: string | null;
  keywords?: BaseSkillKeyword[];
  /* From the game's building_data (scripts/sync/sync-operator-english.mjs): the buffChar entry
     the skill belongs to (same slot = an upgrade chain), and the promotion and level that unlock
     it. Absent on records the refresh has not rebuilt yet. */
  slot?: number;
  phase?: number;
  level?: number;
}

export interface ModuleStage {
  stage: string | null;
  attributesIncreased: string | null;
  effectLabel: string | null;
  effectText: string | null;
  cost?: CostGroup; // new schema: this stage's own build requirement materials
}

export interface ModuleMission {
  requirement1?: string | null;
  requirement2?: string | null;
  [key: string]: string | null | undefined;
}

export interface OperatorModule {
  moduleId?: string; // immutable uniEquipId from the regional game dump
  type: 'Original' | 'Upgrade';
  icon?: string | null;
  badgeText?: string | null;
  name?: string | null; // new schema: e.g. "Aak's Badge" or "GEE-X: Mixed-Fruit Medical Caddy"
  mission?: ModuleMission | null; // new schema: unlock requirements, Upgrade-type only
  stages: ModuleStage[];
}

export interface ReviewInfo {
  official: string | null;
  url: string | null;
  editor: string | null;
}

export type SynergyType = 'branch' | 'faction' | 'tag' | 'category' | 'unit';

export interface SynergyEntry {
  type: SynergyType;
  values: string[]; // one or more branch names, faction names, or free-text category labels, depending on `type`
  description: string | null;
}

export interface TechniqueEntry {
  technique: string | null;
  techniqueDescription: string | null;
  description: string | null;
}

export interface GuideEntry {
  videoId: string;
  label?: string | null;
  /** The channel that made it, as the records write it (e.g. "kukkikaze"). */
  creator?: string | null;
}

// A welfare unit is free, obtained only during a specific time window
// through a non-gacha, non-recruitment method (Record Restore, Main
// Story Unlock, IS Exclusive, a limited-time free giveaway, etc.).
// "Limited Welfare" specifically covers the free-giveaway case, which
// is NOT the same thing as the separate howToObtain.Limited flag --
// that flag means "obtainable via the Limited Headhunting gacha
// banner." A Limited Welfare unit is never pullable at all, only ever
// given away for free during a rerun window.
export interface WelfareUnlockInfo {
  'Unlock Type': string; // the real howToObtain method, e.g. "Record Restore", "Main Story Unlock", "IS Exclusive", "Limited Welfare"
  'Unlock Location': string; // the associated event name
}
// Every other howToObtain method (Recruitment, Limited, Standard
// Headhunting, Kernel Headhunting, Shop Operator) stays a plain
// "Yes"/"No" string. Only Welfare's value can be an object -- its
// presence as an object (rather than the string "No") is what marks
// an operator as a welfare unit at all.
export type HowToObtainValue = string | WelfareUnlockInfo;
export type HowToObtainInfo = Record<string, HowToObtainValue>;

function asHowToObtainInfo(howToObtain: string | Record<string, unknown> | null | undefined): HowToObtainInfo | null {
  if (!howToObtain || typeof howToObtain === 'string') return null;
  return howToObtain as HowToObtainInfo;
}

/** The welfare unlock details (type + event), or null if this isn't a welfare unit (or the value is
 * still the old plain "No" string): the one place the object-shape check lives, which every
 * consumer asks (lib/operators/obtainMethods.ts). */
export function getWelfareInfo(howToObtain: string | Record<string, unknown> | null | undefined): WelfareUnlockInfo | null {
  const info = asHowToObtainInfo(howToObtain);
  const w = info?.['Welfare'];
  return typeof w === 'object' && w !== null ? (w as WelfareUnlockInfo) : null;
}

export interface Operator {
  /** Previous public names remain valid after official Global localization. */
  aliases?: string[];
  sourceRegion?: 'CN' | 'Global';
  name: string;
  rarity: number | null;
  class: string | null;
  branch: string | null;
  faction: string | null;
  // The three faction tiers from the AN-EN-Tags source: `faction`
  // above is "main" (unchanged field name/meaning, since it's used
  // pervasively across the codebase already -- synergies, techniques,
  // the guesser, etc.). These two are new and both optional, since
  // most operators only have a main faction and nothing else.
  umbrellaFactions?: string[];
  connectedFactions?: string[];
  position: string | null;
  tags: string[];
  // Most operators have a single trait string. Some (e.g. Zuo Le) have a
  // trait that scales with promotion, shown as tabs on the wiki -- for
  // those, this is an object like { Base: "...", "Elite 1": "...", "Elite 2": "..." }
  trait: string | Record<string, string> | null;
  howToObtain: string | HowToObtainInfo | null;
  alternate: string | null;
  potential: Potential;
  promotion: PromotionTier[];
  skills: Skill[] | { skillList: Skill[]; skillCost: Record<string, CostGroup> | null };
  talents?: Talent[];
  baseSkills?: BaseSkill[];
  modules?: OperatorModule[];
  review?: ReviewInfo | null; // manually populated
  synergies?: SynergyEntry[] | null; // manually populated
  techniques?: TechniqueEntry[] | null; // manually populated
  guides?: GuideEntry[] | null; // manually populated
  basedOn?: string | null;
  etymology?: string | null;
  ep?: string | Record<string, string> | null; // new schema: { Main, "Co-star" }
  internalName?: string | null;
  stats?: OperatorStats;
  files?: OperatorFile[];
  skins?: string[]; // new schema: skin names, from the scraper's portrait tabber
  region?: string | null;
  subRegion?: string | null;
  otherLanguages?: Record<string, string> | null;
  /** Confirmed Global release instant, including timezone. */
  releaseAt?: string;
  /** Until when the debut lasts, exclusive: its banner, or an event operator's event stages
   *  (getScheduledOperatorDebut). The roster's "Now Available" ends here. */
  availableUntil?: string;
  characterInfo?: Record<string, string> | null;
  characterVoices?: Record<string, string> | null;
  basicInfo?: Record<string, string> | null;
  physicalExam?: Record<string, string> | null;
  // True for operators sourced only from future_operator_icons/ -- shown
  // in the roster with just their name/icon since full wiki data doesn't
  // exist for them yet (not released / not yet scraped).
  isFuture?: boolean;
  /** True while the image repository has no roster portrait for this operator, so
   *  getOperatorIconPath shows the placeholder. Resolved on the server against the
   *  release's asset index (lib/operators/operatorPortrait.ts); omitted when false. */
  portraitPending?: boolean;
}

// A lightweight projection of Operator for pages that only need
// listing/filtering metadata (e.g. the roster index) -- avoids shipping
// every operator's full record (all skills' per-level/per-mastery text,
// talents, modules, base stats, promotion tables, bios, voice credits,
// ...) to the client when a page never reads any of that.
export interface RosterOperator {
  sourceRegion?: 'CN' | 'Global';
  portraitPending?: boolean;
  name: string;
  rarity: number | null;
  class: string | null;
  branch: string | null;
  faction: string | null;
  umbrellaFactions?: string[];
  connectedFactions?: string[];
  howToObtain: string | HowToObtainInfo | null;
  /** What the roster's Obtain filter reads (lib/operators/obtainMethods.ts), for the pages that
   *  null howToObtain to keep their payload small. */
  obtain?: { methods: ObtainMethod[]; welfare?: WelfareSource };
  isFuture?: boolean;
  /** Confirmed Global release instant, including timezone. */
  releaseAt?: string;
  /** Until when the debut lasts (Operator.availableUntil); absent in releases from before it. */
  availableUntil?: string;
  characterInfo?: Record<string, string> | null;
}

// Lightweight projection for the materials planner -- it only ever
// reads name/isFuture/rarity/promotion/skills/modules (verified against
// every op.* access in planner.tsx), so baseSkills, talents, and every
// biographical field (characterInfo, basicInfo, physicalExam,
// characterVoices, etc.) can be dropped entirely. skills/promotion/
// modules themselves are kept fully intact (not further trimmed),
// since the cost-calculation helpers in plannerLogic.ts take the whole
// operator and their internals aren't visible here to safely narrow.
export interface PlannerOperator {
  name: string;
  isFuture?: boolean;
  rarity: number | null;
  promotion: PromotionTier[];
  skills: Skill[] | { skillList: Skill[]; skillCost: Record<string, CostGroup> | null };
  modules?: OperatorModule[];
}

/** Lightweight version of PlannerOperator for the initial page load --
 * just enough for the search picker and selected-operator chips (name,
 * icon via name, rarity for the default target level). The full
 * promotion/skills/modules data for a specific operator is fetched on
 * demand from /api/planner-operator only once that operator is
 * actually added to the plan, rather than shipping every operator's
 * full build data upfront regardless of whether it's ever looked at. */
export interface PlannerOperatorSummary {
  art?: string;
  name: string;
  rarity: number | null;
  /** The class, not the branch. The roster grid filters by it and prints it
   *  under the name; Chiave is a Vanguard here, not a Pioneer. */
  className?: string | null;
  /** The other name this operator goes by -- their alter, or the operator they are an
   *  alter of. Searched alongside the name so "phantom" finds Tragodia. Built by
   *  lib/operators/operatorAliases.ts; absent when there is no such name. */
  aliases?: string[];
  /** When the operator becomes plannable (lib/operators/operatorAvailability.ts releaseMarker):
   *  the picker is filtered per request with the page's `now`, not at export. Absent on a
   *  payload from before markers, which was filtered at export already. */
  releasedAt?: number | null;
  isFuture?: true;
  /** Not on Global yet, so CN only: set by the page from the release marker
   *  (lib/operators/operatorAvailability.ts plannerOperators), never by the export. */
  cnOnly?: true;
}

// Lightweight projection for the schedule/timeline page -- it only
// ever reads name/rarity/isFuture and a birthdate (Date of Birth from
// basicInfo), verified against every op.* access in timeline.tsx.
// Release Date is deliberately NOT included here -- getStaticProps
// resolves that server-side into a separate small name->date lookup
// instead of shipping full characterInfo per operator.
export interface TimelineOperator {
  name: string;
  rarity: number | null;
  isFuture: boolean;
  portraitPending?: boolean;
  basicInfo: { 'Date of Birth'?: string } | null;
}

// Lightweight projection for the base simulator -- reads name/rarity/
// faction/baseSkills (faction via operatorByName.get(...)?.faction
// lookups for group-membership checks like Sui, not caught by the
// initial op.* scan since it's an indirect/chained access), so skills/
// promotion/talents/modules and every other biographical field can
// still be dropped.
export interface BaseOperator {
  class?: string | null;
  branch?: string | null;
  name: string;
  rarity: number | null;
  faction: string | null;
  baseSkills?: BaseSkill[];
  /** The names the operator had before a rename (Operator.aliases), so the calculator still finds
   *  a special skill keyed by one of them (lib/base/specialSkillKeys.ts). */
  aliases?: string[];
}

// The guesser only needs skill names/icons and the M3 description,
// plus each talent's name and final description. Full Operator records
// remain structurally compatible so tests can compare their hints.
export interface GuesserSkill extends Pick<Skill, 'name' | 'icon'> {
  levels: Pick<SkillLevel, 'mastery' | 'description'>[];
}

export interface GuesserTalent extends Pick<Talent, 'name'> {
  rows: Pick<TalentRow, 'description'>[];
}

export interface GuesserOperator {
  name: string;
  rarity: number | null;
  class: string | null;
  branch: string | null;
  faction: string | null;
  howToObtain: string | HowToObtainInfo | null;
  tags: string[];
  isFuture?: boolean;
  portraitPending?: boolean;
  talents?: GuesserTalent[];
  baseSkills?: Pick<BaseSkill, 'name'>[];
  basicInfo?: Record<string, string> | null;
  /** Confirmed Global release instant, including timezone. */
  releaseAt?: string;
  characterInfo?: Record<string, string> | null;
  characterVoices?: Record<string, string> | null;
  ep?: string | Record<string, string> | null;
  skills: GuesserSkill[] | { skillList: GuesserSkill[] };
}

export function getSkillList<T>(operator: { skills: T[] | { skillList: T[] } }): T[] {
  const s = operator.skills;
  if (Array.isArray(s)) return s;
  return s?.skillList || [];
}

export function getSkillCost(operator: Pick<Operator, 'skills'>): Record<string, CostGroup> | null {
  const s = operator.skills;
  if (Array.isArray(s)) return null;
  return s?.skillCost || null;
}
