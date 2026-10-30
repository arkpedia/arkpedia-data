import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/*
 * The import reads files the asset repositories publish, and GitHub's raw host answers 404 for a
 * file that is there now and then. A false 404 in a stage drops art that exists, so every script
 * that reads published files asks through fetchAsset (lib/assets/githubRetry.mjs), which confirms
 * a 404 before believing it. Deny by default: in each reader (RAW_READERS) every bare
 * fetch()/fetcher() fails unless listed with what it asks for, and fetchAsset must be called (an
 * import alone proves nothing). In every other script, a fetch of an address built from a raw
 * arkpedia literal -- in the call or in a variable of the same file -- fails. Moved from the
 * application's test-asset-retry.ts with the import (data split phase 4).
 */

type Allowed = { call: RegExp; why: string };
const RAW_READERS: Record<string, Allowed[]> = {
  'scripts/audits/check-published-assets.mjs': [],
  'scripts/sync/sync-chibi-art.mjs': [
    { call: /^fetcher\(`https:\/\/api\.github\.com\/repos\/\$\{REPOSITORY\}\/commits\/main`/, why: "the API's commit lookup, not a published file" },
  ],
  'scripts/sync/sync-dynamic-art.mjs': [],
  'scripts/sync/update-asset-revisions.mjs': [],
};
const RAW_LITERAL = /raw\.githubusercontent\.com\/(?:arkpedia\/|\$\{REPOSITORY\})/;

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ['globalThis', 'window', 'self'].includes(callee.expression.text)) return callee.name.text;
  return '';
}

/** What the scripts guard finds wrong in `sources` (path to text). */
function scriptGuardFailures(sources: Record<string, string>): string[] {
  const failures: string[] = [];
  const used = new Set<RegExp>();
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const calls: ts.CallExpression[] = [];
    // Names assigned an address built from a raw arkpedia literal, directly or through another such name.
    const declarations: { name: string; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push({ name: node.name.text, text: node.initializer.getText(source) });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) declarations.push({ name: node.left.text, text: node.right.getText(source) });
      ts.forEachChild(node, visit);
    };
    visit(source);
    const tainted = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const { name, text: value } of declarations) {
        if (tainted.has(name)) continue;
        if (RAW_LITERAL.test(value) || [...tainted].some((other) => new RegExp(`\\b${other}\\b`).test(value))) { tainted.add(name); grew = true; }
      }
    }
    const allowed = RAW_READERS[file];
    let confirmed = false;
    for (const call of calls) {
      const name = calleeName(call);
      if (name === 'fetchAsset') { confirmed = true; continue; }
      if (name !== 'fetch' && name !== 'fetcher') continue;
      const text = call.getText(source).replace(/\s+/g, ' ');
      const argument = call.arguments[0]?.getText(source).replace(/\s+/g, ' ') ?? '';
      if (allowed) {
        const entry = allowed.find(({ call: pattern }) => pattern.test(text));
        if (entry) used.add(entry.call);
        else failures.push(`${where(call)}: ${text.slice(0, 120)} -- this script reads published files: ask through fetchAsset (lib/assets/githubRetry.mjs), or list the call in RAW_READERS with what it asks for`);
      } else if (RAW_LITERAL.test(argument) || [...tainted].some((other) => new RegExp(`\\b${other}\\b`).test(argument))) {
        failures.push(`${where(call)}: ${name}(${argument}) -- a raw arkpedia address: a 404 counts only once confirmed, so ask through fetchAsset (lib/assets/githubRetry.mjs) and add the file to RAW_READERS`);
      }
    }
    if (allowed && !confirmed) failures.push(`${file} never calls fetchAsset`);
  }
  for (const [file, entries] of Object.entries(RAW_READERS)) {
    if (!(file in sources)) { failures.push(`${file} is gone: remove it from RAW_READERS`); continue; }
    for (const entry of entries) if (!used.has(entry.call)) failures.push(`${file}: no call matches ${entry.call} any more: remove it from RAW_READERS`);
  }
  return failures;
}

function scriptSources(): Record<string, string> {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' ? [] : walk(at);
    return /\.(?:m?[jt]s|cjs)$/.test(entry.name) ? [at] : [];
  });
  return Object.fromEntries(walk('scripts').map((file) => [file.split(path.sep).join('/'), fs.readFileSync(file, 'utf8')]));
}

test('the scripts that read published files confirm a 404 through fetchAsset', () => {
  assert.deepEqual(scriptGuardFailures(scriptSources()), []);
});

test('the scripts guard fails each way a script can go around fetchAsset', () => {
  const sources = scriptSources();
  // A new script holding a raw address in a variable.
  const added = scriptGuardFailures({ ...sources, 'scripts/sync/sync-new-art.mjs': "const base = 'https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets';\nconst manifest = `${base}/${process.argv[2]}/asset-manifest.json`;\nconst response = await fetch(manifest);\n" });
  assert.ok(added.some((line) => /sync-new-art\.mjs:3: fetch\(manifest\)/.test(line)), added.join('\n'));
  // And a reader that only imports fetchAsset.
  const imported = scriptGuardFailures({ ...sources, 'scripts/sync/update-asset-revisions.mjs': sources['scripts/sync/update-asset-revisions.mjs'].replaceAll('await fetchAsset(', 'await fetch(') });
  assert.ok(imported.includes('scripts/sync/update-asset-revisions.mjs never calls fetchAsset'), imported.join('\n'));
});
