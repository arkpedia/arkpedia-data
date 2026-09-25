#!/usr/bin/env node
/**
 * A copy of scripts/content/alert-issue.mjs in the private application repository (tested
 * there, in scripts/tests/test-content-alerts.ts), so this repository's watchdog
 * (release-heartbeat.mjs) opens and closes its issues the same way. Change both together.
 *
 * Keeps ONE GitHub issue open per alert while it holds, and closes it when it clears.
 *
 *   node scripts/alert-issue.mjs open  --alert <id> --title <title> --body-file <file>
 *                                              [--comment-file <file>] [--rewrite] [--now <iso>]
 *   node scripts/alert-issue.mjs close --alert <id> --title <title> --comment <text>
 *
 * The issue is found by a hidden marker on the first line of its body,
 * <!-- arkpedia-alert:<id> -->, never by its title, and never by a marker further down: the
 * bodies quote wiki and game text, which could carry one. Any marker-shaped comment in a
 * body or comment this script is given is defused before it is posted, and both are cut to
 * what GitHub accepts. An open issue with exactly the given title and no marker at all,
 * opened before markers existed, is adopted instead of opening a second one.
 *
 * `open` creates the issue, or else comments on it, at most once per UTC day: each comment
 * carries <!-- arkpedia-alert:<id>:<YYYY-MM-DD> --> and a day that has one gets no other.
 * With --rewrite the body is replaced by the current state on every run, and the day's
 * comment is posted only when that state changed. A body can name its state in a
 * <!-- arkpedia-alert-digest:... --> line, so a count of days that grows by itself is not
 * a change. Needs GITHUB_REPOSITORY and a gh that GH_TOKEN authenticates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const marker = alert => `<!-- arkpedia-alert:${alert} -->`;
const dayMarker = (alert, day) => `<!-- arkpedia-alert:${alert}:${day} -->`;
const digestOf = body => body.match(/<!-- arkpedia-alert-digest:([^ ]+) -->/)?.[1] ?? body.replace(/<!-- arkpedia-alert:[^>]*-->\n?/g, '').trim();
/** Whether an issue body is this alert's: its first line is the marker. */
const isFor = (body, alert) => (body ?? '').split(/\r?\n/, 1)[0].trim() === marker(alert);
// GitHub refuses a body or comment over 65,536 characters.
const MAX_TEXT = 65_000;
/** A text as posted: no marker of any alert in it but the ones this script adds, and short
 * enough for GitHub to take. */
export function defuse(text) {
  const safe = String(text).replace(/<!--(\s*arkpedia-alert:)/g, '&lt;!--$1');
  return safe.length > MAX_TEXT ? `${safe.slice(0, MAX_TEXT - 60)}\n\n…cut here: the text was longer than GitHub accepts.\n` : safe;
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
}
/** gh takes long texts from a file, not an argument. */
function withFile(text, use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-alert-'));
  try {
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, text);
    return use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function findIssue(repo, alert, title) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,body']));
  return issues.find(issue => isFor(issue.body, alert))
    ?? issues.find(issue => issue.title === title && !/<!-- arkpedia-alert:/.test(issue.body ?? ''))
    ?? null;
}

export function openAlert({ repo, alert, title, body, comment = body, rewrite = false, now = new Date() }) {
  const day = now.toISOString().slice(0, 10);
  const text = `${marker(alert)}\n${defuse(body.trim())}\n`;
  const issue = findIssue(repo, alert, title);
  if (!issue) {
    withFile(text, file => gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', file]));
    return 'created';
  }
  const changed = digestOf(issue.body ?? '') !== digestOf(text);
  // An edit notifies nobody, so the body keeps its ages and dates current every run.
  const edited = rewrite && (issue.body ?? '') !== text;
  if (edited) withFile(text, file => gh(['issue', 'edit', String(issue.number), '--repo', repo, '--body-file', file]));
  if (rewrite && !changed) return edited ? 'rewritten' : 'unchanged';
  const { comments } = JSON.parse(gh(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'comments']));
  if (comments.some(entry => (entry.body ?? '').includes(dayMarker(alert, day)))) return 'already-commented';
  withFile(`${dayMarker(alert, day)}\n${defuse(comment.trim())}\n`, file => gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body-file', file]));
  return 'commented';
}

export function closeAlert({ repo, alert, title, comment }) {
  const issue = findIssue(repo, alert, title);
  if (!issue) return 'none';
  gh(['issue', 'close', String(issue.number), '--repo', repo, '--comment', defuse(comment)]);
  return 'closed';
}

function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (name === 'rewrite') parsed.rewrite = true;
    else if (args[i].startsWith('--') && args[i + 1] !== undefined) parsed[name] = args[++i];
    else throw new Error(`Unexpected argument: ${args[i]}`);
  }
  return parsed;
}
function main([action, ...args]) {
  const repo = process.env.GITHUB_REPOSITORY;
  const opts = options(args);
  if (!repo || !opts.alert || !opts.title) throw new Error('Needs GITHUB_REPOSITORY, --alert and --title');
  if (action === 'open') {
    const read = file => fs.readFileSync(file, 'utf8');
    return openAlert({ repo, alert: opts.alert, title: opts.title, body: read(opts['body-file']),
      comment: opts['comment-file'] ? read(opts['comment-file']) : undefined, rewrite: opts.rewrite,
      now: opts.now ? new Date(opts.now) : new Date() });
  }
  if (action === 'close') return closeAlert({ repo, alert: opts.alert, title: opts.title, comment: opts.comment ?? 'Resolved.' });
  throw new Error('usage: alert-issue.mjs open|close --alert <id> --title <title> ...');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`${main(process.argv.slice(2))}`);
