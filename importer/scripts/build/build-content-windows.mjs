#!/usr/bin/env node
/**
 * Writes data/content-windows.json: {contentId: [startTs, endTs]} in unix
 * seconds, for the contents the game runs for a fixed window.
 *
 * The stage list needs it to open on whatever is running now instead of on a
 * chapter nobody is playing. data/stages-content.json carries only a release
 * date, which cannot say whether something is still on.
 *
 * Windows come from activity_table.json's basicInfo (startTime/endTime) for
 * events, and from crisis_v2_table.json's seasonInfoDataMap (startTs/endTs) for
 * the CCB seasons. Everything else -- the main story, Annihilation, Integrated
 * Strategies, SSS, Supply -- is permanent and gets no window, so it is never
 * "currently running".
 *
 * EN first, then CN for anything EN has not received yet.
 *
 * Re-run after regenerating the dataset:  node scripts/build/build-content-windows.mjs
 */
import fs from 'fs';
import path from 'path';

const EN = `${process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en'}/gamedata/excel`;
const CN = `${process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource'}/gamedata/excel`;

const root = process.cwd();
const contents = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stages-content.json'), 'utf-8'));
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));

const windows = {};
const add = (id, start, end) => {
  if (!id || !start || !end || !contents[id]) return;
  if (!windows[id]) windows[id] = [start, end];
};

for (const dir of [EN, CN]) {
  const acts = read(dir, 'activity_table.json').basicInfo;
  for (const [id, act] of Object.entries(acts)) {
    // A content id is an activity id, sometimes with a zone suffix.
    const match = Object.keys(contents).find((c) => c === id || c.startsWith(`${id}_`));
    add(match, act.startTime, act.endTime);
  }
  const crisis = read(dir, 'crisis_v2_table.json').seasonInfoDataMap || {};
  for (const season of Object.values(crisis)) add(season.seasonId, season.startTs, season.endTs);
}

fs.writeFileSync(path.join(root, 'data', 'content-windows.json'), JSON.stringify(windows));
const now = Math.floor(Date.now() / 1000);
const live = Object.entries(windows).filter(([, [s, e]]) => s <= now && now <= e);
console.log(`${Object.keys(windows).length} of ${Object.keys(contents).length} contents have a run window`);
console.log(`running right now (${new Date(now * 1000).toISOString().slice(0, 10)}): ${live.length}`);
for (const [id, [s, e]] of live.sort((a, b) => b[1][0] - a[1][0])) {
  console.log(`  ${new Date(s * 1000).toISOString().slice(0, 10)} -> ${new Date(e * 1000).toISOString().slice(0, 10)}  ${id.padEnd(18)} ${contents[id].name}`);
}
