#!/usr/bin/env node
/**
 * data/quarantine.json: the records a refresh stage left out, kept at their previous
 * version or published without a missing piece, instead of failing the day's release
 * over one bad input. It is a data file like any other -- hydrated from and published
 * to arkpedia-data -- so the list, and how long each entry has been on it, survives
 * runner resets.
 *
 *   {"version":1,"entries":[{"key":"banner:SINGLE_77_0_1","stage":"catalogue",
 *     "reason":"...","action":"omitted-new","sourceRef":"...","firstSeen":"2026-09-23"}]}
 *
 * An entry may also carry overdueAfterDays: how long it may wait before the daily issue
 * calls it overdue, for an entry that clears by itself on a slower clock than the usual
 * three days (a song's YouTube upload comes weeks after the song).
 *
 * Each stage owns its entries. A stage that runs to completion replaces every entry
 * under its name with the ones it reported this run, so a record that recovered drops
 * off by itself; a key reported again keeps its firstSeen. A stage that did not run
 * (it failed, or was skipped) leaves its entries as they were. Dates are UTC days. A
 * stage with nothing to report in a tree with no file (a refresh run by hand) does not
 * start one: the file belongs to arkpedia-data.
 *
 * Nothing in an entry changes by itself: only a new reason, action or sourceRef changes
 * it, so a day that holds the same records rewrites the file to the same bytes. The file
 * is one of the release's inputs (scripts/content/export.mjs hashes data/), and the
 * lastSeen date entries carried until 2026-09 -- the last day a key was reported --
 * made every day with anything held a new release. How long an entry has been held is
 * today minus firstSeen. lastSeen is dropped from every entry the file is written with.
 * For the same reason a reason names no date and no count that grows by itself, and a
 * sourceRef that differs from the one on record only in the mirror commit it is pinned
 * to (a raw URL at the run's pin, which moves whenever the mirror commits) is the same
 * source: the entry keeps the permalink it was first reported with.
 *
 * A reason names the kind of failure, never the error's own text (the log gets that) nor a
 * commit: add() refuses one that carries either (VOLATILE below), which fails the stage
 * loudly, as any malformed entry does, instead of making a new release every night. On
 * 2026-09-26 the palettes stage wrote "(UnidentifiedImageError: cannot identify image file
 * <_io.BytesIO object at 0x108905580>)", another address each run, and a download's URL at
 * the skin pin. data/quarantine.json's other writer, the completeness stage
 * (scripts/content/check-completeness.mjs), builds its reasons from the records alone.
 *
 * Importers in other languages go through the command line, so there is one writer:
 *   node scripts/lib/quarantine.mjs <stage> [entries.json]    (entries: a JSON list, or stdin)
 * ARKPEDIA_NOW (an ISO date) stands in for the clock, for tests of any importer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUARANTINE_FILE = 'data/quarantine.json';
export const ACTIONS = ['omitted-new', 'kept-previous', 'published-partial'];

/** The run's clock: ARKPEDIA_NOW when a test sets it, else the real time. */
export const defaultNow = () => (process.env.ARKPEDIA_NOW ? new Date(process.env.ARKPEDIA_NOW) : new Date());
const utcDay = now => {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid quarantine clock: ${now}`);
  return date.toISOString().slice(0, 10);
};
// A file written before 2026-09 still carries it; see the header.
const withoutLastSeen = ({ lastSeen: _, ...entry }) => entry;
// Text in a reason that changes by itself: a commit (a URL at a pin, which moves whenever the
// repository commits), an object's address (PIL names the buffer it read), and the words of a
// failed request, which differ from one day of an outage to the next. Not "timed out": the
// refresh's own entries say "failed or timed out", the same every day.
const VOLATILE = /\b[0-9a-f]{40}\b|\b0x[0-9a-f]{6,}\b|\bErrno\b|urlopen error|HTTP Error \d|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|Traceback/;
/** The first text in `reason` that would change by itself, or null. */
export const volatileText = reason => String(reason).match(VOLATILE)?.[0] ?? null;
// A 40-hex commit is where a mirror URL pins its file; without it, two refs name one source.
const unpinned = ref => ref.replace(/\b[0-9a-f]{40}\b/g, '<commit>');
const sameSource = (before, ref) => (before && ref && unpinned(before) === unpinned(ref) ? before : ref);
// Code-point order, so the file sorts the same on every machine.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function readQuarantine(root) {
  const file = path.join(root, QUARANTINE_FILE);
  // Absent until the first stage reports: hydration removes any data file the data
  // repository does not have yet.
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error(`${QUARANTINE_FILE} is not a version 1 quarantine list`);
  return value;
}

/** Collects one stage's entries for this run; nothing is written until commit(). */
export function beginStage(root, stage, now = defaultNow()) {
  if (typeof stage !== 'string' || !stage.trim()) throw new Error('A quarantine stage needs a name');
  const today = utcDay(now);
  const reported = new Map();
  return {
    stage,
    get entries() { return [...reported.values()]; },
    add({ key, reason, action, sourceRef, overdueAfterDays } = {}) {
      // A malformed entry is a bug in the importer, not bad input: fail loudly.
      if (typeof key !== 'string' || !key.trim()) throw new Error(`Quarantine entry in ${stage} has no key`);
      if (typeof reason !== 'string' || !reason.trim()) throw new Error(`Quarantine entry ${key} has no reason`);
      if (!ACTIONS.includes(action)) throw new Error(`Quarantine entry ${key} has action ${action}; expected one of ${ACTIONS.join(', ')}`);
      const volatile = volatileText(reason);
      if (volatile) {
        throw new Error(`Quarantine entry ${key} in ${stage} carries "${volatile}" in its reason, which changes by itself and would make every run a new release; `
          + `name the kind of failure there and print the error to the log: ${reason}`);
      }
      // The file is a released record, and arknights.wiki.gg is only ever a citation in one
      // (test-data-records.ts): its address goes in sourceRef, and a reason names it "the EN
      // wiki". On 2026-10-15 a reward icon's reason named the host and failed the whole release;
      // refused here, it fails the one stage, which is put back while the release goes on.
      if (/wiki\.gg/i.test(reason)) {
        throw new Error(`Quarantine entry ${key} in ${stage} names wiki.gg in its reason; put the address in sourceRef and call it "the EN wiki" there: ${reason}`);
      }
      if (sourceRef != null && typeof sourceRef !== 'string') throw new Error(`Quarantine entry ${key} has a non-string sourceRef`);
      if (overdueAfterDays != null && !(Number.isInteger(overdueAfterDays) && overdueAfterDays > 0)) throw new Error(`Quarantine entry ${key} has overdueAfterDays ${overdueAfterDays}; expected a whole number of days`);
      // One entry per key: the first report of a run stands.
      if (!reported.has(key)) reported.set(key, { key, reason: reason.trim(), action, ...(sourceRef ? { sourceRef } : {}), ...(overdueAfterDays ? { overdueAfterDays } : {}) });
    },
    /** Replaces this stage's entries in the file; returns the stage's entries as written. */
    commit() {
      const current = readQuarantine(root);
      const previous = new Map(current.entries.filter(entry => entry.stage === stage).map(entry => [entry.key, entry]));
      const mine = [...reported.values()].map(({ key, reason, action, sourceRef, overdueAfterDays }) => {
        const ref = sameSource(previous.get(key)?.sourceRef, sourceRef);
        return { key, stage, reason, action, ...(ref ? { sourceRef: ref } : {}), ...(overdueAfterDays ? { overdueAfterDays } : {}), firstSeen: previous.get(key)?.firstSeen ?? today };
      });
      const entries = [...current.entries.filter(entry => entry.stage !== stage).map(withoutLastSeen), ...mine]
        .sort((a, b) => byCodePoint(a.stage, b.stage) || byCodePoint(a.key, b.key));
      const file = path.join(root, QUARANTINE_FILE);
      if (!entries.length && !fs.existsSync(file)) return mine;
      const text = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      return mine;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [stage, input] = process.argv.slice(2);
  const entries = JSON.parse(fs.readFileSync(input ?? 0, 'utf8') || '[]');
  if (!Array.isArray(entries)) throw new Error('Quarantine entries must be a JSON list');
  const handle = beginStage(process.cwd(), stage);
  for (const entry of entries) handle.add(entry);
  const written = handle.commit();
  console.log(written.length ? `${written.length} record(s) quarantined by ${stage}:\n${written.map(e => `  ! ${e.key} (${e.action}, since ${e.firstSeen}): ${e.reason}`).join('\n')}` : `Nothing quarantined by ${stage}.`);
}
