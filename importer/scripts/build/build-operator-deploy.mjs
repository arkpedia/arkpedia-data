#!/usr/bin/env node
/**
 * Writes public/operator-deploy.json: what the stage map needs to put an operator on a
 * tile and draw the ground it covers.
 *
 *   node scripts/build/build-operator-deploy.mjs
 *
 * WHY IT IS NOT IN data/. The stage page fetches this when the reader opens the deploy
 * bar, rather than importing it -- 407 operators is ~70 kB, and a reader who never
 * opens the bar should not carry it in the page's bundle. public/ is the only place a
 * file can be fetched from at runtime.
 *
 * WHAT THE GAME STORES, and where:
 *
 *   character_table.json   per operator: name, rarity, profession, position, and one
 *                          `phases` entry per elite level -- each with the rangeId it
 *                          covers at that level and, in its first attribute keyframe,
 *                          the DP it costs. Promotion is exactly why the bar has E0/E1/
 *                          E2 buttons: Aak covers 3-1 at E0 and 3-3 from E1, and costs
 *                          11 then 13.
 *   range_table.json       72 grids, each a list of {row, col} offsets from the
 *                          operator's own tile. col is FORWARD -- the direction the
 *                          operator faces -- and row is lateral. Every grid includes
 *                          (0,0), the tile it stands on.
 *
 * SEARCH. The names carry apostrophes and diacritics that nobody types: Ch'en, Wiš'adel,
 * Pozëmka. Every operator therefore gets a folded form -- diacritics stripped,
 * punctuation dropped -- so "wisadel" and "pozemka" find them. Alters get one more: the
 * wiki records in data/operators-*star hold an `alternate` field naming an operator's
 * alters ("Ch'en the Holungday , Ch'en the Dawnstreak"), which is where "chen alter"
 * comes from. Read from our own records rather than re-derived, because the game's
 * tables do not state the relationship anywhere.
 */
import { assetFileNames } from '../lib/public-assets.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EN = process.env.ARKPEDIA_EN || path.join(ROOT, '.cache/upstream/en-gamedata/en/gamedata');

