#!/usr/bin/env node
/**
 * Writes data/excluded-contents.json: the limited-time special game modes whose
 * stages never become playable again, so the list does not offer them.
 *
 * The distinction is not "was it limited-time" -- every event is. It is whether
 * the content comes back: a side story reruns and then joins the permanent
 * Records section, while a one-off game mode (Stronghold Protocol's autochess
 * board, the Icebreaker Games' multiplayer, an April Fools' joke) closes and is
 * gone. Those are also not tower-defense stages, so a map, a route diagram and an
 * enemy roster say little about them.
 *
 * activity_table.json's own `type` per activity is what selects them, classified by
 * data/game-modes.json (lib/stages/gameModes.mjs), a record kept by hand in
 * arkpedia-data. That list used to be a Set in this file, so a new mode needed an app
 * commit, which deploys, and one nobody added was listed as an ordinary event with no
 * alert. Now every event whose activity type the record does not classify -- neither an
 * excluded mode, nor a seasonal challenge, nor a story episode -- is held in
 * data/quarantine.json under this stage, naming the type, and the daily "Content
 * quarantined" issue lists it until the record says what it is. So is a seasonal
 * challenge's content whose display code is not the one the record gives the mode, since
 * the Seasonal Challenge scene finds its contents by that code.
 *
 * Deliberately NOT excluded, though they are limited-time modes too: BOSS_RUSH
 * (Trials for Navigator, 78 stages) and VEC_BREAK/VEC_BREAK_V2 (Vector
 * Breakthrough, 80) run ordinary stages on ordinary maps, so the page has
 * something real to show for them.
 *
 * Re-run after regenerating the dataset:  node scripts/build/build-mode-exclusions.mjs
 */
import fs from 'fs';
import path from 'path';
import { checkGameModes, classifyActivity } from '../../lib/stages/gameModes.mjs';
import { beginStage } from '../lib/quarantine.mjs';

const EN = `${process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en'}/gamedata/excel`;

/** Content kinds dropped whole. `guide` is the two "???" tutorial stages, which
 *  have no code, no name and nothing to read. */
const MODE_KINDS = new Set(['guide']);

const root = process.cwd();
const modes = checkGameModes(JSON.parse(fs.readFileSync(path.join(root, 'data', 'game-modes.json'), 'utf-8')));
const acts = JSON.parse(fs.readFileSync(path.join(EN, 'activity_table.json'), 'utf-8')).basicInfo;
const contents = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stages-content.json'), 'utf-8'));
// Counted off data/stages/ rather than the index, because the index is where the
// exclusions are applied -- counting there would report 0 on every re-run.
const stagesDir = path.join(root, 'data', 'stages');
const stageCount = new Map();
for (const file of fs.readdirSync(stagesDir)) {
  if (!file.endsWith('.json')) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(stagesDir, file), 'utf-8'));
  const id = rec.content?.id;
  if (id) stageCount.set(id, (stageCount.get(id) || 0) + 1);
}

const holds = beginStage(root, 'mode-exclusions');
const excluded = {};
for (const [contentId, content] of Object.entries(contents)) {
  if (MODE_KINDS.has(content.kind)) {
    excluded[contentId] = { name: content.name, type: content.kind, stages: stageCount.get(contentId) || 0 };
    continue;
  }
  if (content.kind !== 'event') continue;
  // A content id is an activity id, sometimes with a zone suffix.
  const activity =
    acts[contentId] || Object.entries(acts).find(([id]) => contentId.startsWith(`${id}_`) || contentId.startsWith(id))?.[1];
  const type = activity?.type;
  if (!type) continue;
  const kind = classifyActivity(type, modes);
  if (kind.as === 'excluded') {
    excluded[contentId] = { name: content.name, type, stages: stageCount.get(contentId) || 0 };
  } else if (kind.as === 'unknown') {
    holds.add({
      key: `activity-type:${contentId}`,
      action: 'published-partial',
      reason: `${content.name} (${contentId}) is a ${type} activity, a type data/game-modes.json does not classify, so it is listed as an ordinary event. `
        + 'Say what it is there: excludedActivityTypes for a mode that closes for good, a seasonalChallenges entry, or storyActivityTypes for a story episode.',
    });
  } else if (kind.as === 'challenge' && content.label !== kind.challenge.label) {
    holds.add({
      key: `challenge-label:${contentId}`,
      action: 'published-partial',
      reason: `${content.name} (${contentId}) is a ${kind.challenge.name} season (${type}) but carries the code ${content.label || 'none'}, not ${kind.challenge.label}, `
        + 'so Seasonal Challenge does not list it. Fix the label in data/game-modes.json.',
    });
  }
}

fs.writeFileSync(path.join(root, 'data', 'excluded-contents.json'), JSON.stringify(excluded, null, 0));
const total = Object.values(excluded).reduce((n, e) => n + e.stages, 0);
console.log(`${Object.keys(excluded).length} contents excluded, ${total} stages:`);
for (const [id, e] of Object.entries(excluded).sort((a, b) => b[1].stages - a[1].stages)) {
  console.log(`  ${String(e.stages).padStart(4)}  ${e.type.padEnd(18)} ${e.name} (${id})`);
}
for (const entry of holds.commit()) console.warn(`  ! ${entry.key} (${entry.action}): ${entry.reason}`);
