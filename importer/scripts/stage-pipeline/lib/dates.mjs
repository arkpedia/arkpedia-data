// Global release dates per content entry. Every kind has its own source, and
// three of them need a correction the tables cannot supply on their own.
import { excel } from './gamedata.mjs';
import { list } from './text.mjs';

/** An epoch timestamp as a Global-server UTC calendar date. */
export function iso(timestamp) {
  if (typeof timestamp !== 'number' || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

// Maintainer-supplied Global chronology for Episodes 00-08. story_review_table
// carries the Story Review FEATURE's launch date (2020-06-02) for main_0..main_7
// rather than each episode's own, and an impossible 2020-11-01 for main_8 --
// which would precede EP 07 on 2020-12-30, and episodes do not release out of
// order. Only the rows below are hand-held; 09 upward derive from the data.
export const RELEASED = {
  main_0: '2020-01-16',   // Evil Time Part 1        EN launch
  main_1: '2020-01-16',   // Evil Time Part 2        EN launch
  main_2: '2020-01-16',   // Separated Hearts        EN launch
  main_3: '2020-01-16',   // Stinging Shock          EN launch
  main_4: '2020-01-16',   // Burning Run             EN launch
  main_5: '2020-02-26',   // Necessary Solutions
  main_6: '2020-06-30',   // Partial Necrosis
  main_7: '2020-12-30',   // The Birth of Tragedy
  main_8: '2021-04-30',   // Roaring Flare           data says 2020-11-01
};
/** Global chronology before Episode 9 needs the corrections above. Every newer
 * episode uses its Global review row, including episodes not known to this code.
 * The review key follows the EP label even when the zone is actNmainss_zone1.
 * A missing/undated row stays unknown; CN dates and forecasts are never substituted. */
export function storyReleaseDate(label, review) {
  const match = /^EP\s+(\d+)$/.exec(label || '');
  if (!match) return null;
  const number = Number(match[1]);
  const id = `main_${number}`;
  return number >= 9 ? iso(review[id]?.startShowTime) : RELEASED[id] ?? null;
}

const STORY_ENTRY_TYPES = new Set(['ACTIVITY', 'MINI_ACTIVITY']);
const RUN_SUFFIX = /\s*[-–—]\s*(?:Rerun|Retrospection)\s*$/i;
const nameKey = (v) => String(v ?? '').trim().replace(RUN_SUFFIX, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * activity id -> the ORIGINAL Global opening timestamp, so a rerun dates from
 * the first run rather than from its own re-release.
 */
export function releaseTimestamps(review, retro, activity) {
  const originals = new Map();
  for (const [reviewId, row] of Object.entries(review || {})) {
    if (STORY_ENTRY_TYPES.has(row.entryType) && typeof row.startTime === 'number' && row.startTime > 0) {
      originals.set(reviewId, row.startTime);
    }
  }
  const names = new Map();
  for (const reviewId of originals.keys()) {
    const key = nameKey(review[reviewId].name);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(reviewId);
  }
  const nameToReview = new Map();
  for (const [key, ids] of names) if (ids.length === 1) nameToReview.set(key, ids[0]);

  const linkedToReview = new Map();
  for (const row of Object.values((retro || {}).retroActList || {})) {
    const linked = list(row.linkedActId);
    const candidates = linked.filter((item) => originals.has(item));
    if (!candidates.length) continue;
    const original = candidates.reduce((a, b) => (originals.get(b) < originals.get(a) ? b : a));
    for (const activityId of linked) linkedToReview.set(activityId, original);
  }

  const out = new Map();
  for (const [activityId, info] of Object.entries(activity || {})) {
    const reviewId = originals.has(activityId) ? activityId
      : linkedToReview.get(activityId) || nameToReview.get(nameKey(info.name));
    if (reviewId && originals.has(reviewId)) out.set(activityId, originals.get(reviewId));
  }
  return out;
}

function walkStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => walkStrings(v, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => walkStrings(v, out));
  return out;
}

/** (kind, id) -> YYYY-MM-DD for every content entry, keyed as `${kind} ${id}`. */
export function releaseDates(entries) {
  const activity = excel('activity_table').basicInfo;
  const review = excel('story_review_table');
  const retro = excel('retro_table');
  const rogue = excel('roguelike_topic_table').topics || {};
  const sandbox = excel('sandbox_perm_table').basicInfo || {};
  const crisis = excel('crisis_v2_table').seasonInfoDataMap || {};
  const tower = excel('climb_tower_table');
  const campaign = excel('campaign_table');
  const stages = excel('stage_table').stages;

  // A rerun reuses the original event's stages. medalGroupId is the game's own
  // pairing of a run and its rerun, so the first run's date wins.
  const activityDate = new Map();
  const medalDate = new Map();
  for (const [activityId, info] of Object.entries(activity)) {
    const date = iso(info.startTime);
    if (!date) continue;
    activityDate.set(activityId, date);
    const group = info.medalGroupId;
    if (group) medalDate.set(group, medalDate.has(group) ? (medalDate.get(group) < date ? medalDate.get(group) : date) : date);
  }
  for (const [activityId, info] of Object.entries(activity)) {
    if (info.medalGroupId && medalDate.has(info.medalGroupId)) {
      activityDate.set(activityId, medalDate.get(info.medalGroupId));
    }
  }
  const reviewEventDate = new Map();
  for (const [activityId, ts] of releaseTimestamps(review, retro, activity)) {
    reviewEventDate.set(activityId, iso(ts));
  }

  const out = new Map();
  const key = (e) => `${e.kind} ${e.id}`;
  for (const entry of entries) {
    if (entry.kind === 'story') {
      out.set(key(entry), storyReleaseDate(entry.label, review));
    } else if (entry.kind === 'event') {
      out.set(key(entry), reviewEventDate.get(entry.id) || activityDate.get(entry.id) || null);
    } else if (entry.kind === 'integrated_strategies') {
      out.set(key(entry), iso(rogue[entry.id]?.startTime));
    } else if (entry.kind === 'reclamation') {
      out.set(key(entry), iso(sandbox[entry.id]?.topicStartTime) || activityDate.get(entry.id) || null);
    } else if (entry.kind === 'contingency_contract') {
      out.set(key(entry), iso(crisis[entry.id]?.startTs));
    }
  }

  // Each current SSS tower belongs to a dated season; Training Ground #N ships
  // with season N. The four retired launch towers are collapsed into the
  // synthetic `legion` entry, and only their medals still carry the date.
  const towerDate = new Map();
  const seasonDate = new Map();
  for (const season of Object.values(tower.seasonInfos || {})) {
    const date = iso(season.startTs);
    if (date && season.seasonNum != null) seasonDate.set(season.seasonNum, date);
    for (const towerId of list(season.towers)) {
      if (date) towerDate.set(towerId, towerDate.has(towerId) && towerDate.get(towerId) < date ? towerDate.get(towerId) : date);
    }
  }
  const retired = new Set(['tower_n_01', 'tower_n_02', 'tower_n_03', 'tower_n_04']);
  const launchDates = [];
  for (const medal of list(excel('medal_table').medalList)) {
    if (walkStrings(medal).some((s) => retired.has(s))) {
      const date = iso(medal.displayTime);
      if (date) launchDates.push(date);
    }
  }
  if (launchDates.length) towerDate.set('legion', launchDates.sort()[0]);
  for (const entry of entries) {
    if (entry.kind !== 'sss') continue;
    let date = towerDate.get(entry.id);
    const training = /#(\d+)$/.exec(entry.name || '');
    if (date == null && training) date = seasonDate.get(Number(training[1]));
    out.set(key(entry), date ?? null);
  }

  // Campaign schedules retain the first opening of every Annihilation stage. The
  // three permanent launch maps are in campaignGroups instead of the rotating
  // schedule, with pre-launch system timestamps -- clamp those to EN launch.
  const campaignZone = new Map();
  for (const [stageId, row] of Object.entries(stages)) {
    if (row.stageType === 'CAMPAIGN') campaignZone.set(stageId, row.zoneId);
  }
  const zoneDate = new Map();
  const keepEarlier = (zoneId, date) => {
    const seen = zoneDate.get(zoneId);
    zoneDate.set(zoneId, seen && seen < date ? seen : date);
  };
  for (const row of list(campaign.campaignRotateStageOpenTimes)) {
    const zoneId = campaignZone.get(row.stageId);
    const date = iso(row.startTs);
    if (zoneId && date) keepEarlier(zoneId, date);
  }
  const launch = RELEASED.main_0;
  for (const group of Object.values(campaign.campaignGroups || {})) {
    let date = iso(group.startTs);
    for (const stageId of list(group.activeCamps)) {
      const zoneId = campaignZone.get(stageId);
      if (zoneId && date) {
        date = date > launch ? date : launch;
        keepEarlier(zoneId, date);
      }
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'annihilation') out.set(key(entry), zoneDate.get(entry.id) ?? null);
    // All weekly resource zones shipped at Global launch.
    else if (entry.kind === 'supply') out.set(key(entry), launch);
  }
  return out;
}
