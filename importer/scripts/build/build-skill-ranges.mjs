#!/usr/bin/env node
/**
 * Writes data/skill-ranges.json: the skills that change their operator's attack range.
 *
 *   node scripts/build/build-skill-ranges.mjs
 *
 * Some skills move the tiles an operator covers, and the site had no way to say so.
 * Myrtle's Healing Wings takes her from the one tile in front of her to the eight
 * around her; Gitano's Destiny trades reach for width. 217 skills do this among the
 * operators the site carries, and a reader deciding which skill to mastery cannot see
 * any of it.
 *
 * WHAT THE GAME STORES, and where:
 *
 *   skill_table.json       one entry per skill, with a `levels` array. A level may carry
 *                          a `rangeId`, which is the range in force while that skill is
 *                          active. Most skills carry none.
 *   character_table.json   per operator: the ordered `skills` list, and one `phases`
 *                          entry per elite level with the rangeId it covers normally.
 *                          Both halves are needed: a rangeId only means something
 *                          against the range it replaces.
 *   range_table.json       72 grids, each a list of {row, col} offsets from the
 *                          operator's own tile. col is FORWARD, row is lateral, and
 *                          every grid includes (0,0), the tile it stands on.
 *
 * PLUS char_patch_table.json, which is where the game keeps Amiya's Guard and Medic
 * forms: not in character_table at all, but shaped like an entry from it, and named in
 * English by the EN skill_table, so they need no special handling beyond being looked up
 * somewhere else. Amiya (Guard) S2 widens 1-1 to x-2; Amiya (Medic) S1 turns 3-3 into
 * x-1. Reading it is not optional -- without it those two records match no character and
 * the run fails.
 *
 * AND THE SAME THREE FROM CN, for the 18 operators the site carries that global has not
 * shipped. They are absent from the EN character_table entirely, so an EN-only pass left
 * 11 range-changing skills unmentioned, Zima the Raging Tide's I Will Not Relent among
 * them. Loaded only when such an operator is present. See cn() below for what CN can and
 * cannot be trusted for.
 *
 * WHAT IS LEFT OUT, deliberately:
 *
 *   Skills whose rangeId equals one of the operator's own phase ranges. 109 of them.
 *   The field is set but nothing changes, and "range: same as normal" tells a reader
 *   nothing.
 *
 *   Tokens, summons and Integrated Strategies characters. 70 of them have skill range
 *   changes and none is an operator the site has a page for.
 *
 * THE JOIN is by charId and skill INDEX, not by name. The operator records carry
 * `internalName` -- the game's own charId -- and both sides order an operator's skills
 * the same way, so S1 is S1. Checked when this was written: 206 of 206 matched with no
 * index out of range, and the names agreed on every one. A name join would have had to
 * cope with Ch'en, Wiš'adel and quoted skill names like "Provocate".
 *
 * Nothing in either table ENFORCES that alignment, though, and the range comes from the
 * gamedata while the name printed beside it comes from our record -- so a reorder would
 * pair a real skill with another skill's grid and look entirely plausible on the page.
 * collect() therefore checks it and fails the build: against the English name for an EN
 * operator, and against the skill count for a CN one, which has no English name to
 * compare.
 *
 * SHAPE. Each entry carries the range at EVERY skill level, not just the final one.
 * Four skills among the site's operators do not hold one range for all ten levels --
 * Asbestos S2, Mayer S1 and Schwarz S3 step up at M1, Swire S1 at plain level 7 -- and
 * showing only the last of them meant the page drew Mayer's mastery range beside her
 * level 1 description. `levelRangeIds` has one id per level and `grids` holds the
 * distinct grids it names, each pre-decoded into the CroppedRange the operator page's
 * RangeGridBox already renders: 1-indexed coordinates, cols/rows, the operator's own
 * cell separate from the rest, so the page needs no geometry of its own.
 *
 * levelRangeIds is indexed by the level's own SEMANTIC position -- 0-6 are levels 1-7
 * and 7-9 are M1-M3 -- not by wherever the level happens to sit in an array. The page
 * derives the same index from the step it is showing, so the two sides cannot drift
 * out of alignment the way two parallel arrays would.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EN = process.env.ARKPEDIA_EN || path.join(ROOT, '.cache/upstream/en-gamedata/en/gamedata');

function readTable(name) {
  /* The pipeline's own cache first, then the ad-hoc one a bare run of this script
     leaves in .cache/. Failing both is a real error: this cannot be guessed. */
  for (const p of [path.join(EN, 'excel', name), path.join(ROOT, '.cache', name)]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(
    `${name} not found. Run \`npm run stages:refresh\` to sync the gamedata, or fetch it to .cache/${name}.`,
  );
}

