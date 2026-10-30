#!/usr/bin/env node
/**
 * Writes data/enemy-stage-appearances.json: for each enemy, the content it can be
 * fought in and WHICH STAGES of that content field it.
 *
 * data/enemy_appearances.json already says which contents field an enemy, but not
 * which stages inside them, and the enemy page needs a stage to link to.
 *
 * The join comes from the stage dataset: every record in data/stages/ lists the
 * enemies it fields by the same slug the enemy records use. It runs in the stage
 * refresh chain, after the index enrichment and build-enemy-records.mjs:
 *
 *   node scripts/build/build-enemy-stage-appearances.mjs
 *
 * ARKPEDIA_STAGES and ARKPEDIA_STAGE_INDEX point it at another checkout's
 * data/stages and public/stages-index.json.
 *
 * Only stages that actually get a page are emitted -- the index is the allowlist --
 * so the links this feeds cannot 404 on an excluded stage.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ARKPEDIA_ROOT || process.cwd();
const STAGES = process.env.ARKPEDIA_STAGES || path.join(ROOT, 'data/stages');
const INDEX = process.env.ARKPEDIA_STAGE_INDEX || path.join(ROOT, 'public/stages-index.json');
const OUT = path.join(ROOT, 'data/enemy-stage-appearances.json');

if (!fs.existsSync(STAGES) || !fs.existsSync(INDEX)) {
  console.error(`no stage dataset at ${STAGES} / ${INDEX}\n`
    + '  set ARKPEDIA_STAGES and ARKPEDIA_STAGE_INDEX to a checkout that has it');
  process.exit(1);
}

// The stages that get a page. Anything outside this is excluded content with no
// page to link to.
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const listed = new Map(index.map((row) => [row.slug, row]));

/** enemy slug -> content id -> {content fields, stages: Map<code, entry>} */
const byEnemy = new Map();

for (const file of fs.readdirSync(STAGES)) {
  if (!file.endsWith('.json')) continue;
  const stage = JSON.parse(fs.readFileSync(path.join(STAGES, file), 'utf8'));
  const row = listed.get(stage.slug);
  if (!row) continue;                         // excluded content: no page exists
  const content = stage.content;
  if (!content?.id) continue;

  const enemies = stage.enemies || {};
  const slugs = new Set();
  for (const group of [enemies.by_rank, enemies.conditional?.by_rank]) {
    for (const list of Object.values(group || {})) {
      for (const entry of list || []) if (entry.slug) slugs.add(entry.slug);
    }
  }
  if (!slugs.size) continue;

  for (const slug of slugs) {
    if (!byEnemy.has(slug)) byEnemy.set(slug, new Map());
    const contents = byEnemy.get(slug);
    if (!contents.has(content.id)) {
      contents.set(content.id, {
        kind: content.kind,
        id: content.id,
        // Again the index rather than the record: the Battleplan seasons are
        // relabelled CCB there, because the community calls the old CC#1-12 "CC"
        // and this series "CCB". The record's own content block predates that step.
        label: row.contentLabel ?? content.label ?? null,
        name: row.contentName || content.name,
        stages: new Map(),
      });
    }
    const bucket = contents.get(content.id).stages;
    // Keyed by the BASE stage, not by the code. A stage and its re-cuts share one
    // code and one map, so "4-3" and "4-3 Challenge Mode" fold into one row -- but
    // 400 Integrated Strategies nodes ALSO share the placeholder code "ISW-NO"
    // while being 400 different maps. Keying on code collapsed those too, and
    // Gopnik went from 358 stages to 12.
    const key = row.variantOf || stage.slug;
    const seen = bucket.get(key);
    const candidate = {
      // The INDEX's code and name, not the record's: the index is the enriched
      // one. Battleplan operations have no code in gamedata at all, so the record
      // falls back to the level filename and the page would print
      // "level_crisis_v2_01-01" where the index says "CCB#1-1 / Main Test Site".
      // The index also carries the names borrowed for 144 otherwise-unnamed stages.
      code: row.code || stage.code || stage.slug,
      // The code is a placeholder on IS and Reclamation nodes, where the name is
      // the only thing that tells two of them apart.
      name: row.name || stage.name || null,
      slug: stage.slug,
      order: stage.order ?? 0,
      variant: stage.variant?.kind ? (stage.variant.label || stage.variant.kind) : null,
    };
    // Prefer the plain cut: name a form only when it is the sole way to meet this
    // enemy, since the base stage is the page a reader wants.
    if (!seen || (seen.variant && !candidate.variant)) bucket.set(key, candidate);
  }
}

