import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { MIRRORS, pinVariable } from '../content/pin-upstream.mjs';

/* The import reads every game-data mirror at the commit its pin-upstream stage pinned for the run.
   Moved from the application's test-upstream-pins.ts with the import (data split phase 4). */

const commit = (c: string) => c.repeat(40);

test('the nightly import downloads the charword supplement at the pin, and names no moving branch', () => {
  const imports = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  assert.match(imports, /stage charwords --output "\$supplemental_charwords" -- curl [^\n]*\\\n\s*"\$\(node scripts\/content\/pin-upstream\.mjs raw-url PuppiizSunniiz\/ArknightsGameData_YoStar en_US\/gamedata\/excel\/charword_table\.json\)"/);
  assert.doesNotMatch(imports, /raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/(main|master)\//);
});

test('every reader of the nightly import fetches each mirror at its pinned commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-readers-'));
  try {
    // Every request is recorded and refused, so each script stops at its first reads.
    const preload = path.join(root, 'offline.mjs'), log = path.join(root, 'fetched.txt');
    fs.writeFileSync(preload, "import fs from 'node:fs';\nglobalThis.fetch = async url => { fs.appendFileSync(process.env.FETCH_LOG, `${url}\\n`); throw new Error('offline'); };\n");
    fs.mkdirSync(path.join(root, 'cwd/data'), { recursive: true });
    const pins = Object.fromEntries(MIRRORS.map((mirror: any, i: number) => [pinVariable(mirror.key ?? mirror.repository), commit(String(i + 1))]));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARKPEDIA_'))) as NodeJS.ProcessEnv;
    for (const script of ['sync/sync-module-stats.mjs', 'sync/sync-event-windows.mjs', 'sync/sync-content-inventory.mjs', 'sync/sync-recruitment.mjs',
      'sync/sync-recurring-banners.mjs', 'build/build-operator-voices.mjs', 'sync/sync-operator-english.mjs']) {
      fs.rmSync(log, { force: true });
      spawnSync(process.execPath, ['--import', preload, path.resolve('scripts', script)], { cwd: path.join(root, 'cwd'), encoding: 'utf8',
        env: { ...clean, ...pins, FETCH_LOG: log, ARKPEDIA_EN: path.join(root, 'none'), ARKPEDIA_CN: path.join(root, 'none') } });
      const urls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
      const mirrored = urls.filter(url => MIRRORS.some((mirror: any) => url.includes(`/${mirror.repository}/`)));
      assert.ok(mirrored.length, `${script} read no mirror: ${urls.join(', ')}`);
      for (const url of mirrored) {
        const { repository } = MIRRORS.find((mirror: any) => url.includes(`/${mirror.repository}/`));
        assert.ok(url.startsWith(`https://raw.githubusercontent.com/${repository}/${pins[pinVariable(repository)]}/`), `${script}: ${url}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
