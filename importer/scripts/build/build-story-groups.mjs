#!/usr/bin/env node
/**
 * Writes data/story-groups.json: the chapter/event filter's headings, in the
 * order and wording the game uses.
 *
 * The game states this itself, in stage_table.json:
 *   storylines           14 lines -- the mainline plus 13 side-story lines, each
 *                        with a sortId, a name ("The Ark") and an abbreviation
 *                        icon ("storyline_abbr_Rl" -> RL)
 *   storylines.mainLine.locations
 *                        the mainline in order, with MAINLINE_SPLIT entries
 *                        naming each act ("act_0", "HOUR OF AN AWAKENING")
 *   storylineStorySets   what each location holds: a mainline zone (main_5) or
 *                        an activity (act9d0)
 *
 * Two joins are not direct:
 *   - Membership is stated against the activity's ORIGINAL id, while a stage
 *     that is still playable points at the rerun ("act17d5" for Darknights
 *     Memoir, whose storyline entry says "act9d0"). Matching on the event's name
 *     bridges the two, and a rerun carries its parent's name plus a
 *     " - Retrospection" suffix, which is stripped.
 *   - The mainline's side zones (act2mainss_zone1) are activities tied to a
 *     chapter, so they are matched by activity-id prefix.
 *
 * Membership comes from the CN table (the freshest dump on disk) and the names
 * from the EN one, so a storyline reads in English while covering CN's events.
 *
 * Re-run after updating either dump:  node scripts/build/build-story-groups.mjs
 */
import fs from 'fs';
import path from 'path';

const CN = `${process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource'}/gamedata/excel`;
const EN = `${process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en'}/gamedata/excel`;

const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));

/**
 * A location says whether it holds content or merely marks where something else
 * happened. Only STORY_SET is membership: BEFORE and AFTER are context markers,
 * which is how Wildfire ends up pointing at chapter 15's story set ("this
 * happens after it") -- and reading those as membership filed two main-story
 * chapters under two different side-story lines.
 *
 * The CN dump numbers the enum where the EN one names it. The mapping below was
 * derived by intersecting the two dumps on the location ids they share: 0/1/2/3
 * against STORY_SET/BEFORE/AFTER/MAINLINE_SPLIT, 109 locations, no
 * disagreements.
 */
const isStorySet = (loc) => loc.locationType === 'STORY_SET' || loc.locationType === 0;
const isSplit = (loc) => loc.locationType === 'MAINLINE_SPLIT' || loc.locationType === 3;
const cnStages = read(CN, 'stage_table.json');
const enStages = read(EN, 'stage_table.json');
const enActs = read(EN, 'activity_table.json').basicInfo;
const contents = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'stages-content.json'), 'utf-8'));

const norm = (s) => String(s || '').toLowerCase().replace(/ - retrospection$/, '').replace(/[^a-z0-9]/g, '');
const abbrOf = (line) => {
  const m = /storyline_abbr_(\w+)/.exec(line.storylineIconId || '');
  return m ? m[1].toUpperCase() : null;
};

/** activity id -> event name, preferring the EN wording. */
const actName = (id) => (enActs[id] && enActs[id].name) || null;

/** The groups, in the order the game lists them. */
const groups = [];

