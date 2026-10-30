import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/* The nightly order is the syncs, then this import, then the application's compile, kept by waits
   and not by the clock: GitHub starts every scheduled run hours late, by different amounts. */

test("a scheduled import waits for the asset syncs' runs of the day before any stage pins them, and never fails over them", () => {
  const workflow = fs.readFileSync('../.github/workflows/import.yml', 'utf8');
  const names = [...workflow.matchAll(/^ {6}- name: (.*)$/gm)].map(match => match[1]);
  const wait = names.indexOf("Wait for the asset syncs' runs of the day");
  assert.ok(wait >= 0 && wait < names.indexOf('Import'), 'before the import pins the asset repositories');
  const block = workflow.slice(workflow.indexOf("- name: Wait for the asset syncs' runs of the day"), workflow.indexOf('- name: Choose the content channel'));
  assert.match(block, /if: github\.event_name == 'schedule'\n/, 'a dispatched import (a patch day, by hand) does not wait');
  assert.match(block, /continue-on-error: true\n/);
  const step = Number(block.match(/timeout-minutes: (\d+)\n/)![1]);
  const script = Number(block.match(/run: node scripts\/content\/asset-syncs\.mjs wait --timeout-minutes (\d+)\n/)![1]);
  assert.ok(step > script, 'the script gives up before the step is killed');
  const job = Number(workflow.match(/^ {4}timeout-minutes: (\d+)$/m)![1]);
  assert.ok(job >= script + 60, 'the job has room for the wait and an import');
});
