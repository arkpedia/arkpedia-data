/*
 * An event's name as the records spell it ("[Side Story] People, A People", "[Rerun] Invitation to
 * Wine Rerun") and the two things read out of it. No fs and no data import, so the browser takes it
 * too (the event page's reward card names its picture with it; lib/events/eventCg.ts, server only,
 * finds a CG folder by it), and plain JavaScript so the Node pipeline scripts can import it as they
 * are, as they import lib/farming/materialCatalogue.mjs. The scripts that still keep their own copy
 * of these rules (scripts/build/build-event-rewards.mjs, scripts/sync/sync-event-stores.mjs) can
 * read this one instead; test-event-extras.ts loads it in a bare `node` so it stays loadable there.
 * eventName.d.mts types it for the app.
 *
 * A name that is not a string (a record missing it, read by a script with no type checker) is read
 * as the empty string, as the scripts' copies read it.
 */

/** "[Side Story] People, A People" → "People, A People": the name without its leading "[Tag] ",
 *  the shorter title a CG folder, a saved picture or a note names the event by. */
export function eventTitle(name) {
  return String(name ?? '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
}

/** A rerun, by either of the marks the records give one: the "[Rerun]" tag or the " Rerun" suffix.
 *  Every rerun on the calendar carries both today; asking for either means a record that drops
 *  one is still read as what it is, as the pipeline reads it. */
export function isRerun(name) {
  const text = String(name ?? '');
  return /^\s*\[Rerun\]/.test(text) || /\sRerun$/.test(text);
}
