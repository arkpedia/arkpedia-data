#!/usr/bin/env node
/**
 * After the staged-art stage has published what the importers staged and adopted the new
 * asset revisions: each importer that staged a file now published runs again, as the refresh
 * ran it (config/staged-art.json, `adopt`). With the files in the availability index it finds
 * them published, points its records at them -- a preview, a render, an icon mapping, a cover
 * filename -- and reports its quarantine entries without them, so they clear the same day.
 *
 *   node scripts/sync/adopt-staged-art.mjs <published.json>
 *   node scripts/sync/adopt-staged-art.mjs --check <published.json>
 *
 * published.json is what publish-catalogue-assets.py wrote: {files: {destination: kind}}.
 * An importer that fails fails this, and with it the stage, whose changes under data/ are
 * then put back with the asset pins; the next run adopts the files instead.
 *
 * Nothing is adopted unless the availability index (data/assets/external-asset-index.json,
 * which `npm run assets:update` just rewrote at the image repository's head) lists every
 * file this run published. The head comes from GitHub's API, which can answer with the
 * commit from before the push for a moment: adopting that, every importer would find its
 * files still unpublished, keep its entries, and the stage would report success having
 * adopted nothing. --check says whether the index has them all (exit 1, naming the ones it
 * lacks); publish-catalogue-assets.sh asks again until it does, and the adoption itself
 * refuses to run without them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stagedKinds } from '../lib/staged-art.mjs';
import { readQuarantine } from '../lib/quarantine.mjs';

/** The kinds with anything published, in the registry's order, each with its adopt command. */
export function adoptions(published, kinds = stagedKinds()) {
  const counts = new Map();
  for (const kind of Object.values(published.files ?? {})) {
    if (!kinds[kind]) throw new Error(`published.json names ${kind}, which is not a staged art kind`);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return Object.entries(kinds).filter(([kind]) => counts.has(kind)).map(([kind, spec]) => ({ kind, files: counts.get(kind), command: spec.adopt }));
}

/** The destinations in published.json the availability index does not list, sorted. */
export function unadopted(published, root = process.cwd()) {
  const index = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/assets/external-asset-index.json'), 'utf8')).files);
  return Object.keys(published.files ?? {}).filter(target => !index.has(target)).sort();
}

export function adoptStagedArt(publishedFile, { root = process.cwd(), run = spawnSync, log = console.log } = {}) {
  const published = JSON.parse(fs.readFileSync(publishedFile, 'utf8'));
  const missing = unadopted(published, root);
  if (missing.length) {
    throw new Error(`The asset revisions just adopted do not include ${missing.length} file(s) this run published (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}); `
      + 'nothing is adopted, and the next run, pinning a head that has them, adopts them');
  }
  const before = new Set(readQuarantine(root).entries.map(entry => `${entry.stage} ${entry.key}`));
  for (const { kind, files, command } of adoptions(published)) {
    log(`== ${kind}: ${files} file(s) published; ${command.join(' ')}`);
    const result = run(command[0], command.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env, ARKPEDIA_ART_ADOPTION: '1' } });
    if (result.status !== 0) throw new Error(`${command.join(' ')} exited ${result.status ?? result.signal} adopting what ${kind} staged`);
  }
  const after = new Set(readQuarantine(root).entries.map(entry => `${entry.stage} ${entry.key}`));
  const cleared = [...before].filter(key => !after.has(key)).sort();
  log(`${cleared.length} quarantine entr${cleared.length === 1 ? 'y' : 'ies'} cleared by publishing the staged art${cleared.length ? ':' : '.'}`);
  for (const key of cleared) log(`  - ${key}`);
  return cleared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--check' && args.length === 2) {
    const missing = unadopted(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    for (const target of missing) console.error(`  not in the adopted revisions yet: ${target}`);
    process.exitCode = missing.length ? 1 : 0;
  } else if (args.length === 1) adoptStagedArt(args[0]);
  else throw new Error('usage: adopt-staged-art.mjs [--check] <published.json>');
}
