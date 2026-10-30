#!/usr/bin/env node
// Run every Python regression suite; new test files cannot quietly miss CI.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function pythonTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return pythonTests(file);
    return entry.isFile() && /^test-.*\.py$/.test(entry.name) ? [file] : [];
  }).sort();
}

export function runPythonTests(files, run = spawnSync) {
  if (!files.length) throw new Error('No Python regression suites found');
  let failed = 0;
  for (const file of files) {
    console.log(`\nPython regression suite: ${file}`);
    const result = run('python3', [file], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      console.error(`FAILED: ${file}${result.error ? ` (${result.error.message})` : ''}`);
      failed++;
    }
  }
  console.log(`\nPython suites: ${files.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPythonTests(pythonTests('scripts'));
}
