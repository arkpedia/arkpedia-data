// The level files present on disk. Content resolution needs this: 168 event
// levels have no stage row at all, and the Battleplan seasons are matched to
// their operations by filename, so "what is in the dump" is an input.
//
// The EN folder only, deliberately. A level file here becomes a stage record even
// without a stage_table row (synthetic.mjs), so listing the CN mirror too would mint
// CN-only stages Global has not got. The CN fallback in gamedata.mjs (levelFile) is
// for stages the EN tables already name. cnSeasonLevels() below is the one exception.
import fs from 'node:fs';
import path from 'node:path';
import { cnExcel, cnLevelsDir, excel, levelsDir } from './gamedata.mjs';

export function levelIds(dir = levelsDir) {
  const out = new Set();
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), next);
      else if (e.name.endsWith('.json')) out.add(next.slice(0, -5).toLowerCase());
    }
  };
  if (!fs.existsSync(dir)) {
    throw new Error(`no level files under ${dir}\n  the EN sparse checkout needs en/gamedata/levels`);
  }
  walk(dir, '');
  return out;
}

// Contingency Contract Battleplan operations: obt/crisis/v2/level_crisis_v2_<season>-<n>.
const CRISIS_FOLDER = ['obt', 'crisis', 'v2'];
const CRISIS_FILE = /^level_crisis_v2_(\d+)-\d+\.json$/i;

/** Season numbers of a crisis_v2_table's seasonInfoDataMap ('crisis_v2_season_5_1' is 5). */
export function battleplanSeasonNumbers(seasons) {
  const out = new Set();
  for (const seasonId of Object.keys(seasons || {})) {
    const match = /season_(\d+)/.exec(seasonId);
    if (match) out.add(Number(match[1]));
  }
  return out;
}

/**
 * The ONE kind of CN-only level that becomes a stage: an operation of a Battleplan
 * season the CN table lists and the EN table does not yet.
 *
 * CN runs a season about half a year before Global, on maps a reader prepares for in
 * advance, and the season's contracts are already published from CN snapshots; without
 * its operations the page has no map and no enemies for them. The rule is deliberately
 * this narrow. A level qualifies only if it sits in the Battleplan folder, its season
 * number is a row of the CN season table, that number is not an EN season, and the EN
 * mirror has no such file. So no other CN-only stage arrives, and once Global runs the
 * season its EN level files and EN season row take over with nothing to remove here.
 *
 * Returns level keys in the form levelIds() uses. Empty when the CN tables are not on
 * disk: the build then publishes what Global has, as before.
 */
export function cnSeasonLevels(enLevels, {
  enSeasons = excel('crisis_v2_table').seasonInfoDataMap,
  cnSeasons = cnExcel('crisis_v2_table')?.seasonInfoDataMap,
  dir = cnLevelsDir,
} = {}) {
  const out = [];
  const global = battleplanSeasonNumbers(enSeasons);
  const ahead = [...battleplanSeasonNumbers(cnSeasons)].filter((number) => !global.has(number));
  if (!ahead.length) return out;
  // The mirrors do not agree on case, so each folder is found by name, not spelled.
  let folder = dir;
  for (const part of CRISIS_FOLDER) {
    if (!fs.existsSync(folder)) return out;
    const found = fs.readdirSync(folder, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === part);
    if (!found) return out;
    folder = path.join(folder, found.name);
  }
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const match = entry.isFile() ? CRISIS_FILE.exec(entry.name) : null;
    if (!match || !ahead.includes(Number(match[1]))) continue;
    const key = `${CRISIS_FOLDER.join('/')}/${entry.name.slice(0, -5).toLowerCase()}`;
    if (!enLevels.has(key)) out.push(key);
  }
  return out.sort();
}