const read = (file) => {
  const full = path.join(EN, 'excel', file);
  if (!fs.existsSync(full)) {
    throw new Error(`missing ${full}\n  run scripts/sync/refresh-stage-data.sh, which syncs the upstream cache first`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};

const characters = read('character_table.json');
const rangeTable = read('range_table.json');

/** The game's profession codes, in the words the game shows. */
const CLASS = {
  PIONEER: 'Vanguard', WARRIOR: 'Guard', TANK: 'Defender', SNIPER: 'Sniper',
  CASTER: 'Caster', MEDIC: 'Medic', SUPPORT: 'Supporter', SPECIAL: 'Specialist',
};

/**
 * Lower case, diacritics gone, punctuation gone: what a reader actually types.
 *
 * Apostrophes are DELETED rather than turned into a space, which is the whole trick --
 * "Ch'en" has to fold to "chen" and not to "ch en", or typing chen finds nothing. Same
 * for the letters NFD leaves alone: ł and đ carry their stroke in the codepoint itself,
 * so Młynar folds to "m ynar" unless they are spelled out first.
 */
const LETTERS = { 'ł': 'l', 'đ': 'd', 'ƀ': 'b', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ð': 'd', 'þ': 'th' };

function fold(text) {
  return String(text)
    .toLowerCase()
    // Punctuation that joins rather than separates: Ch'en, Wiš'adel, Mr. Nothing.
    .replace(/['\u2019\u02bc.]/g, '')
    .replace(/[łđƀøæœßðþ]/g, (c) => LETTERS[c] || c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- the alter relationship, from our own wiki records ----------------------
const alterOf = new Map();      // alter's folded name -> base's folded name
let alterPairs = 0;
for (const dir of fs.readdirSync(path.join(ROOT, 'data')).filter((d) => /^operators-\d+star$/.test(d))) {
  const full = path.join(ROOT, 'data', dir);
  for (const file of fs.readdirSync(full)) {
    if (!file.endsWith('.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
    if (!record.alternate) continue;
    for (const name of String(record.alternate).split(',')) {
      const alter = fold(name);
      if (!alter) continue;
      alterOf.set(alter, fold(record.name));
      alterPairs += 1;
    }
  }
}

/*
 * --- the portraits ---------------------------------------------------------
 *
 * Resolved against the files on disk rather than derived from the name, because two
 * things break the derivation:
 *
 *   Word order. character_table gives the BanG Dream collab operators as "Nyamu
 *   Yūtenji"; the icons, scraped with the wiki records, are "Yūtenji Nyamu". Four
 *   operators, all of them reversed. Matching on the SET of words gets them.
 *
 *   The suffix. Every icon is "<name> - Base.webp" -- that is the convention and
 *   the planner's getStaticProps now fails the build on a file that breaks it --
 *   but an operator can have several labels (skins), so the directory still has
 *   to be read to know which file belongs to whom.
 *
 * Anything still unresolved gets no portrait and says so in the count -- the bar falls
 * back to the class mark, which is better than a 404 and better than dropping an
 * operator whose range someone wanted.
 */
const RARITY_WORD = { 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two', 1: 'one' };
/* The base art, whose label is always "Base"; a skin's label is the skin's own
   name, and any of them is better than no portrait, hence the fallback below. */
const ICON_ORDER = [' - Base.webp'];

const iconsByName = new Map();     // folded name -> url
const iconsByWords = new Map();    // folded words, sorted -> url
for (const [rarity, word] of Object.entries(RARITY_WORD)) {
  void rarity;
  const files = assetFileNames(`${word}-star-icons`, ROOT).filter((f) => f.endsWith('.webp'));
  // Group a folder's files by the operator they belong to, then pick one.
  const byOperator = new Map();
  for (const file of files) {
    const at = file.lastIndexOf(' - ');
    if (at < 0) continue;
    const who = file.slice(0, at);
    if (!byOperator.has(who)) byOperator.set(who, []);
    byOperator.get(who).push(file);
  }
  for (const [who, mine] of byOperator) {
    const chosen = ICON_ORDER.map((suffix) => mine.find((f) => f.endsWith(suffix))).find(Boolean) || mine.sort()[0];
    const url = `/${word}-star-icons/${chosen}`;
    const folded = fold(who);
    if (!iconsByName.has(folded)) iconsByName.set(folded, url);
    const words = folded.split(' ').sort().join(' ');
    if (!iconsByWords.has(words)) iconsByWords.set(words, url);
  }
}

function iconFor(name) {
  const folded = fold(name);
  return iconsByName.get(folded)
    ?? iconsByWords.get(folded.split(' ').sort().join(' '))
    ?? null;
}

// --- the operators ----------------------------------------------------------
const usedRanges = new Set();
const operators = [];
for (const [id, char] of Object.entries(characters)) {
  if (char == null || typeof char !== 'object') continue;
  if (char.profession === 'TOKEN' || char.profession === 'TRAP') continue;
  if (char.isNotObtainable) continue;
  const phases = (Array.isArray(char.phases) ? char.phases : [])
    .map((phase) => {
      const frames = Array.isArray(phase.attributesKeyFrames) ? phase.attributesKeyFrames : [];
      const cost = frames.length ? frames[0]?.data?.cost : null;
      return { cost: typeof cost === 'number' ? cost : null, range: phase.rangeId || null };
    })
    .filter((phase) => phase.range);
  if (!phases.length) continue;
  for (const phase of phases) usedRanges.add(phase.range);

  const folded = fold(char.name);
  const terms = [folded];
  const base = alterOf.get(folded);
  // "chen alter", and the run-together form the community actually says: W's alter is
  // universally "Walter". Both, because both get typed. The term sits on the ALTER, so
  // searching it does not also turn up the operator it is an alter of.
  if (base) terms.push(`${base} alter`, `${base}alter`);

  operators.push({
    id,
    name: char.name,
    rarity: Number(String(char.rarity).replace('TIER_', '')) || 1,
    cls: CLASS[char.profession] || char.profession,
    // MELEE or RANGED, which is what decides the tiles it can stand on.
    reach: char.position === 'MELEE' ? 'melee' : 'ranged',
    icon: iconFor(char.name),
    phases,
    q: [...new Set(terms)].join(' '),
  });
}

// Rarity first and then name, which is the order the game's own squad list uses.
operators.sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));

/*
 * EVERY range in the table, not only the 35 an obtainable operator uses.
 *
 * The other half belong to summons, enemies and unreleased characters, and they cost
 * about 2 kB all together -- so the file is the whole of range_table rather than the
 * slice one feature happens to need today. A token's range is the same kind of fact as
 * an operator's, and the next thing that wants one should not have to rebuild this.
 */
const ranges = {};
for (const [id, entry] of Object.entries(rangeTable).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
  const grids = Array.isArray(entry?.grids) ? entry.grids : [];
  if (!grids.length) continue;
  // [forward, lateral] pairs, which is the order the renderer rotates them in.
  ranges[id] = grids.map((g) => [g.col ?? 0, g.row ?? 0]);
}

fs.writeFileSync(path.join(ROOT, 'public', 'operator-deploy.json'), JSON.stringify({ ranges, operators }));

const kb = Math.round(fs.statSync(path.join(ROOT, 'public', 'operator-deploy.json')).size / 1024);
console.log(`${operators.length} operators and all ${Object.keys(ranges).length} ranges`
  + ` -> public/operator-deploy.json (${kb} kB); ${usedRanges.size} of the ranges are reachable from an operator`);
const byClass = {};
for (const op of operators) byClass[op.cls] = (byClass[op.cls] || 0) + 1;
console.log('  ' + Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`  ${alterPairs} alters carry a "<base> alter" search term`);
const noArt = operators.filter((o) => !o.icon);
console.log(`  ${operators.length - noArt.length} have a portrait`
  + (noArt.length ? `, ${noArt.length} do not: ${noArt.map((o) => o.name).join(', ')}` : ''));
const elites = operators.filter((o) => o.phases.length === 3).length;
console.log(`  ${elites} reach E2, ${operators.filter((o) => o.phases.length === 2).length} stop at E1, ${operators.filter((o) => o.phases.length === 1).length} have no promotion`);
