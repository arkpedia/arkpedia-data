import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function syncPlan({ current, published, editorial, containsEditorial }) {
  if (current !== published) return 'superseded';
  if (editorial === current) return 'unchanged';
  if (!editorial || containsEditorial) return 'advance';
  return 'keep-edits';
}
export function sync({ branch = process.env.ARKPEDIA_EDITORIAL_BRANCH || 'editorial', published = process.env.GITHUB_SHA } = {}) {
  if (!/^[a-f0-9]{40}$/.test(published ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || ['main', 'dev', 'dev-live', 'live', 'heartbeat'].includes(branch)) throw new Error('Invalid editorial branch or published commit.');
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
  const current = git(['rev-parse', 'origin/main']);
  let editorial;
  try { editorial = git(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]).split(/\s/)[0]; }
  catch (error) { if (error.status !== 2) throw error; }
  let containsEditorial = false;
  if (editorial && editorial !== current) {
    git(['fetch', '--no-tags', 'origin', editorial]);
    try { git(['merge-base', '--is-ancestor', editorial, current]); containsEditorial = true; }
    catch (error) { if (error.status !== 1) throw error; }
  }
  const plan = syncPlan({ current, published, editorial, containsEditorial });
  console.log(`Editorial sync: ${plan}.`);
  if (plan === 'advance') git(['push', 'origin', `${current}:refs/heads/${branch}`]);
  if (plan === 'keep-edits') console.log('Preserving unpublished editorial edits. No force push.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) sync();
