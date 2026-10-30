/**
 * The daily refresh as its definitions declare it, for the tests that hold every stage, or
 * every script a stage runs, to a rule (test-stage-runner.ts, test-staged-art.ts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* The stages of the nightly import in the order they run: run-imports.sh, with
   refresh-stage-data.sh's stages where it calls it. */
export function refreshStages() {
  const stagesOf = (text: string) => {
    const joined = text.replace(/\\\n\s*/g, ' ');
    return [...joined.matchAll(/^\s*(stage [^\n]*|bash scripts\/sync\/refresh-stage-data\.sh)$/gm)].map(match => match[1]);
  };
  const step = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  // Run on its own, the script starts a run and pins first; inside the daily one it does not.
  const script = fs.readFileSync('scripts/sync/refresh-stage-data.sh', 'utf8');
  const standalone = script.match(/^if \[ -z "\$\{ARKPEDIA_STAGE_RUN:-\}" \]; then\n([\s\S]*?)^fi\n/m);
  assert.ok(standalone, 'refresh-stage-data.sh has a block for running on its own');
  assert.match(standalone[1], /run-stage\.mjs begin\n\s*stage pin-upstream -- node scripts\/content\/pin-upstream\.mjs\n/);
  assert.match(script, /\nif \[ -n "\$standalone" \]; then node scripts\/content\/run-stage\.mjs end --strict; fi\n$/);
  const inner = stagesOf(script.replace(standalone[0], ''));
  return stagesOf(step).flatMap(line => line.startsWith('bash ') ? inner : [line]).map(line => {
    const words = line.split(/\s+/);
    const options = words.slice(0, words.indexOf('--'));
    const needs = options.flatMap((word, i) => word === '--needs' ? options[i + 1].split(',') : []);
    const values = (option: string) => options.flatMap((word, i) => word === option ? [options[i + 1]] : []);
    return { name: words[1], needs, invariant: options.includes('--invariant'), outputs: values('--output'), keep: values('--keep'),
      command: words.slice(words.indexOf('--') + 1).join(' ') };
  });
}
/* Every file one command runs: the scripts it names, the npm scripts and shell scripts those
   call, and the local modules they import. */
export function commandScripts(command: string) {
  const npm = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
  const files = new Set<string>();
  const commands = (text: string) => {
    for (const [, name] of text.matchAll(/npm run ([\w:-]+)/g)) if (npm[name]) commands(npm[name]);
    for (const [file] of text.matchAll(/scripts\/[\w./-]+\.(?:mjs|js|ts|py|sh)\b/g)) visit(file);
  };
  const visit = (file: string) => {
    if (files.has(file) || !fs.existsSync(file)) return;
    files.add(file);
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.py')) {
      for (const [, name] of text.matchAll(/^(?:from|import) (\w+)/gm)) visit(path.join(path.dirname(file), `${name}.py`));
    } else if (file.endsWith('.sh')) commands(text);
    else {
      for (const [, spec] of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
        const at = path.join(path.dirname(file), spec);
        const found = [at, `${at}.ts`, `${at}.mjs`, `${at}.js`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (found) visit(found);
      }
    }
  };
  commands(command);
  return [...files].sort();
}
/* Every file the refresh's stages run, over all of them. */
export function refreshScripts() {
  return [...new Set(refreshStages().flatMap(stage => commandScripts(stage.command)))].sort();
}
