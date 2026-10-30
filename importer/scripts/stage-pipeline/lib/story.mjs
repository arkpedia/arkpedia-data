// The Act above the Episode, and the event an activity zone belongs to. Both
// joins have a wrong-looking obvious answer, so both are spelled out here.
import { text } from './text.mjs';

/**
 * (zone id -> act record, zone id -> running order), for the story.
 *
 * chapter_table states each Act's range as startZoneId/endZoneId, which needs an
 * ordering of zones to expand -- and the last Act runs act2mainss_zone1..
 * act3mainss_zone1, two MAINLINE_ACTIVITY zones absent from
 * zone_table.mainlineZoneIdList, so that list cannot expand it. A chain walk
 * cannot either: chapters 1, 2 and 3 all name chapter_0 as predecessor.
 *
 * mainlineAdditionInfo states the membership directly, and its own table order
 * is the episodes' running order.
 */
export function readActs(chapters, mainline) {
  const acts = new Map();
  const running = new Map();
  let position = 0;
  for (const [zoneId, info] of Object.entries(mainline || {})) {
    const chapter = (chapters || {})[info?.chapterId];
    position += 1;
    if (!chapter) continue;
    acts.set(zoneId, {
      id: chapter.chapterId,
      name: text(chapter.chapterName),
      index: chapter.chapterIndex,
    });
    running.set(zoneId, position - 1);
  }
  return { acts, running };
}

const RERUN_SUFFIX = /\s*[-–—]\s*Rerun\s*$/i;

/**
 * An event's name without the rerun marker. 31 of 93 entries are named
 * 'X - Rerun' and none has a separate entry for the original -- a rerun reuses
 * the original's level files, so the suffix distinguishes nothing. is_rerun
 * still carries the fact as data.
 */
export function eventName(name) {
  return String(name ?? '').trim().replace(RERUN_SUFFIX, '').trim();
}

/**
 * The event block for a stage row, or null.
 *
 * Event zones are typed ACTIVITY and the SIDESTORY/BRANCHLINE zone types are
 * empty permanent-rerun containers, so zone.type cannot find events --
 * zoneToActivity is the only correct join. The fallback catches the three oldest
 * permanent side stories (Ancient Forge, Stories of Afternoon, Operational
 * Intelligence), folded into mainline zones and dropped out of zoneToActivity,
 * whose stage ids still carry the activity id.
 */
export function eventOf(sid, s, zoneToActivity, activityInfo) {
  let activityId = (zoneToActivity || {})[s.zoneId];
  if (!(activityId in (activityInfo || {})) && s.stageType === 'ACTIVITY') {
    const prefix = /^([a-z0-9]+)_/.exec(sid);
    if (prefix && prefix[1] in activityInfo) activityId = prefix[1];
  }
  const act = (activityInfo || {})[activityId];
  if (!act) return null;
  // displayType is how the game files an event; the sibling `type` field is an
  // internal build tag ('TYPE_ACT9D0'), so it stays out of the output.
  const display = act.displayType;
  return {
    id: act.id,
    name: eventName(text(act.name)),
    type: display && display !== 'NONE' ? display.toLowerCase() : null,
    is_rerun: Boolean(act.isReplicate),
  };
}