const skillTable = readTable('skill_table.json');
const charTable = readTable('character_table.json');
const rangeTable = readTable('range_table.json');
/* Amiya's Guard and Medic forms are not in character_table -- the game keeps its class
   forms in their own table, shaped the same way. Without this the two operator records
   would match no character at all and the run would fail rather than skip them. */
const patchTable = readTable('char_patch_table.json');

/**
 * The CN tables, for the operators global has not shipped yet.
 *
 * The site carries 18 operators that are not in the EN character_table at all, because
 * CN runs about half a year ahead and our records come from a wiki that follows it. This
 * script used to iterate the EN table, so those 18 were invisible and 11 range-changing
 * skills went unmentioned -- Zima the Raging Tide's I Will Not Relent among them, which
 * is the next event.
 *
 * A rangeId is locale-independent and so is a range_table grid, so nothing is lost by
 * reading them from CN: the ids are the same strings and the geometry is the same
 * geometry. What IS lost is the English skill name, which is why the ordering guard
 * below has to work differently for these.
 *
 * Loaded on demand. A run with no CN-only operators should not have to parse 26 MB, and
 * a fresh clone that has only ever synced the EN mirror should still work.
 */
const CN = process.env.ARKPEDIA_CN || path.join(ROOT, '.cache/upstream/cn-resource');
let cnTables = null;
function cn() {
  if (cnTables) return cnTables;
  const read = (name) => {
    for (const p of [path.join(CN, 'gamedata/excel', name), path.join(ROOT, '.cache', `cn_${name}`)]) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    throw new Error(
      `the CN ${name} is needed for operators global has not shipped yet, and is not in\n`
      + `  ${path.join(CN, 'gamedata/excel', name)}\n`
      + `  ${path.join(ROOT, '.cache', `cn_${name}`)}\n`
      + 'Run `npm run stages:refresh`, which syncs the CN mirror as well.',
    );
  };
  cnTables = {
    charTable: read('character_table.json'),
    skillTable: read('skill_table.json'),
    rangeTable: read('range_table.json'),
  };
  return cnTables;
}

/**
 * A range's grid, cropped to what it occupies and 1-indexed for CSS grid.
 *
 * The game stores offsets from the operator's tile, so they run negative in both
 * directions. Shifting by the minimum puts the top-left cell at 1,1 and keeps the
 * operator's own tile wherever it falls inside that box, which is what the renderer
 * needs to draw it differently from the rest.
 *
 * `col` is the direction the operator faces, so it becomes the grid's COLUMN and row
 * its row: the box reads left to right the way the operator looks.
 */
function croppedRange(rangeId, tables) {
  /* The character's own locale first. The two tables agree on every id they share, but
     CN has one grid EN does not (y-11, which Kal'tsit - Esperanta's S2 uses), so a
     CN-only operator resolved against EN alone would fail the guard below. */
  const entry = tables.map((t) => t[rangeId]).find(Boolean);
  const grids = Array.isArray(entry?.grids) ? entry.grids : [];
  if (!grids.length) return null;
  return cropCells(grids.map((g) => [g.row ?? 0, g.col ?? 0]));
}

/**
 * A list of offsets, cropped and 1-indexed the way the renderer wants it.
 *
 * Split out of croppedRange so an extended grid -- one this script computes rather than
 * reads -- lands in exactly the same shape as one the game names.
 */
function cropCells(raw) {
  const cells = raw.map(([r, c]) => [r, c]);
  /* (0,0) is the operator's tile. It is always in the table, but a grid that somehow
     lacked it would render with no operator cell at all, so it is added rather than
     assumed. */
  if (!cells.some(([r, c]) => r === 0 && c === 0)) cells.push([0, 0]);
  const minRow = Math.min(...cells.map((c) => c[0]));
  const maxRow = Math.max(...cells.map((c) => c[0]));
  const minCol = Math.min(...cells.map((c) => c[1]));
  const maxCol = Math.max(...cells.map((c) => c[1]));
  const at = ([r, c]) => [r - minRow + 1, c - minCol + 1];
  return {
    cols: maxCol - minCol + 1,
    rows: maxRow - minRow + 1,
    opCell: at([0, 0]),
    rangeCells: cells.filter(([r, c]) => !(r === 0 && c === 0)).map(at),
  };
}

