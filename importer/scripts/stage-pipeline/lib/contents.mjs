// Which piece of content each stage was introduced by: the episode, event, IS
// season, Annihilation map, supply zone, SSS tower, Battleplan season or
// tutorial it belongs to. This is what the site's chapter dropdown is built out
// of, and it is where the joins are least obvious -- see the notes per kind.
import { excel, levelKey } from './gamedata.mjs';
import { list } from './text.mjs';

// A THIRD markup regex, and deliberately not the record one: this excludes < and
// > from a tag body where build_stages' allows them. They are not interchangeable.
const MARKUP = /<\/>|<[$@][^<>]*>|<\/?(?:color(?:=[^<>]*)?|[ib])>/g;

/** A display string with markup removed, or null if nothing is left. */
export function clean(s) {
  if (!s) return null;
  // \u00a0 spelled out: a literal non-breaking space here is invisible to the
  // next reader, and dropping it changes 30-odd content names.
  const out = String(s).replace(MARKUP, '').replace(/\u00a0/g, ' ').trim();
  return out || null;
}

/**
 * The chapter number a story zone carries. It is the numeric SUFFIX of the zone
 * id and nothing else -- zone.zoneIndex is the slot within a display block, so
 * main_4 reports 0 and every chapter would be mislabelled.
 */
export function zoneChapter(zoneId) {
  const m = /^main_(\d+)$/.exec(zoneId || '');
  return m ? Number(m[1]) : null;
}

/**
 * (label, name) for a story episode, the same way every time.
 *
 * The zone rows are not uniform: episodes 1-14 put 'Episode 4' in zoneNameFirst
 * and the real name in zoneNameSecond, while 15 and 16 have no zoneNameFirst at
 * all. zoneNameTitleCurrent is the one uniform field ('00'..'16'), so the number
 * comes from there and the name from whichever field has it.
 */
export function episode(zone) {
  const z = zone || {};
  const number = (z.zoneNameTitleCurrent || '').trim();
  const first = (z.zoneNameFirst || '').trim();
  const second = (z.zoneNameSecond || '').trim();
  return [number ? `EP ${number}` : (first || null), second || first || null];
}

// The community numbering, which is off by one from the topic ids and is not
// derivable. Do not "fix" the offset.
export const IS_LABEL = {
  rogue_1: 'IS2',   // Phantom & Crimson Solitaire
  rogue_2: 'IS3',   // Mizuki & Caerula Arbor
  rogue_3: 'IS4',   // Expeditioner's Jǫklumarkar
  rogue_4: 'IS5',   // Sarkaz's Furnaceside Fables
  rogue_5: 'IS6',   // Sui's Garden of Grotesqueries
};

export function isLabel(topicId) {
  if (topicId in IS_LABEL) return IS_LABEL[topicId];
  // Falls through rather than failing, so a new topic gets a sensible name the
  // day it ships.
  const m = /(\d+)$/.exec(topicId || '');
  return m ? `IS${Number(m[1]) + 1}` : null;
}

// The four launch towers are gone from climb_tower_table, so their stages are
// filed under the mode itself rather than dropped out of the data.
export const SSS_MODE = ['legion', 'Stationary Security Service'];
const PREFIX_LABEL_KINDS = new Set(['event', 'supply', 'reclamation']);

const RERUN_SUFFIX = /\s*[-–—]\s*Rerun\s*$/i;
export const eventName = (name) => String(name ?? '').trim().replace(RERUN_SUFFIX, '').trim();

/**
 * Give colliding event names something to tell them apart. A year separates the
 * four April Fools' events cleanly; it does NOT separate the six Trials for
 * Navigator (two ran in 2023), so a run number is the fallback rather than the
 * default. Mutates `name` in place, returns how many changed.
 */
export function disambiguate(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.name)) groups.set(e.name, []);
    groups.get(e.name).push(e);
  }
  let changed = 0;
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.start || 0) - (b.start || 0));
    const years = group.map((e) => (e.start
      ? new Date(e.start * 1000).toISOString().slice(0, 4) : null));
    if (years.every(Boolean) && new Set(years).size === years.length) {
      group.forEach((e, i) => { e.name = `${name} ${years[i]}`; changed++; });
    } else {
      group.forEach((e, i) => { e.name = `${name} #${i + 1}`; changed++; });
    }
  }
  return changed;
}

class Entry {
  constructor(kind, id, name, label = null, order = 0) {
    this.kind = kind; this.id = id; this.name = name; this.label = label; this.order = order;
    this.levels = new Map();   // level key -> Set of stage codes played there
  }

