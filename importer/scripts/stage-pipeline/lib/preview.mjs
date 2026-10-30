// Which in-game render belongs to a stage.
//
// One render exists per LAYOUT, not per stage: a #f# variant is the same map
// under a different clear condition and a Challenge Mode row points back at its
// parent's layout, so every member of a layout group shows the same picture --
// which is what the game does with them too.
//
// Render availability combines the pinned public asset index with any local
// previews generated during import: a stage gets a preview only when the render
// its layout is named after is published. A render that is not published yet is
// fetched by scripts/imports/import-stage-renders.mjs from the CN mirror's map/
// (the same groups and names as here), published by the release's staged-art
// stage and adopted in the same run; see docs/development/data-pipelines.md.
import fs from 'node:fs';
import path from 'node:path';
import { SlugSet, slug, stageSlug } from './names.mjs';

/**
 * {canonical stage id: [every stage id sharing that layout]}. The canonical id --
 * the one that names the file -- is chosen from gamedata alone (normal difficulty
 * first, then by id) and never from which id happens to have a render, so an
 * image appearing upstream cannot rename a file.
 */
export function groupStagesByLevel(stages) {
  const groups = new Map();
  for (const [stageId, stage] of Object.entries(stages)) {
    // Story-only stages carry no levelId; each is its own group. Casing is
    // inconsistent upstream (Obt/Main vs Activities/ACT10d5).
    const level = (stage.levelId || '').toLowerCase() || `\0${stageId}`;
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(stageId);
  }
  const out = new Map();
  for (const members of groups.values()) {
    members.sort((a, b) => Number(stages[a].difficulty !== 'NORMAL') - Number(stages[b].difficulty !== 'NORMAL')
      || (a < b ? -1 : a > b ? 1 : 0));
    out.set(members[0], members);
  }
  return out;
}

/**
 * canonical stage id -> render file stem.
 *
 * SlugSet decides WHETHER a code needs disambiguating; stageSlug decides how it
 * is spelled. Note the suffix here is the RAW gamedata id, not the slugged one --
 * this is a different scheme from the stage-record slugs, which is why
 * 4-3_challenge_mode.json points at a render called 4-3.png while 14-2.json
 * points at 14-2_main_14-01.png.
 */
export function assignStageSlugs(stageIds, stages) {
  const codes = new Map(stageIds.map((sid) => [sid, stages[sid].code || '']));
  const slugger = new SlugSet(slug);
  for (const sid of [...stageIds].sort()) slugger.add(sid, codes.get(sid));
  const disambiguated = slugger.resolve();
  const out = new Map();
  for (const sid of stageIds) {
    const base = stageSlug(codes.get(sid));
    // SlugSet suffixed it => the code is shared with another stage.
    out.set(sid, disambiguated.get(sid) === slug(codes.get(sid)) ? base : `${base}_${sid}`);
  }
  return out;
}

/** stage id -> the manifest-style preview path, for every stage that has a render. */
export function stagePreviews(stages, imagesDir, publishedFiles = []) {
  const groups = groupStagesByLevel(stages);
  const canonical = [...groups.keys()];
  const slugOf = assignStageSlugs(canonical, stages);
  const have = new Set(publishedFiles.map(file => file.replace(/\.[a-z]+$/i, '')));
  if (fs.existsSync(imagesDir)) {
    for (const f of fs.readdirSync(imagesDir)) have.add(f.replace(/\.[a-z]+$/i, ''));
  }
  const out = new Map();
  for (const [id, members] of groups) {
    const stem = slugOf.get(id);
    if (!have.has(stem)) continue;
    // Every member of the group points at the one render of their shared map.
    for (const member of members) out.set(member, `images/stages/${stem}.png`);
  }
  return out;
}

export const defaultImagesDir = (root) => path.join(root, 'public/stages-images');
