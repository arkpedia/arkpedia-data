#!/usr/bin/env node
/**
 * The content pipeline's external heartbeat: an alarm that needs nothing from the private
 * application repository to run.
 *
 *   node scripts/release-heartbeat.mjs [--dry-run]
 *
 * Every alert of the daily release job lives in the job itself, so a job that never starts
 * reports nothing: on 2026-09-25 GitHub refused every private job for the month's Actions
 * budget and no issue opened. This runs here, on this public repository's free runners, and
 * reads three branches of this repository through the GitHub API (GETs only):
 *
 *   live        live/current.json, which the site reads: when it last moved, and to what.
 *   heartbeat   one commit per successful release job, written by the job even on a day with
 *               nothing new to publish, so a quiet day is not taken for an outage.
 *   main        the release the job last pushed.
 *
 * Two alerts, each one issue here (scripts/alert-issue.mjs), closed when it clears:
 *
 *   release-stale      neither live nor the heartbeat moved for RELEASE_HEARTBEAT_HOURS (26):
 *                      the job failed, was held, was disabled or never started for over a day.
 *   release-not-live   data main is not what live serves, an hour after it was committed: the
 *                      Content release workflow here refused or never ran for it, and readers
 *                      keep the older release.
 *
 * The job's schedule is 19:57 UTC but GitHub starts it 2-4 hours late, and a late day followed
 * by an early one can put two runs 26 hours apart; RELEASE_HEARTBEAT_HOURS is the knob.
 */
import { pathToFileURL } from 'node:url';
import { closeAlert, openAlert } from './alert-issue.mjs';

export const STALE = { alert: 'release-stale', title: 'No content release for over a day' };
export const NOT_LIVE = { alert: 'release-not-live', title: 'Data main is not live' };
const HOUR = 3_600_000;
const stamp = date => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
const age = (now, date) => `${((now - Date.parse(date)) / HOUR).toFixed(1)} h ago`;

/**
 * What is wrong now, from what the branches say.
 *   live       { date, revision } | null   the live branch's last commit, and the revision it names
 *   heartbeat  { date } | null             the heartbeat branch's last commit
 *   main       { sha, date } | null        data main's last commit
 * Returns { stale, notLive }: an issue body for each alert that holds, else null.
 */
export function assess({ now, live, heartbeat, main, staleHours = 26, graceMinutes = 60 }) {
  const signs = [live?.date, heartbeat?.date].filter(Boolean).map(date => Date.parse(date));
  const last = signs.length ? Math.max(...signs) : Number.NaN;
  // NaN (no live branch, no heartbeat) compares false: stale.
  const stale = !(now - last <= staleHours * HOUR);
  const notLive = Boolean(main?.sha) && live?.revision !== main.sha && now - Date.parse(main.date) > graceMinutes * 60_000;
  return {
    stale: stale ? [
      `Neither a content release nor a heartbeat of the release job is newer than ${staleHours} hours (checked ${stamp(now)}).`,
      '',
      `- Last release: ${live ? `live/current.json moved to \`${live.revision}\` at ${stamp(live.date)} (${age(now, live.date)}).` : 'the live branch cannot be read.'}`,
      `- Last heartbeat: ${heartbeat ? `${stamp(heartbeat.date)} (${age(now, heartbeat.date)}).` : 'none on the heartbeat branch yet.'}`,
      '',
      'The daily **Prepare content release** job of the application repository leaves a heartbeat after every successful run, even one with nothing new to publish. So it has not finished successfully for over a day: it failed, it was held while production ran other code (a "Content release held" issue in the application repository says why), it was disabled, or it never started (its self-hosted runner offline, or GitHub refusing jobs over the Actions budget). Readers keep the last release meanwhile.',
      '',
      'This closes by itself after the next release or heartbeat.',
      '',
    ].join('\n') : null,
    notLive: notLive ? [
      `Data main is at \`${main.sha}\` (committed ${stamp(main.date)}, ${age(now, main.date)}), but live/current.json ${live ? `serves \`${live.revision}\`` : 'cannot be read'}.`,
      '',
      'The **Content release** workflow here validates every push to main and only then moves the live pointer, so its run for that commit failed or never ran: https://github.com/arkpedia/arkpedia-data/actions/workflows/content.yml. Readers keep the release live names. A source-only change merged into main fails there by design; publish it through a dispatched Prepare content release instead.',
      '',
      'If live was rolled back to an older commit on purpose, this stays open until main is published again.',
      '',
    ].join('\n') : null,
  };
}

async function get(pathname, { token, fetch, raw = false }) {
  const headers = { accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${pathname}: HTTP ${response.status}`);
  return raw ? response.text() : response.json();
}

/** The three branches, as assess() reads them. A branch that does not exist is null. */
export async function observe({ repo, token, fetch = globalThis.fetch }) {
  // /branches answers 404 for a branch that does not exist (/commits/<name> answers 422).
  const commit = async branch => (await get(`/repos/${repo}/branches/${branch}`, { token, fetch }))?.commit ?? null;
  const [liveCommit, beat, mainCommit] = await Promise.all([commit('live'), commit('heartbeat'), commit('main')]);
  let live = null;
  if (liveCommit) {
    const pointer = JSON.parse(await get(`/repos/${repo}/contents/current.json?ref=${liveCommit.sha}`, { token, fetch, raw: true }) ?? '{}');
    live = { date: liveCommit.commit.committer.date, revision: pointer.revision ?? null };
  }
  return {
    live,
    heartbeat: beat ? { date: beat.commit.committer.date } : null,
    main: mainCommit ? { sha: mainCommit.sha, date: mainCommit.commit.committer.date } : null,
  };
}

async function main(argv) {
  const repo = process.env.GITHUB_REPOSITORY || 'arkpedia/arkpedia-data';
  const staleHours = Number(process.env.RELEASE_HEARTBEAT_HOURS || 26);
  if (!(staleHours > 0)) throw new Error(`RELEASE_HEARTBEAT_HOURS must be a positive number of hours, not ${process.env.RELEASE_HEARTBEAT_HOURS}`);
  const seen = await observe({ repo, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  const now = Date.now();
  const verdict = assess({ now, ...seen, staleHours });
  console.log(JSON.stringify({ checked: stamp(now), ...seen, stale: Boolean(verdict.stale), notLive: Boolean(verdict.notLive) }));
  const latest = [seen.live?.date, seen.heartbeat?.date].filter(Boolean).sort().at(-1);
  const plan = [
    [STALE, verdict.stale, `A release or heartbeat is newer than ${staleHours} hours again (latest ${latest ? stamp(latest) : 'unknown'}).`],
    [NOT_LIVE, verdict.notLive, `Live serves data main again (\`${seen.main?.sha}\`).`],
  ];
  for (const [{ alert, title }, body, cleared] of plan) {
    if (argv.includes('--dry-run')) { console.log(`${alert}: would ${body ? 'open' : 'close'}${body ? `\n${body}` : ''}`); continue; }
    if (body) console.log(`${alert}: ${openAlert({ repo, alert, title, body })}`);
    else console.log(`${alert}: ${closeAlert({ repo, alert, title, comment: cleared })}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
