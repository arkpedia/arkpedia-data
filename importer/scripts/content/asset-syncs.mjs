#!/usr/bin/env node
/**
 * The public asset repositories' daily syncs, which arkpedia-data's nightly import pins at
 * whatever commit each has reached (its asset-revisions and staged-art stages), and the waits
 * that keep the nightly order: the syncs, then the import, then the application's compile.
 *
 *   node scripts/content/asset-syncs.mjs list                       one per line, repo/workflow
 *   node scripts/content/asset-syncs.mjs wait [--timeout-minutes 30] [--sync repo/workflow ...]
 *
 * `wait` holds a scheduled run until every sync -- or each workflow named with --sync, such as
 * arkpedia-data/import.yml for the compile -- has finished its run of the day. GitHub starts
 * every scheduled run hours late, and by different amounts (the syncs' 16:07-16:31 UTC crons
 * started at 20:35-21:15 on 10-27..10-29), so an order kept by the clock is not kept. A workflow
 * counts as done when its newest run (scheduled or started by hand) is less than 20 hours old and
 * has finished, whatever its conclusion; the 'Asset sync failing' and 'Import failing' reports
 * deal with failures. After the timeout the run goes ahead with what they have reached, and says
 * which it did not wait for. It never fails. Reads the GitHub API with GETs (GH_TOKEN).
 */
import { pathToFileURL } from 'node:url';

export const ASSET_SYNCS = [
  'arkpedia-image-assets/sync-images.yml',
  'arkpedia-skin-assets/sync-artwork.yml',
  'arkpedia-sd-assets/sync-chibis.yml',
  'arkpedia-voice-english/sync-voices.yml',
  'arkpedia-voice-japanese/sync-voices.yml',
  'arkpedia-voice-korean/sync-voices.yml',
  'arkpedia-voice-mandarin/sync-voices.yml',
  'arkpedia-voice-regional/sync-voices.yml',
];
const DAY_WINDOW_MS = 20 * 3_600_000;

/** Where one sync stands, from its workflow's newest runs (the API's order, newest first). */
export function syncState(runs, now) {
  const run = runs.find(entry => entry.event === 'schedule' || entry.event === 'workflow_dispatch');
  if (!run || now - Date.parse(run.created_at) > DAY_WINDOW_MS) return { done: false, detail: `no run in the last 20 hours${run ? ` (the newest started ${run.created_at})` : ''}` };
  if (run.status !== 'completed') return { done: false, detail: `its run of ${run.created_at} is ${run.status}` };
  return { done: true, detail: `its run of ${run.created_at} ended with ${run.conclusion}` };
}

export async function readRuns(sync, { token, fetch = globalThis.fetch }) {
  const [repo, workflow] = sync.split('/');
  const headers = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/arkpedia/${repo}/actions/workflows/${workflow}/runs?per_page=10`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).workflow_runs ?? [];
}

/** Polls every sync until all are done or the time is up. Returns what each last said. */
export async function awaitSyncs({ syncs = ASSET_SYNCS, read, now = () => Date.now(), sleep, timeoutMs, intervalMs, log = () => {} }) {
  const started = now();
  const pending = new Map(syncs.map(sync => [sync, 'not read yet']));
  const done = new Map();
  for (;;) {
    for (const sync of [...pending.keys()]) {
      try {
        const state = syncState(await read(sync), now());
        if (state.done) { done.set(sync, state.detail); pending.delete(sync); log(`${sync}: ${state.detail}`); } else pending.set(sync, state.detail);
      } catch (error) {
        // An unreadable sync is not waited for: the report step after the publish names it.
        done.set(sync, `its runs could not be read (${error instanceof Error ? error.message : error})`);
        pending.delete(sync);
        log(`${sync}: ${done.get(sync)}`);
      }
    }
    if (!pending.size || now() - started + intervalMs > timeoutMs) return { done, pending };
    log(`waiting for ${[...pending].map(([sync, detail]) => `${sync} (${detail})`).join(', ')}`);
    await sleep(intervalMs);
  }
}

async function main([command, ...args]) {
  if (command === 'list') { console.log(ASSET_SYNCS.join('\n')); return; }
  if (command !== 'wait') throw new Error('usage: asset-syncs.mjs list | wait [--timeout-minutes N] [--sync repo/workflow ...]');
  const at = args.indexOf('--timeout-minutes');
  const minutes = at >= 0 ? Number(args[at + 1]) : 30;
  const named = args.flatMap((arg, i) => arg === '--sync' ? [args[i + 1]] : []);
  if (named.some(sync => !/^[\w.-]+\/[\w.-]+\.ya?ml$/.test(sync ?? ''))) throw new Error('--sync takes repo/workflow.yml, a repository of arkpedia');
  const token = process.env.GH_TOKEN;
  const { pending } = await awaitSyncs({
    syncs: named.length ? named : ASSET_SYNCS,
    read: sync => readRuns(sync, { token }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs: minutes * 60_000,
    intervalMs: Number(process.env.ARKPEDIA_SYNC_POLL_MS ?? 60_000),
    log: line => console.log(line),
  });
  if (pending.size) {
    const list = [...pending].map(([sync, detail]) => `${sync} (${detail})`).join(', ');
    console.log(`::warning title=Runs not finished::Went ahead without waiting longer for ${list}; this run takes what they have reached.`);
  } else console.log(`${named.length ? named.join(', ') : 'Every asset sync'} finished ${named.length === 1 ? 'its run' : 'their runs'} of the day.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
