import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/* The import's asset-revisions stage adopts the day's pins and checks the files at them
   (update-asset-revisions.mjs runs check-published-assets.mjs). The voice lines are rebuilt
   against those pins by the voices stage, later in the same run, so a check of the lines
   inside the asset stage judged yesterday's lines: in a rehearsal of the first run after the
   builder learnt to narrow legacy packs, it failed on the 18 clips the voices stage was about
   to leave out, and the day's asset pins were thrown away with it. What the site then offers
   from the lines, and the release's own clip check, are held by arkpedia-app's
   scripts/tests/test-voice-clips.ts. */
test('the voice lines are rebuilt after the pins they are checked against, never inside the asset stage', () => {
  const imports = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  const at = (pattern: RegExp) => {
    const match = imports.match(pattern);
    assert.ok(match, `${pattern} is not in run-imports.sh`);
    return match.index!;
  };
  assert.ok(at(/stage asset-revisions -- npm run assets:update\n/) < at(/stage voices /));
  // Everything the asset stage runs, through the scripts it starts.
  const reached = new Set<string>();
  const queue = ['scripts/sync/update-asset-revisions.mjs'];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    for (const [, script] of fs.readFileSync(file, 'utf8').matchAll(/['"](scripts\/[\w/.-]+\.(?:mjs|cjs|js))['"]/g)) queue.push(script);
  }
  assert.ok(reached.has('scripts/audits/check-published-assets.mjs'), 'not vacuous: the asset stage checks the files at its pins');
  for (const file of reached) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /operator-voice-lines\.json|voiceRecording\.mjs|check-voice-clips/, `${file} runs in the asset-revisions stage, before the voices stage rebuilds the lines`);
  }
});