  /** A missing code is not a missing stage: Battleplan operations have no row. */
  add(levelId, code = null) {
    const key = levelKey(levelId);
    if (!key) return false;
    if (!this.levels.has(key)) this.levels.set(key, new Set());
    if (code) this.levels.get(key).add(code);
    return true;
  }
}

class Registry {
  constructor() { this._entries = new Map(); }
  _key(kind, id) { return `${kind} ${id}`; }
  entry(kind, id, name, label = null, order = 0) {
    const k = this._key(kind, id);
    if (!this._entries.has(k)) this._entries.set(k, new Entry(kind, id, name, label, order));
    return this._entries.get(k);
  }
  find(kind, id) { return this._entries.get(this._key(kind, id)); }
  /** Kind first so a consumer can group, then the game's own ordering, then id. */
  all() {
    return [...this._entries.values()].sort((a, b) => (
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1
        : a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  }
}

const sortedKeys = (obj) => Object.keys(obj || {}).sort();

/** The five kinds that live in stage_table, grouped the way the game is. */
function addStageTable(reg, activity) {
  const stages = excel('stage_table').stages;
  const zones = excel('zone_table').zones;
  const zoneToActivity = activity.zoneToActivity;
  const activityInfo = activity.basicInfo;
  const towers = excel('climb_tower_table').towers || {};
  const campZones = excel('campaign_table').campaignZones || {};

  for (const stageId of sortedKeys(stages)) {
    const stage = stages[stageId];
    const kind = stage.stageType;
    const zoneId = stage.zoneId;
    const zone = zones[zoneId] || {};
    const code = clean(stage.code);
    let entry = null;

    if (kind === 'MAIN' || kind === 'SUB' || kind === 'SPECIAL_STORY') {
      // SPECIAL_STORY rows (the EG-n operations) sit in story zones and belong
      // to the episode around them, not to a category of their own.
      const chapter = zoneChapter(zoneId);
      const [epLabel, name] = episode(zone);
      if (name) {
        entry = reg.entry('story', zoneId, name,
          epLabel || (chapter != null ? String(chapter) : null),
          chapter != null ? chapter : 999);
      }
    } else if (kind === 'ACTIVITY') {
      // zoneToActivity first; it is the only thing that gets reruns right. The
      // three oldest permanent side stories are missing from it, but their stage
      // ids still carry the activity id.
      let activityId = zoneToActivity[zoneId];
      if (!(activityId in activityInfo)) {
        const prefix = /^([a-z0-9]+)_/.exec(stageId);
        activityId = prefix ? prefix[1] : null;
      }
      const info = activityInfo[activityId];
      const name = clean(info?.name);
      if (name) entry = reg.entry('event', activityId, name, null, info?.startTime || 0);
    } else if (kind === 'CAMPAIGN') {
      const name = clean(campZones[zoneId]?.name);
      const suffix = /(\d+)$/.exec(zoneId || '');
      if (name) entry = reg.entry('annihilation', zoneId, name, null, suffix ? Number(suffix[1]) : 999);
    } else if (kind === 'DAILY') {
      const name = clean(zone.zoneNameSecond) || clean(zone.zoneNameFirst);
      const suffix = /(\d+)$/.exec(zoneId || '');
      if (name) entry = reg.entry('supply', zoneId, name, null, suffix ? Number(suffix[1]) : 999);
    } else if (kind === 'CLIMB_TOWER') {
      // The zone id and the tower id are the same string.
      const tower = towers[zoneId];
      const name = clean(tower?.name);
      entry = name
        ? reg.entry('sss', zoneId, name, null, tower.sortId || 0)
        : reg.entry('sss', SSS_MODE[0], SSS_MODE[1], null, -1);
    }
    // GUIDE: two tutorial stages, code '???', no name, in a zone with no name.

    if (!entry || !stage.levelId) continue;
    entry.add(stage.levelId, code);
  }
}

function addIntegratedStrategies(reg) {
  const table = excel('roguelike_topic_table');
  const topics = table.topics || {};
  const details = table.details || {};
  for (const topicId of sortedKeys(topics)) {
    const name = clean(topics[topicId].name);
    if (!name) continue;
    const entry = reg.entry('integrated_strategies', topicId, name,
      isLabel(topicId), topics[topicId].sort || 0);
    const stages = details[topicId]?.stages || {};
    for (const stageId of sortedKeys(stages)) {
      const stage = stages[stageId];
      const code = clean(stage.code);
      entry.add(stage.levelId, code);
      // A node can be re-cut: levelReplaceIds are alternate layouts of the same
      // node, and they field enemies the base layout does not.
      for (const replacement of [...list(stage.levelReplaceIds)].sort()) entry.add(replacement, code);
    }
  }
}

function addReclamation(reg) {
  const table = excel('sandbox_perm_table');
  const basic = table.basicInfo || {};
  const detail = table.detail?.SANDBOX_V2 || {};
  for (const topicId of sortedKeys(detail)) {
    const info = basic[topicId] || {};
    const name = clean(info.topicName);
    if (!name) continue;
    const entry = reg.entry('reclamation', topicId, name, null, info.sortId || 0);
    const stageData = detail[topicId].stageData || {};
    for (const stageId of sortedKeys(stageData)) {
      entry.add(stageData[stageId].levelId, clean(stageData[stageId].code));
    }
  }
}

/**
 * Reclamation Algorithm 1, which has no stage rows and no level files here --
 * kept because it is a real content entry, filed under `reclamation` rather than
 * `event` so a kind=reclamation filter shows the whole mode. Its name has to come
 * from activity_table: sandbox_table carries none, and its display text is still
 * untranslated in the EN dump.
 */
function addReclamationV1(reg, activityInfo) {
  const acts = excel('sandbox_table').sandboxActTables || {};
  for (const activityId of sortedKeys(acts)) {
    const name = clean(activityInfo[activityId]?.name);
    // order 0, not startTime: this run came before every permanent topic, whose
    // own sortId numbering starts at 1.
    if (name) reg.entry('reclamation', activityId, name, null, 0);
  }
}

// Contingency Contract level files are named level_crisis_v2_<season>-<n>.
const CRISIS_LEVEL = /level_crisis_v2_(\d+)-\d+$/;

/**
 * Four Battleplan seasons, matched to level files by number. seasonInfoDataMap
 * has no stage list at all, and the obvious alternative (the level's bgmEvent)
 * names the season only on its first stage, resolving 4 of 16.
 */
function addContingencyContract(reg, levelIds) {
  const seasons = excel('crisis_v2_table').seasonInfoDataMap || {};
  const byNumber = new Map();
  for (const seasonId of sortedKeys(seasons)) {
    const season = seasons[seasonId];
    const number = /season_(\d+)/.exec(seasonId);
    const name = clean(season.name);
    if (!number || !name) continue;
    // crisisV2SeasonCode is the game's own '#3'; the community says 'CC#3'.
    const code = clean(season.crisisV2SeasonCode) || `#${Number(number[1])}`;
    byNumber.set(Number(number[1]), reg.entry('contingency_contract', seasonId, name,
      `CC${code}`, season.startTs || 0));
  }
  for (const levelId of [...levelIds].sort()) {
    const match = CRISIS_LEVEL.exec(levelId);
    if (!match) continue;
    const entry = byNumber.get(Number(match[1]));
    if (entry) entry.add(levelId);   // Battleplan operations have no stage code
  }
}

/** levelId (lowercased) -> stage code, for levels no stage row names. */
function activityNamedLevels(activityTable) {
  const out = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      const lv = node.levelId;
      const code = node.code;
      if (typeof lv === 'string' && lv.toLowerCase().startsWith('activities/')
        && typeof code === 'string' && code && !out.has(lv.toLowerCase())) {
        out.set(lv.toLowerCase(), code);
      }
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(activityTable);
  return out;
}

/**
 * Event levels no stage row points at: minigames and April Fools' days. The
 * activity id comes from the level PATH, not from the enclosing dict key -- those
 * keys are mode names like 'actFunData', which would read as stage codes.
 */
function addMinigameLevels(reg, activityInfo, levelIds, activityTable) {
  const claimed = new Set();
  for (const entry of reg.all()) for (const key of entry.levels.keys()) claimed.add(key);
  const named = activityNamedLevels(activityTable);
  for (const levelId of [...levelIds].sort()) {
    const parts = levelId.split('/');
    if (parts.length < 3 || parts[0] !== 'activities' || claimed.has(levelId)) continue;
    const info = activityInfo[parts[1]];
    const name = clean(info?.name);
    if (!name) continue;
    const entry = reg.entry('event', parts[1], name, null, info.startTime || 0);
    const code = named.get(levelId.toLowerCase());
    if (code) entry.add(levelId, code); else entry.add(levelId);
  }
}

/** Every content entry, resolved. `levelIds` is what is on disk. */
export function collect(levelIds) {
  const activity = excel('activity_table');
  const reg = new Registry();
  addStageTable(reg, activity);
  addIntegratedStrategies(reg);
  addReclamation(reg);
  addContingencyContract(reg, levelIds);
  addMinigameLevels(reg, activity.basicInfo, levelIds, activity);
  addReclamationV1(reg, activity.basicInfo);

  // Event display names, once every entry exists: the rerun suffix comes off and
  // anything still sharing a name gets a year or a run number. Deferred to here
  // because a name is only ambiguous relative to the others.
  const events = [];
  for (const entry of reg.all()) {
    if (entry.kind !== 'event') continue;
    entry.name = eventName(entry.name);
    events.push({ e: entry, name: entry.name, start: activity.basicInfo[entry.id]?.startTime });
  }
  disambiguate(events);
  for (const row of events) row.e.name = row.name;

  // A short handle a person would type, read off the stage codes the entry
  // turned out to own -- one stage is not enough, since the first stage of
  // chapter 15 in id order is H15-1 and an event's can be its tutorial.
  for (const entry of reg.all()) {
    if (entry.label !== null) continue;
    const codes = new Set();
    for (const set of entry.levels.values()) for (const c of set) codes.add(c);
    if (entry.kind === 'story') {
      const numbers = new Set([...codes].map((c) => /^(\d+)-/.exec(c)).filter(Boolean).map((m) => Number(m[1])));
      if (numbers.size === 1) {
        const chapter = [...numbers][0];
        entry.label = String(chapter);
        entry.order = chapter;
      }
    } else if (PREFIX_LABEL_KINDS.has(entry.kind)) {
      const prefixes = new Set([...codes].map((c) => /^([A-Za-z]+)/.exec(c)).filter(Boolean).map((m) => m[1]));
      // One prefix or none: a minigame event whose stages read 'Regular 1' and
      // 'Beginner 1' has no single handle, and inventing one would mislead.
      if (prefixes.size === 1) entry.label = [...prefixes][0];
    }
  }
  return reg;
}

// The two non-battle tutorial rows have no level file and so no content entry
// derives for them, but they are still stage records worth keeping. Upstream
// mints this block by hand for the same reason.
export const GUIDE_META = { kind: 'guide', id: 'guide_1', label: 'GUIDE', name: 'Tutorial', release_date: null };

/**
 * id -> the {kind, id, label, name, release_date} block copied onto every stage.
 *
 * Two entries upstream carries are deliberately absent here: event/act17d1
 * (Defense Protocols) and event/act42d0 (Design of Strife) exist only because
 * its enemy collectors mint them from mode tables that name enemies without any
 * stage or level file. No stage references either, so a stages pipeline has
 * nothing to file under them, and reproducing them would mean importing the
 * enemy roster logic wholesale.
 */
export function contentBlocks(registry, dates) {
  const out = new Map();
  for (const entry of registry.all()) {
    out.set(entry.id, {
      kind: entry.kind,
      id: entry.id,
      label: entry.label ?? null,
      name: entry.name,
      release_date: dates.get(`${entry.kind} ${entry.id}`) ?? null,
    });
  }
  out.set(GUIDE_META.id, { ...GUIDE_META });
  return out;
}

/** level key -> the content entry id that registered it. */
export function levelOwner(registry) {
  const out = new Map();
  for (const entry of registry.all()) {
    for (const key of entry.levels.keys()) out.set(key, { kind: entry.kind, id: entry.id });
  }
  return out;
}

/**
 * Which content a stage_table row belongs to. The level file wins: that is the
 * content that actually registered it, and it is what gets reruns right. The
 * stageType fallback below only runs for a row whose level nobody claimed.
 */
export function contentForStage(record, raw, owner, known) {
  const byLevel = owner.get(levelKey(raw.levelId));
  if (byLevel) return byLevel;

  const zoneId = raw.zoneId;
  let key = null;
  switch (raw.stageType) {
    case 'MAIN': case 'SUB': case 'SPECIAL_STORY': key = { kind: 'story', id: zoneId }; break;
    case 'ACTIVITY': key = { kind: 'event', id: record.event?.id }; break;
    case 'CAMPAIGN': key = { kind: 'annihilation', id: zoneId }; break;
    case 'DAILY': key = { kind: 'supply', id: zoneId }; break;
    case 'CLIMB_TOWER':
      key = known.has(`sss ${zoneId}`) ? { kind: 'sss', id: zoneId } : { kind: 'sss', id: SSS_MODE[0] };
      break;
    case 'GUIDE': return { kind: 'guide', id: 'guide_1' };
    default: return null;
  }
  return known.has(`${key.kind} ${key.id}`) ? key : null;
}
