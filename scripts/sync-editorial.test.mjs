import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncPlan } from './sync-editorial.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
test('only a current, published main advances editorial without overwriting new edits', () => {
  assert.equal(syncPlan({ current: 'b', published: 'a' }), 'superseded');
  assert.equal(syncPlan({ current: 'b', published: 'b' }), 'advance');
  assert.equal(syncPlan({ current: 'b', published: 'b', editorial: 'b' }), 'unchanged');
  assert.equal(syncPlan({ current: 'b', published: 'b', editorial: 'a', containsEditorial: true }), 'advance');
  assert.equal(syncPlan({ current: 'b', published: 'b', editorial: 'c', containsEditorial: false }), 'keep-edits');
});
test('real git publication advances incorporated edits and preserves concurrent source work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editorial-sync-test-'));
  const remote = path.join(root, 'remote.git'), local = path.join(root, 'local');
  const script = path.resolve('scripts/sync-editorial.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: local, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(local);
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('remote', 'add', 'origin', remote);
    const commit = text => { fs.writeFileSync(path.join(local, 'source.json'), text); git('add', '.'); git('commit', '-m', text); return git('rev-parse', 'HEAD'); };
    const initial = commit('initial'); git('push', 'origin', 'main');
    const run = published => execFileSync(process.execPath, [script], { cwd: local, env: { ...process.env, GITHUB_SHA: published, ARKPEDIA_EDITORIAL_BRANCH: 'editorial' }, stdio: 'pipe' });
    run(initial);
    assert.ok(git('ls-remote', 'origin', 'refs/heads/editorial').startsWith(initial));
    git('switch', '-c', 'editorial'); commit('editorial edit'); git('push', 'origin', 'editorial');
    git('switch', 'main'); git('merge', '--ff-only', 'editorial'); const compiled = commit('compiled shared data'); git('push', 'origin', 'main');
    run(compiled);
    assert.ok(git('ls-remote', 'origin', 'refs/heads/editorial').startsWith(compiled));
    git('switch', 'editorial'); git('merge', '--ff-only', 'main'); const pending = commit('new unpublished edit'); git('push', 'origin', 'editorial');
    git('switch', 'main'); const nextMain = commit('other shared update'); git('push', 'origin', 'main');
    run(nextMain);
    assert.ok(git('ls-remote', 'origin', 'refs/heads/editorial').startsWith(pending));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