/**
 * The OTHER way a skill changes the range, and the one this script used to miss.
 *
 * Twenty skills among the site's operators name no rangeId at all and instead carry
 * `ability_range_forward_extend` on their blackboard -- Archetto's Thundering Arrows
 * says "attack range +1 tile" and that is where the +1 lives. Read only when the skill
 * names no rangeId on any level: where the game gives both, the named grid is the
 * answer and this is a detail of it (Necrass S3).
 *
 * Per LEVEL, because four of the twenty scale: Ansel, Folinic, Weedy and Hellagur go
 * from +1 to +2 partway up, which is a range that changes with the level exactly the
 * way Mayer's does.
 *
 * `attack@ability_range_forward_extend` is deliberately NOT read. It is a different
 * key on a different part of the skill, and Pepe's S3 sets it to 0.25, which is not a
 * count of tiles.
 */
function forwardExtend(level) {
  /* Array.isArray, not `|| []`: a handful of levels carry a blackboard that is not a
     list at all, and .find on those threw the whole run. */
  const board = Array.isArray(level.blackboard) ? level.blackboard : [];
  const kv = board.find((b) => b?.key === 'ability_range_forward_extend');
  const n = Number(kv?.value);
  return Number.isFinite(n) && Number.isInteger(n) && n !== 0 ? n : 0;
}

/**
 * A range extended forward by n tiles, per ROW -- each row reaches n further than it
 * did, rather than the whole grid squaring off to the deepest row's new reach.
 *
 * Per-row is not a guess. Both readings agree on every rectangular base, so they were
 * separated by the one affected skill whose base is ragged: Passenger's S2 on 3-1,
 * where per-row produces the game's own grid 3-8 and the square reading produces a
 * shape range_table does not contain. Seventeen of the twenty land exactly on a grid
 * the game already names -- 3-3+1 is 3-10, 3-3+2 is 5-2, 1-1+2 is 3-2 -- which is the
 * check countNamed below keeps running.
 *
 * n may be negative: Narantuya's Whirling Blade is -1, and pulling one tile off the
 * front of each row of y-7 gives y-2, again a grid the game names. The operator's own
 * tile is never removed.
 */
function extendForward(cells, n) {
  const rows = [...new Set(cells.map(([r]) => r))];
  const out = new Set(cells.map(([r, c]) => `${r},${c}`));
  for (const r of rows) {
    for (let k = 0; k < Math.abs(n); k += 1) {
      const inRow = [...out].map((s) => s.split(',').map(Number)).filter(([rr]) => rr === r);
      if (!inRow.length) break;
      const edge = Math.max(...inRow.map(([, c]) => c));
      if (n > 0) out.add(`${r},${edge + 1}`);
      else if (!(r === 0 && edge === 0)) out.delete(`${r},${edge}`);
    }
  }
  return [...out].map((s) => s.split(',').map(Number));
}

/** How many computed extensions matched a grid the game itself names, which is the
 *  only free check on the geometry above. Reported at the end of a run. */
const extendCheck = { named: 0, computed: 0 };
function namedEquivalent(cells, tables) {
  const key = (list) => [...list].map(([r, c]) => `${r},${c}`).sort().join(' ');
  const want = key(cells);
  for (const table of tables) {
    for (const [rid, entry] of Object.entries(table)) {
      const grids = Array.isArray(entry?.grids) ? entry.grids : [];
      if (!grids.length) continue;
      const got = grids.map((g) => [g.row ?? 0, g.col ?? 0]);
      if (!got.some(([r, c]) => r === 0 && c === 0)) got.push([0, 0]);
      if (key(got) === want) return rid;
    }
  }
  return null;
}

/**
 * What a skill level is called: seven plain levels, then three masteries.
 *
 * Used to say WHERE a range change happens. "Shown at mastery" was wrong for Swire,
 * whose Command and Dispatch widens at level 7 with no mastery involved.
 *
 * The index is the semantic one -- 0-6 are levels 1-7, 7-9 are M1-M3 -- which is also
 * how levelRangeIds is indexed and how the page finds its way into it.
 */