// Contents in the order the stage index already sorts them, which is the order the
// enemy page's existing groups use: release date, then label.
const contentOrder = new Map();
for (const row of index) {
  if (row.contentId != null && !contentOrder.has(row.contentId)) contentOrder.set(row.contentId, contentOrder.size);
}

// --- emit -------------------------------------------------------------------
// Normalised, because the obvious shape repeats itself hard: 4,943 content blocks
// across the enemies are only 129 distinct ones, and 13,112 stage rows are only
// 2,299. Writing them once and referring to them by index takes the file from
// 1.4MB to a fifth of that, which matters because this is regenerated on every
// stage refresh and a compact JSON rewrites whole.
const contentTable = [];
const contentIndex = new Map();
const stageTable = [];
const stageIndex = new Map();

function contentRef(c) {
  const key = `${c.kind}\u0000${c.id}`;
  if (!contentIndex.has(key)) {
    contentIndex.set(key, contentTable.length);
    contentTable.push([c.kind, c.id, c.label ?? null, c.name]);
  }
  return contentIndex.get(key);
}

function stageRef(s) {
  if (!stageIndex.has(s.slug)) {
    stageIndex.set(s.slug, stageTable.length);
    // slug and name are dropped where they are derivable from the code: 6,958 of
    // the rows have slug === code.toLowerCase(), and a nameless stage repeats it.
    const row = [s.code];
    const implied = s.code.toLowerCase();
    row.push(s.slug === implied ? null : s.slug);
    row.push(s.name && s.name !== s.code ? s.name : null);
    if (s.variant) row.push(s.variant);
    while (row.length > 1 && row[row.length - 1] === null) row.pop();
    stageTable.push(row);
  }
  return stageIndex.get(s.slug);
}

const enemies = {};
let pairs = 0;
for (const [slug, contents] of [...byEnemy].sort(([a], [b]) => (a < b ? -1 : 1))) {
  enemies[slug] = [...contents.values()]
    .sort((a, b) => (contentOrder.get(a.id) ?? Infinity) - (contentOrder.get(b.id) ?? Infinity))
    .map((c) => {
      // One row per stage a reader would recognise. Keying on the base stage above
      // keeps 400 same-coded IS nodes apart, but it also keeps every RERUN of an
      // event stage: TN-2 "Industrial Depths" is three stage_table rows under one
      // content, and listing it three times says nothing. Same code AND same name
      // means the same stage to a player, so collapse those; the IS nodes survive
      // because their names differ.
      const unique = new Map();
      for (const stage of c.stages.values()) {
        const key = `${stage.code}\u0000${stage.name || ''}`;
        const seen = unique.get(key);
        if (!seen || (seen.variant && !stage.variant)) unique.set(key, stage);
      }
      const stages = [...unique.values()].sort((a, b) => a.order - b.order
        || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      pairs += stages.length;
      // [content index, ...stage indexes]
      return [contentRef(c), ...stages.map(stageRef)];
    });
}

fs.writeFileSync(OUT, JSON.stringify({ contents: contentTable, stages: stageTable, enemies }));
console.log(`${Object.keys(enemies).length} enemies, ${pairs} enemy-in-stage entries`
  + ` over ${contentTable.length} contents and ${stageTable.length} stages`
  + ` -> ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
