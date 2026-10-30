import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

/*
 * Where the planner's material catalogue is built in the night's run. The application reads
 * data/material-catalogue.json and data/material-names.json as pulled records and holds the
 * builder itself to its tables (arkpedia-app scripts/tests/test-material-catalogue.ts); only
 * the order of the stages that write them lives here.
 */

test('the catalogue is built after the records settle and before the gate reads it', () => {
  const imports = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  const at = (text: string) => { const i = imports.indexOf(text); assert.ok(i >= 0, text); return i; };
  // After the English refresh renames the costs the catalogue is derived from.
  assert.ok(at('stage operator-english') < at('stage material-catalogue --') && at('stage material-catalogue --') < at('stage import-aliases --needs material-catalogue --output data/material-catalogue.json'));
  assert.ok(at('stage import-aliases') < at('stage completeness'));
});
