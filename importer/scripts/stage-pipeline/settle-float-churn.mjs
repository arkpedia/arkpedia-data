#!/usr/bin/env node
/**
 * Restores data files a rebuild rewrote without changing what they say.
 *
 * A rebuild touches every file it writes, and JSON.stringify does not round-trip the
 * gamedata's floats: a `time` of 0.0 comes back as 0, a `dp_per_second` of 1.0 as 1.
 * The value is the same number -- JSON has one numeric type and 0.0 IS 0 -- so a
 * commit carrying 7,000 of those hides the handful of files that actually changed,
 * in a repo whose history is already heavy. Key order does the same thing on a smaller
 * scale, where a later importer rewrites a record the builder already wrote.
 *
 * So: parse both sides and compare the VALUES. Byte-identical after parsing means the
 * rewrite said nothing, and the file goes back to what is committed. Anything with a
 * real difference is left exactly as the pipeline wrote it.
 *
 * Run after a pipeline build, before looking at the diff:
 *   node scripts/stage-pipeline/settle-float-churn.mjs
 *   node scripts/stage-pipeline/settle-float-churn.mjs --dry-run
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry-run');

/**
 * A value as text, with object keys in a fixed order.
 *
 * Key order is the second kind of nothing-change: an importer that reads a record and
 * writes it back can emit {name, description} where the builder emitted
 * {description, name}. Sorting the keys means only the VALUES decide.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

// Only tracked, modified JSON under data/: an untracked file is new and has nothing
// to compare against, and a deletion is not churn.
const changed = git(['diff', '--name-only', '--diff-filter=M', '--', 'data'])
  .split('\n')
  .filter((f) => f.endsWith('.json'));

const same = [];
const real = [];
for (const file of changed) {
  let head;
  let now;
  try {
    head = JSON.parse(git(['show', `HEAD:${file}`]));
    now = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unparseable either side: not our business, leave it for the human.
    real.push(file);
    continue;
  }
  if (canonical(head) === canonical(now)) same.push(file);
  else real.push(file);
}

console.log(`${changed.length} modified JSON files under data/`);
console.log(`  ${same.length} say the same thing (float formatting only)`);
console.log(`  ${real.length} really changed`);
for (const file of real.slice(0, 20)) console.log(`    ${file}`);
if (real.length > 20) console.log(`    ... and ${real.length - 20} more`);

if (!same.length || dry) process.exit(0);

// In batches: 7,000 paths is past the argv limit.
for (let at = 0; at < same.length; at += 500) {
  git(['checkout', '--', ...same.slice(at, at + 500)]);
}
console.log(`restored ${same.length} files`);
