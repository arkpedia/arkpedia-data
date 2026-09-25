// node --test scripts/release-heartbeat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, observe } from './release-heartbeat.mjs';

const at = iso => Date.parse(iso);
const main = { sha: 'a'.repeat(40), date: '2026-09-24T22:44:00Z' };
const live = { date: '2026-09-24T22:52:00Z', revision: main.sha };

test('a release within the window is healthy', () => {
  assert.deepEqual(assess({ now: at('2026-09-25T20:00:00Z'), live, heartbeat: null, main }), { stale: null, notLive: null });
});

test('the release job stopped for over 26 hours: stale, whatever stopped it', () => {
  // The last release, then nothing: no release and no heartbeat for 26 h 8 min.
  const { stale, notLive } = assess({ now: at('2026-09-26T01:00:00Z'), live, heartbeat: { date: '2026-09-24T22:53:00Z' }, main });
  assert.equal(notLive, null);
  assert.match(stale, /^Neither a content release nor a heartbeat of the release job is newer than 26 hours \(checked 2026-09-26T01:00:00Z\)\./);
  assert.match(stale, /- Last release: live\/current\.json moved to `a{40}` at 2026-09-24T22:52:00Z \(26\.1 h ago\)\./);
  assert.match(stale, /- Last heartbeat: 2026-09-24T22:53:00Z \(26\.1 h ago\)\./);
  assert.match(stale, /never started \(its self-hosted runner offline, or GitHub refusing jobs over the Actions budget\)/);
  // Exactly at the threshold is still healthy; the knob moves it.
  assert.equal(assess({ now: at('2026-09-26T00:52:00Z'), live, heartbeat: null, main }).stale, null);
  assert.equal(assess({ now: at('2026-09-26T01:00:00Z'), live, heartbeat: null, main, staleHours: 30 }).stale, null);
});

test('a quiet day with a heartbeat is not an outage, and before any heartbeat live alone decides', () => {
  // Nothing new to publish for two days, but the job ran and said so.
  assert.equal(assess({ now: at('2026-09-26T23:00:00Z'), live, heartbeat: { date: '2026-09-26T22:30:00Z' }, main }).stale, null);
  // No heartbeat branch yet (before the release job writes one): the live pointer's age.
  const { stale } = assess({ now: at('2026-09-26T23:00:00Z'), live, heartbeat: null, main });
  assert.match(stale, /- Last heartbeat: none on the heartbeat branch yet\./);
  // Nothing readable at all is stale, never healthy.
  assert.match(assess({ now: at('2026-09-26T23:00:00Z'), live: null, heartbeat: null, main: null }).stale, /- Last release: the live branch cannot be read\./);
});

test('data main that live does not serve, an hour after it was committed: not live', () => {
  const pushed = { sha: 'b'.repeat(40), date: '2026-09-25T21:00:00Z' };
  // The Content release run is still validating: not yet news.
  assert.equal(assess({ now: at('2026-09-25T21:30:00Z'), live, heartbeat: null, main: pushed }).notLive, null);
  const { notLive, stale } = assess({ now: at('2026-09-25T22:30:00Z'), live, heartbeat: null, main: pushed });
  assert.equal(stale, null);
  assert.match(notLive, /^Data main is at `b{40}` \(committed 2026-09-25T21:00:00Z, 1\.5 h ago\), but live\/current\.json serves `a{40}`\./);
  assert.match(notLive, /actions\/workflows\/content\.yml/);
  assert.match(assess({ now: at('2026-09-25T22:30:00Z'), live: null, heartbeat: null, main: pushed }).notLive, /but live\/current\.json cannot be read\./);
});

test('the branches are read with GETs, and a missing one is null', async () => {
  const calls = [];
  const answers = {
    '/repos/o/r/branches/live': { commit: { sha: 'l'.repeat(40), commit: { committer: { date: live.date } } } },
    '/repos/o/r/branches/main': { commit: { sha: main.sha, commit: { committer: { date: main.date } } } },
    [`/repos/o/r/contents/current.json?ref=${'l'.repeat(40)}`]: JSON.stringify({ schema: 2, revision: main.sha }),
  };
  const fetch = async (url, init) => {
    const pathname = url.replace('https://api.github.com', '');
    calls.push([init.method ?? 'GET', pathname, init.headers.authorization]);
    const answer = answers[pathname];
    if (answer === undefined) return new Response('{"message":"Branch not found"}', { status: 404 });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status: 200 });
  };
  assert.deepEqual(await observe({ repo: 'o/r', token: 't', fetch }), { live, heartbeat: null, main });
  assert.ok(calls.every(([method, , auth]) => method === 'GET' && auth === 'Bearer t'), JSON.stringify(calls));
  await assert.rejects(observe({ repo: 'o/r', fetch: async () => new Response('', { status: 502 }) }), /HTTP 502/);
});