const levelLabel = (i) => (i < 7 ? `Level ${i + 1}` : `M${i - 6}`);

/** Every operator record the site has, by the game's charId. */
function siteOperators() {
  const byId = new Map();
  for (const dir of fs.readdirSync(path.join(ROOT, 'data'))) {
    if (!dir.startsWith('operators-')) continue;
    const full = path.join(ROOT, 'data', dir);
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
      if (record.internalName) byId.set(record.internalName, record);
    }
  }
  return byId;
}

/* Fold before comparing: the two sources quote differently -- the gamedata writes
   'Witch's Tears' where our record writes "Witch's Tears" -- and eight skills differ
   by nothing else. Also strips accents, so Swire and Swire compare equal. */
const fold = (s) => (s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['\u2019"\u201c\u201d.\s-]/g, '');

/* Operators whose EN skill names legitimately differ between the two sources, because
   our records were scraped from the wiki at a different time than the gamedata mirror
   was cut and the translation was revised in between. Listed one by one rather than
   waved through, because the check below is the only thing standing between a reordered
   skill list and a page confidently drawing the wrong grid. Bellone: all three of its
   skills were renamed and the order is plainly intact -- A Don's Plenty / Don's Ease,
   An Advisor's Tricks / Consigliere's Schemes, Riscossione / Settling Old Scores. */
const KNOWN_NAME_DRIFT = new Set([
  'Bellone S2',
  // These records used pre-release names; their released Global names are
  // applied later in the same refresh after the stage importer has populated
  // the shared English tables. The skill slots and range data are unchanged.
  'Botani S2',
  'Zima the Raging Tide S2',
]);

const operators = siteOperators();
const out = {};
const problems = [];
let changes = 0;
let unchanged = 0;
let offSite = 0;
let fromCn = 0;

/**
 * One operator, from whichever gamedata has it.
 *
 * `source` decides two things: which range_table is consulted first, and how the
 * positional join is checked. For an EN operator the gamedata names the skill in English
 * and the name is compared against ours. For a CN one it does not, so the check falls
 * back to the skill COUNT -- weaker, and the only structural signal left that the two
 * lists still line up.
 */
function collect(charId, character, tables, source) {
  const phaseRanges = (character.phases || []).map((p) => p.rangeId).filter(Boolean);
  const skills = character.skills || [];

  for (let i = 0; i < skills.length; i += 1) {
    const skill = tables.skillTable[skills[i]?.skillId];
    if (!skill) continue;

    /* One rangeId per level, in the game's own order: levels 1-7 then M1-M3. Four skills
       among the site's operators do not hold one range for all ten -- Asbestos S2,
       Mayer S1 and Schwarz S3 step up at M1, and Swire S1 at plain level 7, before any
       mastery -- so this is kept per level rather than collapsed to the last one. */
    const perLevel = (skill.levels || []).map((l) => l.rangeId || null);
    const levelRanges = perLevel.filter(Boolean);

    /* A skill that names no grid may still move the range, by extending it forward a
       tile or two from the blackboard. That is twenty skills here, and this `continue`
       is where every one of them used to be dropped -- Archetto's Thundering Arrows
       says "attack range +1 tile" on the page and drew nothing beside it. */
    const perLevelExtend = levelRanges.length
      ? (skill.levels || []).map(() => 0)
      : (skill.levels || []).map(forwardExtend);
    const extends_ = perLevelExtend.some((n) => n !== 0);
    if (!levelRanges.length && !extends_) continue;

    const rangeId = levelRanges.length ? levelRanges[levelRanges.length - 1] : null;

    /* Whether the skill appears at all is still decided by its FINAL range against the
       operator's own. Deliberately unchanged: judging it per level would start admitting
       skills whose range matches the E2 phase but not the E0 one, which would alter what
       the site shows for reasons that have nothing to do with per-level ranges. An
       extension can never equal the range it extends, so it has nothing to skip. */
    if (rangeId && phaseRanges.includes(rangeId)) { unchanged += 1; continue; }

    const record = operators.get(charId);
    if (!record) { offSite += 1; continue; }

    const baseId = phaseRanges[phaseRanges.length - 1];
    const baseRange = baseId ? croppedRange(baseId, tables.ranges) : null;

    /* A level that names no range of its own leaves the operator's normal one in force,
       so it is stored as the base id rather than as a null the page would have to know
       what to do with. Every slot in the array is therefore a range that can be drawn.
       Only one skill in either gamedata mixes the two (a token's, so not reached here),
       but the page should not have to care which.

       For an extending skill the id says what it is -- "3-3+1" is the operator's own
       3-3 reaching one tile further. A synthetic id rather than the equivalent named
       grid, because the extension is the fact and the name is a coincidence of the
       game's own table: seventeen of the twenty happen to land on one and three do not,
       and a mix of real and synthetic ids would read as though that meant something. */
    const levelRangeIds = extends_
      ? perLevelExtend.map((n) => (baseId ? (n === 0 ? baseId : `${baseId}${n > 0 ? '+' : ''}${n}`) : null))
      : perLevel.map((r) => r || baseId || null);

    /* One decoded grid per distinct id. Two at most today, one for all but four skills,
       and the page indexes straight into it. */
    const grids = {};
    let undecodable = null;
    for (const id of new Set(levelRangeIds.filter(Boolean))) {
      let grid;
      if (extends_ && id !== baseId) {
        const n = Number(id.slice(baseId.length));
        const baseEntry = tables.ranges.map((t) => t[baseId]).find(Boolean);
        const raw = (baseEntry?.grids || []).map((g) => [g.row ?? 0, g.col ?? 0]);
        if (!raw.some(([r, c]) => r === 0 && c === 0)) raw.push([0, 0]);
        const moved = extendForward(raw, n);
        extendCheck.computed += 1;
        if (namedEquivalent(moved, tables.ranges)) extendCheck.named += 1;
        grid = raw.length ? cropCells(moved) : null;
      } else {
        grid = croppedRange(id, tables.ranges);
      }
      if (!grid) { undecodable = id; break; }
      grids[id] = grid;
    }
    if (undecodable) {
      problems.push(`${record.name} S${i + 1}: rangeId "${undecodable}" is in no range_table`);
      continue;
    }
    /* A hole here would make the page draw nothing at that level and say nothing about
       why, so it fails the build instead. Reachable only if a level named no range and
       the operator has no phase range either. */
    const holes = levelRangeIds
      .map((id, idx) => (id && grids[id] ? null : levelLabel(idx)))
      .filter(Boolean);
    if (holes.length) {
      problems.push(
        `${record.name} S${i + 1}: no range could be resolved for ${holes.join(', ')}, `
        + 'so those levels would draw an empty grid',
      );
      continue;
    }

    /* Where the range changes, named rather than numbered, for the page's note. Every
       step, not just the first: nothing in the gamedata says a skill may only change
       once, and a second change would otherwise go unmentioned. */
    const changesAt = levelRangeIds
      .map((id, idx) => (idx > 0 && id !== levelRangeIds[idx - 1] ? levelLabel(idx) : null))
      .filter(Boolean);

    const list = (record.skills || {}).skillList || [];
    if (i >= list.length) {
      problems.push(`${record.name}: has ${list.length} skills on the site but the game gives it ${skills.length}, so S${i + 1} cannot be placed`);
      continue;
    }

    /* The join is positional: slot i of the gamedata's skill list is assumed to be slot
       i of ours, and nothing enforces that. The range comes from the gamedata while the
       name shown beside it comes from our record, so a reorder in either source would
       pair a real skill with another skill's grid and look entirely plausible. */
    if (source === 'en') {
      const gameName = (skill.levels || [])[0]?.name ?? null;
      const siteName = list[i]?.name ?? null;
      if (gameName && siteName && fold(gameName) !== fold(siteName) && !KNOWN_NAME_DRIFT.has(`${record.name} S${i + 1}`)) {
        problems.push(
          `${record.name} S${i + 1}: the game calls this "${gameName}" and we call it "${siteName}", `
          + 'so the two skill lists may no longer be in the same order',
        );
        continue;
      }
      /* The page finds the range for the level it is showing by the level's own
         position -- levels 1-7 then M1-M3 -- so our record and the gamedata have to
         agree on how many levels the skill has. They always do today (921 skills with
         ten, 17 three-stars with seven), and if they ever stop, the page would read
         past the end of levelRangeIds and quietly draw the last range at every level
         instead. Cheaper to fail here. */
      const ourLevels = (list[i]?.levels || []).length;
      if (ourLevels !== perLevel.length) {
        problems.push(
          `${record.name} S${i + 1}: the game gives this skill ${perLevel.length} levels `
          + `and our record has ${ourLevels}, so a per-level range cannot be lined up`,
        );
        continue;
      }
    } else if (list.length !== skills.length) {
      /* No English name to compare, so the count is the check. A mismatch means one list
         gained or lost a skill and the indices can no longer be trusted to line up. */
      problems.push(
        `${record.name} S${i + 1}: the CN gamedata gives it ${skills.length} skills and we list ${list.length}, `
        + 'so the two lists may no longer be in the same order (no English name to compare against)',
      );
      continue;
    }

    (out[record.name] ||= {})[String(i + 1)] = {
      skillName: list[i]?.name ?? null,
      /* The range it replaces, so the page can show what changed rather than only what
         it becomes. Null for an operator with no phase range at all. */
      baseRangeId: baseId ?? null,
      baseRange,
      /* One id per level, indexed by the level's own position: 0-6 are levels 1-7 and
         7-9 are M1-M3. Always the full array, even for the skills that hold one range
         throughout, so the page reads it the same way every time. */
      levelRangeIds,
      /* The distinct grids those ids name. One entry for all but four skills. */
      grids,
      /* Levels where the range differs from the level below, named rather than
         numbered so the page has nothing to interpret. Empty for a skill that holds one
         range throughout, which is all but four of them. */
      changesAt,
    };
    changes += 1;
    if (source === 'cn') fromCn += 1;
  }
}

for (const [charId, character] of Object.entries(charTable)) {
  collect(charId, character, { skillTable, ranges: [rangeTable] }, 'en');
}

/* Then Amiya's class forms, out of char_patch_table. Global has them, the EN skill_table
   names their skills in English, and their phases and skills are shaped exactly like a
   character_table entry -- so they go through as an EN source, name guard and all.
   Amiya (Guard) S2 widens 1-1 to x-2 and Amiya (Medic) S1 turns 3-3 into x-1. */
const patchChars = patchTable.patchChars || {};
const notInChars = [...operators.keys()].filter((charId) => !charTable[charId]);
const patchBefore = changes;
for (const charId of notInChars.filter((c) => patchChars[c])) {
  collect(charId, patchChars[charId], { skillTable, ranges: [rangeTable] }, 'en');
}
const fromPatch = changes - patchBefore;

/* Then the operators only CN has. Driven off our own records rather than off the CN
   table, which holds thousands of characters the site will never carry. */
const cnOnly = notInChars.filter((charId) => !patchChars[charId]);
if (cnOnly.length) {
  const t = cn();
  const tables = { skillTable: t.skillTable, ranges: [t.rangeTable, rangeTable] };
  for (const charId of cnOnly) {
    const character = t.charTable[charId];
    if (!character) {
      problems.push(
        `${operators.get(charId).name} (${charId}) is in neither gamedata, so its skill ranges cannot be read`,
      );
      continue;
    }
    collect(charId, character, tables, 'cn');
  }
}

if (problems.length) {
  console.error('\n[skill-ranges] the gamedata and our records disagree:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nA rangeId missing from range_table means the grid cannot be drawn at all.');
  console.error('A name disagreement means the skill lists may have diverged in order. Check');
  console.error('the two lists side by side. If the order is fine and only the wording changed,');
  console.error('add the slot to KNOWN_NAME_DRIFT above with a line saying why.');
  console.error('For a CN-only operator there is no English name to compare, so the message');
  console.error('names the two skill counts instead. Check our record against the CN table.');
  process.exit(1);
}

fs.writeFileSync(
  path.join(ROOT, 'data/skill-ranges.json'),
  `${JSON.stringify(out, null, 2)}\n`,
);

console.log(`  ${changes} skills change their operator's range, across ${Object.keys(out).length} operators`);
console.log(
  `  ${extendCheck.computed} of those grids were computed by extending the operator's own range forward, `
  + `${extendCheck.named} of which land exactly on a grid the game itself names`,
);
console.log(`  ${unchanged} skills set a rangeId that matches the operator's own range, so nothing changes`);
console.log(`  ${offSite} belong to tokens, summons or IS characters the site has no page for`);
console.log(`  ${fromCn} of them come from the CN gamedata, for operators global has not shipped yet`);
console.log(`  ${fromPatch} come from char_patch_table, which is where Amiya's class forms live`);