// --- the mainline, split into the acts the game names ----------------------
{
  const line = cnStages.storylines.mainLine;
  const enLine = enStages.storylines.mainLine;
  const locations = Object.values(line.locations).sort((a, b) => a.sortId - b.sortId);
  let current = null;
  for (const loc of locations) {
    if (isSplit(loc)) {
      const split = loc.mainlineSplitData || {};
      // The subtitle is upper-cased in the table; the EN copy carries the same
      // one, and is preferred when present.
      const enSplit = ((enLine.locations || {})[loc.locationId] || {}).mainlineSplitData || {};
      const subName = enSplit.subName || split.subName || '';
      // The table stores the act's subtitle in caps ("HOUR OF AN AWAKENING").
      const small = new Set(['of', 'a', 'an', 'the', 'and', 'or', 'in', 'to', 'for']);
      const nice = subName
        .toLowerCase()
        .replace(/\S+/g, (w, i) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
      current = { id: split.iconId || loc.locationId, code: null, label: `Main Story -- ${nice}`, mainline: true, keys: [] };
      groups.push(current);
      continue;
    }
    // BEFORE entries hold a side story wedged between two chapters; it belongs
    // to its own storyline, not to the act.
    if (!current || !isStorySet(loc)) continue;
    const set = cnStages.storylineStorySets[loc.relevantStorySetId];
    if (!set) continue;
    // Chapters up to 14 are zones (main_5). Chapters 15 and 16 are activities
    // with no zone at all (act2mainss, act3mainss), which this site files under
    // content ids prefixed with them -- so both shapes are collected, and the
    // name match is skipped because a chapter's tie-in activity carries the
    // chapter's own title and would otherwise swallow same-named events.
    if (set.mainlineData && set.mainlineData.zoneId) current.keys.push({ zone: set.mainlineData.zoneId });
    if (set.relevantActivityId) current.keys.push({ act: set.relevantActivityId, skipName: true });
  }
}

// --- the side-story lines, in the game's own order -------------------------
for (const line of Object.values(cnStages.storylines).sort((a, b) => a.sortId - b.sortId)) {
  if (line.storylineId === 'mainLine') continue;
  const en = enStages.storylines[line.storylineId] || line;
  const group = { id: line.storylineId, code: abbrOf(en) || abbrOf(line), label: en.storylineName || line.storylineName, mainline: false, keys: [] };
  for (const loc of Object.values(line.locations || {}).sort((a, b) => a.sortId - b.sortId)) {
    if (!isStorySet(loc)) continue;
    const set = cnStages.storylineStorySets[loc.relevantStorySetId];
    if (!set || !set.relevantActivityId || set.mainlineData) continue;
    group.keys.push({ act: set.relevantActivityId, name: actName(set.relevantActivityId) });
  }
  groups.push(group);
}

// --- resolve keys to the content ids this site actually holds --------------
const ids = Object.keys(contents);
const nameOf = new Map(ids.map((id) => [id, norm(contents[id].name)]));
const taken = new Set();
const out = [];
for (const group of groups) {
  const members = [];
  for (const key of group.keys) {
    const candidates = [];
    if (key.zone) candidates.push(...ids.filter((id) => id === key.zone));
    if (key.act) {
      candidates.push(...ids.filter((id) => id === key.act || id.startsWith(`${key.act}_`)));
      const wanted = key.skipName ? null : norm(key.name || actName(key.act));
      if (wanted) candidates.push(...ids.filter((id) => nameOf.get(id) === wanted));
    }
    for (const id of candidates) {
      if (taken.has(id)) continue;
      taken.add(id);
      members.push(id);
    }
  }
  if (members.length) out.push({ id: group.id, code: group.code, label: group.label, mainline: !!group.mainline, contentIds: members });
}

fs.writeFileSync(path.join(process.cwd(), 'data', 'story-groups.json'), JSON.stringify(out));
const placed = out.reduce((n, g) => n + g.contentIds.length, 0);
console.log(`${out.length} groups, ${placed} of ${ids.length} contents placed`);
for (const g of out) {
  console.log(`  ${(g.code || '--').padEnd(3)} ${g.label.padEnd(30)} ${g.contentIds.length}`);
  console.log(`      ${g.contentIds.map((id) => contents[id].name).join(', ')}`);
}
const left = ids.filter((id) => !taken.has(id));
const byKind = {};
for (const id of left) (byKind[contents[id].kind] ||= []).push(contents[id].name);
console.log(`\n${left.length} contents left for the by-kind groups:`);
for (const [kind, names] of Object.entries(byKind)) console.log(`  ${kind.padEnd(22)} ${names.length}  e.g. ${names.slice(0, 3).join(', ')}`);
