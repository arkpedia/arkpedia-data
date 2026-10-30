/**
 * data/rerun-clear-medals.json: for each event medal set, the medal that marks the event's
 * stages cleared, keyed by the set's activity suffix ("42side"), out of the published medal
 * catalogue (public/medal-catalogue.json, EN).
 *
 * A rerun pays its Originite no second time to an account that cleared the event, but an
 * import cannot see those clears: the game's save keeps stage records only for stages still
 * in the client, and a closed event's are gone until Record Restoration lists it again (the
 * owner's import, 2026-10-28: 2,391 clears and none of four cleared events). The event's
 * medals stay, and every recent event set has one for completing all its stages with three
 * stars ("'Lateran Newborn': Complete all stages in [A Glance at the Shrine] with 3-star
 * ratings"). lib/pulls/rerunClearMedals.ts reads this file; test-rerun-clear-medals.ts holds
 * it to the catalogue.
 */
import fs from 'node:fs';

export const ALL_STAGES_THREE_STARS = /^Complete all (?:the )?stages in \[[^\]]+\] with 3-star ratings/i;

export function buildRerunClearMedals(catalogue) {
  const byId = new Map(catalogue.medals.map(medal => [medal.id, medal]));
  const out = {};
  for (const set of catalogue.sets) {
    if (set.type !== 'activityMedal') continue;
    const suffix = set.id.match(/^medalGroupActivity(.+)$/)?.[1];
    if (!suffix) continue;
    const medal = set.medals.map(id => byId.get(id)).find(medal => medal && ALL_STAGES_THREE_STARS.test(medal.requirement ?? ''));
    if (medal) out[suffix] = medal.id;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && new URL(import.meta.url).pathname === fs.realpathSync(process.argv[1])) {
  const catalogue = JSON.parse(fs.readFileSync('public/medal-catalogue.json', 'utf8'));
  const medals = buildRerunClearMedals(catalogue);
  fs.writeFileSync('data/rerun-clear-medals.json', `${JSON.stringify(medals, null, 2)}\n`);
  console.log(`Rerun clear medals: ${Object.keys(medals).length} event sets.`);
}
