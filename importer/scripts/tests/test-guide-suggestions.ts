import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* import.yml's 'Report guide suggestions' step, run against a stand-in for gh. Moved from the
   application's test-content-alerts.ts with the guide-videos stage (data split phase 4). */

/* A stand-in for gh: the issue commands the alert script uses, over a JSON store, plus
   `gh api` and `gh issue list --jq` answered through the real jq, as gh --jq does. Every call is
   logged, so a case can see what was created, edited, commented on or closed. */
const fakeGh = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const opt = name => args[args.indexOf(name) + 1];
const issue = () => state.issues.find(entry => entry.number === Number(args[2]));
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
state.calls.push(args[0] === 'api' ? 'api ' + args[1] : args.slice(0, 3).join(' '));
if (args[0] === 'api') {
  const answer = state.api[args[1].split('?')[0]];
  if (answer === undefined) { fs.writeFileSync(file, JSON.stringify(state)); process.exit(1); }
  out(execFileSync('jq', ['-r', opt('--jq')], { input: JSON.stringify(answer), encoding: 'utf8' }));
} else if (args[1] === 'list') {
  const open = state.issues.filter(entry => entry.state === 'open').map(({ number, title, body }) => ({ number, title, body }));
  out(args.includes('--jq') ? execFileSync('jq', ['-r', opt('--jq')], { input: JSON.stringify(open), encoding: 'utf8' }) : open);
}
else if (args[1] === 'view') out({ comments: issue().comments });
else if (args[1] === 'create') state.issues.push({ number: state.issues.length + 1, title: opt('--title'), body: fs.readFileSync(opt('--body-file'), 'utf8'), state: 'open', comments: [] });
else if (args[1] === 'edit') issue().body = fs.readFileSync(opt('--body-file'), 'utf8');
else if (args[1] === 'comment') issue().comments.push({ body: fs.readFileSync(opt('--body-file'), 'utf8') });
else if (args[1] === 'close') { issue().state = 'closed'; issue().comments.push({ body: opt('--comment') }); }
else if (args[0] === 'workflow' && args[1] === 'run') { /* logged above */ }
else { console.error('fake gh: unsupported ' + args.join(' ')); process.exit(2); }
fs.writeFileSync(file, JSON.stringify(state));
`;
// GNU date's relative form, which the workflow uses and macOS's date lacks, at a fixed time.
const fakeDate = `#!/usr/bin/env node
if (!process.argv.includes('-d')) { process.stdout.write(new Date(process.env.FAKE_NOW).toISOString() + '\\n'); process.exit(0); }
const days = Number(process.argv[process.argv.indexOf('-d') + 1].match(/^(\\d+) days ago$/)[1]);
process.stdout.write(new Date(Date.parse(process.env.FAKE_NOW) - days * 86400000).toISOString().replace(/\\.\\d{3}Z$/, 'Z') + '\\n');
`;
type Issue = { number: number; title: string; body: string; state: string; comments: { body: string }[] };
function withGitHub(use: (github: ReturnType<typeof fakeGitHub>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-alerts-'));
  try { use(fakeGitHub(root)); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function fakeGitHub(root: string) {
  const bin = path.join(root, 'bin'), stateFile = path.join(root, 'state.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'date'), fakeDate, { mode: 0o755 });
  fs.writeFileSync(stateFile, JSON.stringify({ issues: [], calls: [], api: {} }));
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_STATE: stateFile, GITHUB_REPOSITORY: 'arkpedia/test', RUNNER_TEMP: root, RUN_URL: 'https://example.invalid/run/1', ...extra });
  return {
    root,
    seed(issues: Partial<Issue>[], api: Record<string, unknown> = {}) {
      fs.writeFileSync(stateFile, JSON.stringify({ issues: issues.map((issue, i) => ({ number: i + 1, state: 'open', comments: [], body: '', ...issue })), calls: [], api }));
    },
    issues: (): Issue[] => state().issues,
    calls: (): string[] => state().calls,
    step(script: string, extra: Record<string, string> = {}) {
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: env(extra) });
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}
function stepScript(name: string, workflow = 'import') {
  const lines = fs.readFileSync(`../.github/workflows/${workflow}.yml`, 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `${workflow}.yml has a '${name}' step`);
  const item = lines[start].search(/\S/);
  const end = lines.findIndex((line, i) => i > start && line.trim() !== '' && line.search(/\S/) <= item);
  const block = lines.slice(start + 1, end < 0 ? lines.length : end);
  const run = block.findIndex(line => /^\s+run: /.test(line));
  assert.ok(run >= 0, `${workflow}.yml's '${name}' step has a run`);
  if (!/^\s+run: \|$/.test(block[run])) return block[run].replace(/^\s+run: /, '');
  const indent = block[run].search(/\S/) + 2;
  const body: string[] = [];
  for (const line of block.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

test('the guide suggestions step opens its issue, edits nothing while the list is the same, and closes it when the list empties', () => {
  withGitHub(github => {
    // The repository the step runs in: the importer's data under importer/.
    const tree = path.join(github.root, 'tree'), importer = path.join(tree, 'importer');
    fs.mkdirSync(path.join(importer, 'data/operators-6star'), { recursive: true });
    fs.writeFileSync(path.join(importer, 'data/operators-6star/Chiave.json'), JSON.stringify({ name: 'Chiave', rarity: 6, guides: [] }));
    const registry = (dismissed: string[]) => fs.writeFileSync(path.join(importer, 'data/guide-creators.json'),
      JSON.stringify({ version: 1, creators: [{ name: 'DragonGJY', channelId: 'UC4kAu36j1X8qGXys4ZEc77Q' }], dismissed }));
    registry([]);
    fs.writeFileSync(path.join(importer, 'data/guide-videos-state.json'), JSON.stringify({ version: 1, creators: {}, pending: [
      { videoId: 'S5m6sXaH0V8', creator: 'DragonGJY', title: 'Chiave Siracusa Guide - Stronghold Protocol Alliance Part II', operators: ['Chiave'], reason: 'reads as another kind of video', firstSeen: '2026-10-15' }] }));
    // The step reads the tree it runs in; the scripts it calls come from this checkout (the
    // importer's, and the repository's alert script), and tsx from the importer's node_modules.
    const script = stepScript('Report guide suggestions')
      .replaceAll('npx tsx scripts/', `${JSON.stringify(path.resolve('node_modules/.bin/tsx'))} ${JSON.stringify(path.resolve('scripts'))}/`)
      .replaceAll('node scripts/', `node ${JSON.stringify(path.resolve('../scripts'))}/`);
    const run = () => github.step(`cd ${JSON.stringify(tree)} && ${script}`);
    assert.equal(run().status, 0);
    assert.equal(github.issues().length, 1);
    assert.equal(github.issues()[0].title, 'Guide suggestions');
    assert.match(github.issues()[0].body, /^<!-- arkpedia-alert:guide-suggestions -->\n<!-- arkpedia-alert-digest:/);
    assert.match(github.issues()[0].body, /\[Chiave Siracusa Guide - Stronghold Protocol Alliance Part II\]\(https:\/\/www\.youtube\.com\/watch\?v=S5m6sXaH0V8\)/);
    const calls = github.calls().length;
    assert.equal(run().status, 0);
    assert.deepEqual(github.calls().slice(calls), ['issue list --repo'], 'the same list: looked up, nothing edited or commented');
    registry(['S5m6sXaH0V8']);
    assert.equal(run().status, 0);
    assert.equal(github.issues()[0].state, 'closed');
    assert.match(github.issues()[0].comments.at(-1)!.body, /No guide suggestion is waiting/);
  });
});
