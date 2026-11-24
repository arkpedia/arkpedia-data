import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declaredStages } from './run-stage.mjs';

const root = new URL('../../', import.meta.url);
const stages = declaredStages(fileURLToPath(root));
if (!stages?.size) throw Error('No importer stage declarations found');
fs.writeFileSync(new URL('config/import-stages.json', root), JSON.stringify({
  version: 1,
  stages: [...stages].sort(),
}, null, 2) + '\n');
