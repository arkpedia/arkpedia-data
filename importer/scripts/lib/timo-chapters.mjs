/**
 * Each chapter's sections as Timo's story reader lists them, from its catalogue's data alone
 * (https://arknights.timo.beer/json/catalog.en.json), so a link can open one section: the reader
 * addresses a section by its place in the chapter's list ("story.html#main&main_3&4"), and that
 * list is not the game's story_review_table as it stands. The reader builds it in four steps
 * (its js/catalog.js: buildCatalog, addScenes, entries), and this does the same, as data:
 *
 *   1. the table's own rows for the group (catalog `review`);
 *   2. the group's extra unlockable stories (reviewMeta.actArchiveData components), by avgSortId;
 *   3. the opening video's script first, where the catalogue lists it (storyKeys): "<id>_zone_enter"
 *      for a main chapter, "level_<id>_entry" for an event, beside the first row's script;
 *   4. bonus reading (catalog `annex`, `files`, `companions`) appended with the orders the reader
 *      sorts by: a recap leads (-1), the rest follow (9000, 9500, 10000 and up);
 *   5. the battle scenes (catalog `scenes`), each after the row it follows, else before the row it
 *      precedes, else last, and then a chapter with any is numbered by its rows' places;
 *   6. a stable sort by that order.
 *
 * The sandbox and roguelike groups are built another way altogether; they are not chapters of
 * this kind, and timoEntries answers null for any group the catalogue's `review` lacks.
 *
 * Only the data is read: the reader's own code never runs here. scripts/tests/test-story-chapters.ts
 * holds the steps; checked against the reader's own lists for every chapter on the map when written.
 */

/** The rows of one group, in the reader's order, each with its index there. */
export function timoEntries(catalog, groupId) {
  const group = catalog.review?.[groupId];
  if (!group || !Array.isArray(group.infoUnlockDatas)) return null;
  const list = group.infoUnlockDatas.map((row) => ({ ...row }));
  const components = catalog.reviewMeta?.actArchiveData?.components?.[groupId];
  if (components) {
    const avgs = catalog.reviewMeta?.actArchiveResData?.avgs ?? {};
    Object.values(components.avg?.avgs ?? {})
      .sort((a, b) => (a?.avgSortId || 0) - (b?.avgSortId || 0))
      .forEach((avg) => {
        const res = avgs[avg?.avgId];
        list.push({ storyGroup: groupId, storyTxt: res?.contentPath, storyCode: res?.desc, storyName: res?.desc, avgTag: '' });
      });
  }
  const keys = new Set(catalog.storyKeys ?? []);
  const first = list[0];
  if (first?.storyTxt) {
    const stem = groupId.startsWith('main_') ? `${groupId}_zone_enter` : `level_${groupId}_entry`;
    const intro = first.storyTxt.replace(/[^/]+$/, stem);
    if (keys.has(intro)) list.unshift({ storyGroup: groupId, storyTxt: intro, storyCode: '', storyName: '', avgTag: '', intro: true });
  }
  // Bonus reading appended after (buildAnnex, buildFiles, buildCompanions), each with an order the
  // reader sorts by: a recap leads its chapter, the rest follow.
  (catalog.annex?.[groupId] ?? []).forEach((row, at) => list.push({ storyTxt: row.txt, storyName: '', storyCode: '', avgTag: '', bonus: row.kind, order: row.first ? -1 : 9000 + at }));
  (catalog.files?.[groupId] ?? []).forEach((row, at) => list.push({ storyTxt: row.txt, storyName: row.name ?? '', storyCode: '', avgTag: '', bonus: 'file', order: 9500 + at }));
  Object.values(catalog.companions ?? {}).filter((act) => act?.of === groupId).forEach((act) => (act.scripts ?? []).forEach((row, at) =>
    list.push({ storyTxt: row.txt, storyName: `${row.who ?? ''} ${row.n ?? ''}`.trim(), storyCode: '', avgTag: '', bonus: 'companion', order: 10000 + at })));
  // The battle scenes, and then every row of a chapter that has any is numbered by its place, the
  // bonus rows' orders included, as the reader's addScenes does.
  const scenes = (catalog.scenes?.rows?.[groupId] ?? []).filter((row) => row?.parts?.length);
  for (const row of scenes) {
    const entry = { storyTxt: row.parts[0], storyCode: row.code || '', storyName: row.name || '', avgTag: '', scene: row.scene };
    let at = list.findIndex((e) => e.storyTxt === row.after);
    if (at >= 0) at += 1;
    else at = list.findIndex((e) => e.storyTxt === row.before);
    if (at < 0) at = list.length;
    list.splice(at, 0, entry);
  }
  if (scenes.length) list.forEach((row, i) => { row.order = i; });
  // entries(): a row without an order is ordered by its place, then all by order (a stable sort).
  list.forEach((row, i) => { if (!Number.isFinite(row.order)) row.order = i; });
  list.sort((a, b) => a.order - b.order);
  return list.map((row, index) => ({ ...row, index }));
}

const TAGS = { 'Before Operation': 'before', 'After Operation': 'after' };

/** One chapter for the Story page: each section [index, code, name, tag], the reader's battle
 *  scenes left out (the reader still counts them, and the indices are its own). tag: before,
 *  after, intro, or '' for a story of its own (an interlude, a prologue part). */
export function chapterSections(entries) {
  return entries.filter((row) => !row.scene).map((row) => [row.index, row.storyCode || '', row.intro ? 'Intro' : (row.storyName || row.storyCode || ''), row.intro ? 'intro' : (TAGS[row.avgTag] ?? '')]);
}
