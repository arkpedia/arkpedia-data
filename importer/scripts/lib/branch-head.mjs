/**
 * A GitHub repository's branch head, asked every way there is before it is called unknown.
 *
 * On 2026-10-15 GitHub answered 409 "Git Repository is empty" for arkpedia-image-assets's
 * main, on the commits API and the git refs API, for every ask of a content run (06:34-06:41)
 * and still at 06:56, while the branches API and `git ls-remote` named its head (20a75473).
 * The asset-revisions stage asked the commits API once, failed, and so did the
 * catalogue-assets and staged-art stages, which pin through it: the release kept the pin of
 * the day before, without the art the patch had renamed (GALLUS², Kal'tsit Esperanta).
 *
 * So a head is asked of git itself first and the API's branches and commits endpoints after,
 * each in turn, for a few rounds with pauses, and no one refusal -- a 409, a false 404, an
 * unreachable host -- is taken as the answer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SHA = /^[a-f0-9]{40}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const runCommand = async (command, args) => (await execFileAsync(command, args, {
  // Short: a way that hangs is skipped for the next one, so the whole of branchHead() stays
  // within a few minutes, well inside the stage's 15 (scripts/content/run-stage.mjs).
  timeout: 20_000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout;
const reasonOf = error => String(error?.stderr || error?.message || error).trim().split('\n').pop();

/** The ways a branch head is asked, in order: git's own protocol, then two API endpoints. */
export function headQueries(repository, branch) {
  return [
    { how: 'git ls-remote', command: 'git', args: ['ls-remote', '--exit-code', `https://github.com/${repository}.git`, `refs/heads/${branch}`], read: out => out.split(/\s/)[0] },
    { how: 'branches API', command: 'gh', args: ['api', `repos/${repository}/branches/${branch}`, '--jq', '.commit.sha'], read: out => out.trim() },
    { how: 'commits API', command: 'gh', args: ['api', `repos/${repository}/commits/${branch}`, '--jq', '.sha'], read: out => out.trim() },
  ];
}

/** A branch's head commit: the first commit any of headQueries names, over `rounds` rounds. */
export async function branchHead(repository, branch = 'main', { run = runCommand, sleep = pause, rounds = 3, backoffMs = 5000, log = message => console.warn(message) } = {}) {
  const failures = [];
  for (let round = 1; round <= rounds; round++) {
    for (const { how, command, args, read } of headQueries(repository, branch)) {
      try {
        const sha = read(await run(command, args));
        if (SHA.test(sha)) return sha;
        failures.push(`${how}: answered "${sha.slice(0, 80)}"`);
      } catch (error) {
        failures.push(`${how}: ${reasonOf(error)}`);
      }
    }
    if (round < rounds) {
      log(`${repository} ${branch}: no head yet (${failures.slice(-3).join('; ')}); asking again`);
      await sleep(backoffMs * round);
    }
  }
  throw new Error(`Cannot resolve ${repository} ${branch} after ${rounds} rounds: ${failures.slice(-3).join('; ')}`);
}
