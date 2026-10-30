#!/usr/bin/env node
/**
 * The kernel-pool refresh stage: Global's moves of operators from Standard to Kernel
 * Headhunting, applied to the operator records from the wiki's yearly banner page, so the gacha
 * simulator's pools follow them without anyone typing them in (kernel-pool.mjs says what is
 * read, how the day is dated, and what is never done).
 *
 * Reads Headhunting/Banners/<year> for this year (UTC) and the year before -- a move stated in
 * late December is still there in January -- but never before FIRST_UPDATES_YEAR. One request a
 * page a day, through the wiki readers' own request (wiki-pages.mjs: its user agent, its
 * ARKPEDIA_WIKI_BASE). Writes only a record that changes, as every operator sync does (two-space
 * JSON and a newline), so a day with no new move writes nothing.
 *
 * Never thrown, always reported (stage 'kernel-pool' of data/quarantine.json, in the daily
 * 'Content quarantined' issue): a page the wiki cannot serve, a statement or a sentence about a
 * move it cannot read, a name no record answers to, a record the move cannot be squared with. Each
 * leaves the records as they were. A page with no Updates section has nothing to report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { readWikiText, wikiPageUrl } from './wiki-pages.mjs';
import { datedKernelMoves, FIRST_UPDATES_YEAR, planKernelMoves } from './kernel-pool.mjs';

export const STAGE = 'kernel-pool';
export const yearlyPages = now => [now.getUTCFullYear() - 1, now.getUTCFullYear()]
  .filter(year => year >= FIRST_UPDATES_YEAR).map(year => `Headhunting/Banners/${year}`);

/** The operator records under data/, each with the file it is written to. */
export function readOperatorRecords(root) {
  const data = path.join(root, 'data');
  return fs.readdirSync(data).filter(dir => /^operators-\dstar$/.test(dir)).sort().flatMap(dir =>
    fs.readdirSync(path.join(data, dir)).filter(file => file.endsWith('.json')).sort()
      .map(file => ({ file: path.join(data, dir, file), record: JSON.parse(fs.readFileSync(path.join(data, dir, file), 'utf8')) })));
}

/**
 * Applies the moves the yearly pages state. `readText(page)` stands in for the wiki in tests.
 * Returns { moved: [record names], held: entries as reported }.
 */
export async function syncKernelPool(root = process.cwd(), { now = defaultNow(), readText = page => readWikiText(page, now), write = true } = {}) {
  const alerts = beginStage(root, STAGE, now);
  const files = readOperatorRecords(root);
  const fileOf = new Map(files.map(({ file, record }) => [record, file]));
  let operators = files.map(({ record }) => record);
  const moved = [];
  for (const page of yearlyPages(now)) {
    let text;
    try {
      text = await readText(page);
    } catch (error) {
      const cause = error.cause?.cause?.code ?? error.cause?.message;
      console.warn(`Reading ${page} failed: ${error.message}${cause ? ` (${cause})` : ''}`);
      alerts.add({ key: `kernel-pool:${page}`, action: 'kept-previous', sourceRef: wikiPageUrl(page),
        reason: `Wiki page ${page} cannot be read (${error.message}), so no Standard to Kernel Headhunting move it states is applied today; the operator records keep their pool fields` });
      continue;
    }
    if (!text) continue; // this year's page before the wiki creates it (January only)
    const { moves, problems } = datedKernelMoves(text);
    for (const problem of problems) {
      alerts.add({ key: `kernel-pool:${page}`, action: 'kept-previous', sourceRef: wikiPageUrl(page),
        reason: `Wiki page ${page}: ${problem}; the move it may state is not applied, and the records keep their pool fields until the parser reads it (scripts/sync/kernel-pool.mjs)` });
    }
    const plan = planKernelMoves({ operators, moves, source: page });
    for (const entry of plan.held) alerts.add({ ...entry, sourceRef: wikiPageUrl(page) });
    if (!plan.changes.length) continue;
    // Later pages see this page's moves: the record is replaced where it stands.
    const replaced = new Map(plan.changes.map(({ op, next }) => [op, next]));
    operators = operators.map(op => replaced.get(op) ?? op);
    for (const { op, next } of plan.changes) {
      const file = fileOf.get(op);
      fileOf.set(next, file);
      if (write) fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      moved.push(`${next.name}: Standard Headhunting "No", Kernel Headhunting "Yes", Kernel Addition Date ${next.characterInfo['Kernel Addition Date']} (${page})`);
    }
  }
  const held = write ? alerts.commit() : alerts.entries;
  return { moved, held };
}

// No top-level await, so the tests can import this module as they compile it.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  syncKernelPool(process.cwd(), { write: !process.argv.includes('--dry-run') }).then(({ moved, held }) => {
    console.log(moved.length ? `Moved to Kernel Headhunting:\n${moved.map(line => `  + ${line}`).join('\n')}` : 'Kernel Headhunting moves are current.');
    if (held.length) console.warn(`${held.length} kernel-pool problem(s) reported:\n${held.map(entry => `  ! ${entry.key}: ${entry.reason}`).join('\n')}`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
