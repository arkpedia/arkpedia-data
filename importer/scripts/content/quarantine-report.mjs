#!/usr/bin/env node
/**
 * The body of the daily 'Content quarantined' issue: the records data/quarantine.json holds
 * back and the refresh stages data/stage-report.json lists as failed, skipped or rolled back.
 *
 *   node scripts/content/quarantine-report.mjs <out-dir> [--now <iso>]
 *
 * Prints one word: `nodata` (no refresh stage ran and nothing is quarantined, so this run
 * cannot say anything -- a correction dispatched with refresh_upstream=false), `clear`
 * (stages ran, all of them to the end, and nothing is quarantined), or `alert`, in which
 * case <out-dir> gets body.md and comment.md for alert-issue.mjs. JOB_STATUS other than
 * `success` says the run published nothing, which the body then says too. Reads the
 * quarantine file by its documented format only: {"version":1,"entries":[{key, stage,
 * reason, action, sourceRef?, overdueAfterDays?, firstSeen}]} (scripts/lib/quarantine.mjs);
 * an entry's age is counted from firstSeen, and it is overdue after its overdueAfterDays,
 * or OVERDUE_DAYS when it names none.
 *
 * A stage's age comes from the entry the stage runner keeps for it (stage 'refresh', key
 * stage:<name>), so a stage failing for more than OVERDUE_DAYS is overdue like a record.
 *
 * Everything in a row comes from the game, the wiki or a stage's output, and GitHub renders
 * it: see cell() and code() for what it may not do there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { failureLine, HOLDER } from './run-stage.mjs';

export const OVERDUE_DAYS = 3;
const MAX_ROWS = 150;
// GitHub refuses an issue body over 65,536 characters; the rows stop well short of it.
export const MAX_BODY = 60_000;
const readIfPresent = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const day = value => Date.parse(`${value}T00:00:00Z`);
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/*
 * Untrusted text in a table cell. It must not open an HTML comment (that hides the rest of
 * the body, and one shaped like <!-- arkpedia-alert:... --> could pass for another alert's
 * marker), start raw HTML, a link or an image, ping anyone (@name, @org/team), make GitHub
 * cross-reference another issue (#12, owner/repo#12, GH-12 in any case), turn a bare address
 * into a link (https://..., www...., mailto:, someone@example.org), or split the row. A
 * zero-width space keeps the text as it reads while GitHub no longer links it: after every @
 * (a mention needs its name, an email address its domain, right after it) and after a #
 * before a name or number; between "GH" and the "-" of a GH-number; inside every "://" and
 * after every "mailto:" and "xmpp:"; and between "www" and its dot. Each goes in whatever
 * comes before or after it: GitHub finds a scheme by reading back over the letters before
 * "://", so "1https://..." and "_https://..." link; it links a "www." that follows "_", "*",
 * "~" or "(" as well as a space; and an email address's domain may begin with "_" (escaped to
 * "\_" above) or ".". A word boundary, or a lookahead for a name, misses them all.
 */
const flat = (text, limit) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
};
export const cell = (text, limit = 300) => flat(text, limit)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_[\]|]/g, match => `\\${match}`)
  .replace(/@/g, '@\u200b')
  .replace(/#(?=[\w-])/g, '#\u200b')
  .replace(/(gh)(?=-\d)/gi, '$1\u200b')
  .replace(/:\/\//g, ':\u200b//')
  .replace(/(mailto|xmpp):/gi, '$1:\u200b')
  .replace(/(www)\./gi, '$1\u200b.');
/** Untrusted text as inline code: nothing in it renders, mentions or links, so only a
 * backtick (which would end it), a row-splitting pipe and an alert marker need care. */
export const code = (text, limit = 120) => `\`${flat(text, limit).replace(/`/g, '\u2019').replace(/<!--/g, '<\u200b!--').replace(/\|/g, '\\|')}\``;
const link = url => /^https?:\/\/[^\s()<>`|[\]\\]+$/.test(url) && url.length <= 300 ? `[source](${url})` : code(url);

export function renderQuarantineReport({ quarantine, stageReport, now = new Date(), runUrl = '', published = true }) {
  const today = now.toISOString().slice(0, 10);
  const aged = entry => {
    const age = Math.max(0, Math.round((day(today) - day(entry.firstSeen)) / 86_400_000));
    const days = Number.isFinite(age) ? age : 0;
    return { ...entry, age: days, overdue: days > (entry.overdueAfterDays ?? OVERDUE_DAYS) };
  };
  const all = (quarantine?.entries ?? []).map(aged);
  const entries = all.filter(entry => entry.stage !== HOLDER)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.age - a.age || byCodeUnit(a.stage, b.stage) || byCodeUnit(a.key, b.key));
  const held = new Map(all.filter(entry => entry.stage === HOLDER).map(entry => [entry.key.replace(/^stage:/, ''), entry]));
  // The stages of this run that did not run to the end, dated by the runner's entry for each.
  // With no stage report (no refresh ran), the entries say what the last refresh left failing.
  const since = stage => held.get(stage) ?? aged({ firstSeen: today });
  const stages = stageReport
    ? (stageReport.stages ?? []).filter(stage => stage.status !== 'ok').map(stage => ({ ...stage, ...pick(since(stage.stage)) }))
    : [...held.values()].map(entry => ({ stage: entry.key.replace(/^stage:/, ''), status: 'last refresh', reason: entry.reason, ...pick(entry) }));
  if (!entries.length && !stages.length) return { state: stageReport ? 'clear' : 'nodata' };
  const overdue = entries.filter(entry => entry.overdue).length, overdueStages = stages.filter(stage => stage.overdue).length;
  // What counts as news: a record or stage that was not listed before, or one that just
  // became overdue. A day passing is not, so an unchanged issue gets no daily comment.
  const digest = createHash('sha256').update(JSON.stringify({
    entries: entries.map(entry => [entry.stage, entry.key, entry.action, entry.overdue]).sort(),
    stages: stages.map(stage => [stage.stage, stage.status, stage.overdue]).sort(),
  })).digest('hex').slice(0, 16);
  const lines = [`<!-- arkpedia-alert-digest:${digest} -->`,
    `Checked on ${today}${runUrl ? ` by ${runUrl}` : ''}. ${published ? 'The day\'s release went out without what is listed here' : 'This run published nothing (see the \'Content release failing\' issue); this is what it found'}, and every run retries it. A record held back, or a stage failing, for more than ${OVERDUE_DAYS} days (or the longer wait a slower source gets, such as a song's YouTube upload) is **overdue**: it will not fix itself, so correct the source record (a correction branch in arkpedia-data), the importer or the source it reads.`];
  let length = lines.join('\n').length;
  const push = line => { lines.push(line); length += line.length + 1; };
  const room = reserve => length < MAX_BODY - reserve;
  if (entries.length) {
    [
      '', `**Quarantined records: ${entries.length}${overdue ? ` (${overdue} overdue)` : ''}**`, '',
      '*omitted-new*: a new record left out · *kept-previous*: the last published version kept · *published-partial*: published without the piece named', '',
      '| | Record | Stage | Action | Since | Why |', '|---|---|---|---|---|---|',
    ].forEach(push);
    let shown = 0;
    for (const entry of entries.slice(0, MAX_ROWS)) {
      // The stage table below must fit too.
      if (!room(4_000 + stages.length * 450)) break;
      const why = cell(entry.reason) + (entry.sourceRef ? ` (${/^https?:\/\//.test(entry.sourceRef) ? link(entry.sourceRef) : code(entry.sourceRef)})` : '');
      push(`| ${entry.overdue ? '**overdue**' : ''} | ${code(entry.key)} | ${cell(entry.stage, 40)} | ${cell(entry.action, 40)} | ${cell(entry.firstSeen, 10)} (${entry.age} d) | ${why} |`);
      shown++;
    }
    if (entries.length > shown) push(`\n…and ${entries.length - shown} more in \`source/data/quarantine.json\` of arkpedia-data.`);
  }
  if (stages.length) {
    [
      '', `**Refresh stages that did not run to the end: ${stages.length}${overdueStages ? ` (${overdueStages} overdue)` : ''}**`, '',
      stageReport ? 'A failed stage had its changes put back, so its records stay as last published; a stage that ran on what a failed stage had to finish was rolled back with it.'
        : 'No refresh stage ran in this run; this is what the last refresh left failing.', '',
      '| | Stage | Status | Since | Detail |', '|---|---|---|---|---|',
    ].forEach(push);
    let shown = 0;
    for (const stage of stages) {
      if (!room(200)) break;
      const detail = stage.status === 'failed' ? `${stage.exit}: ${failureLine(stage.error)}` : stage.reason;
      push(`| ${stage.overdue ? '**overdue**' : ''} | ${code(stage.stage, 60)}${stage.invariant ? ' (invariant)' : ''} | ${cell(stage.status, 20)} | ${cell(stage.firstSeen, 10)} (${stage.age} d) | ${cell(detail)} |`);
      shown++;
    }
    if (stages.length > shown) push(`\n…and ${stages.length - shown} more in the run's summary.`);
  }
  const comment = `${entries.length} record(s) quarantined${overdue ? `, ${overdue} overdue` : ''}; ${stages.length} refresh stage(s) did not run to the end${overdueStages ? `, ${overdueStages} failing for more than ${OVERDUE_DAYS} days` : ''}. The issue body lists them${runUrl ? ` (${runUrl})` : ''}.`;
  return { state: 'alert', body: `${lines.join('\n')}\n`, comment, digest };
}
const pick = ({ firstSeen, age, overdue }) => ({ firstSeen, age, overdue });

function main(argv) {
  let out = null, now = new Date();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--now') now = new Date(argv[++i]);
    else out = argv[i];
  }
  if (!out || Number.isNaN(now.getTime())) throw new Error('usage: quarantine-report.mjs <out-dir> [--now <iso>]');
  const report = renderQuarantineReport({
    quarantine: readIfPresent('data/quarantine.json'), stageReport: readIfPresent('data/stage-report.json'),
    now, runUrl: process.env.RUN_URL ?? '',
    // The step runs after a failed publish too; the job's status says whether one went out.
    published: (process.env.JOB_STATUS ?? 'success') === 'success',
  });
  if (report.state === 'alert') {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'body.md'), report.body);
    fs.writeFileSync(path.join(out, 'comment.md'), `${report.comment}\n`);
  }
  console.log(report.state);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
