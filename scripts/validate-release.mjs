import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pageFilePath } from './page-paths.mjs';
const root = path.resolve(process.argv[2] || '.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
const hex = /^[a-f0-9]{64}$/;
const gitSha = /^[a-f0-9]{40}$/;
const safe = name => typeof name === 'string' && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..') && !name.startsWith('/');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    check(!entry.isSymbolicLink(), `Symlink not allowed: ${entry.name}`);
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
// Every material cost in an operator record is one flat list of { name, quantity }.
// The planner, the catalogue importer and the daily image sync all read that shape;
// a nested list ([[{...}]]) still parses but crashes the image sync. Empty lists are
// valid, since unreleased records often have no costs yet.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkCosts(list, where) {
  check(Array.isArray(list), `${where} must be a list of { name, quantity }`);
  list.forEach((item, i) => check(plain(item) && Object.keys(item).sort().join() === 'name,quantity'
    && typeof item.name === 'string' && item.name.trim() !== '' && Number.isInteger(item.quantity) && item.quantity > 0,
  `${where}[${i}] must be { name, quantity } with a positive whole quantity`));
}
// skillCost (keyed by skill level) and each skill's mastery cost (m1-m3) are null
// when the operator has none. Which keys exist varies by rarity and by skill.
function checkCostTable(table, where) {
  if (table === null) return;
  check(plain(table), `${where} must be null or an object of cost lists`);
  for (const [key, list] of Object.entries(table)) checkCosts(list, `${where}.${key}`);
}
// The site lists an operator with neither a Global release date nor "isFuture": true
// as released today (operatorAvailability.ts), so a CN-only record must carry one.
function hasGlobalRelease(op) {
  if (typeof op.releaseAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(op.releaseAt) && Number.isFinite(Date.parse(op.releaseAt))) return true;
  const match = String(op.characterInfo?.['Release Date'] ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const day = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return Boolean(day) && day.getUTCFullYear() === +match[1] && day.getUTCMonth() === +match[2] - 1 && day.getUTCDate() === +match[3];
}
function checkOperator(name, op) {
  check(plain(op.potential), `${name}: potential must be { levels, totalCost }`);
  checkCosts(op.potential.totalCost, `${name}: potential.totalCost`);
  check(Array.isArray(op.promotion), `${name}: promotion must be a list`);
  op.promotion.forEach((tier, i) => checkCosts(tier?.cost, `${name}: promotion[${i}].cost`));
  check(plain(op.skills) && Array.isArray(op.skills.skillList), `${name}: skills must be { skillList, skillCost }`);
  checkCostTable(op.skills.skillCost, `${name}: skills.skillCost`);
  op.skills.skillList.forEach((skill, i) => checkCostTable(skill?.cost, `${name}: skills.skillList[${i}].cost`));
  check(Array.isArray(op.modules), `${name}: modules must be a list`);
  op.modules.forEach((module, i) => {
    check(Array.isArray(module?.stages), `${name}: modules[${i}].stages must be a list`);
    module.stages.forEach((stage, j) => checkCosts(stage?.cost, `${name}: modules[${i}].stages[${j}].cost`));
  });
  check(op.isFuture === true || hasGlobalRelease(op), `${name}: needs a Global 'Release Date' (YYYY/MM/DD) or "isFuture": true, or the site lists it as released`);
}
const manifestBytes = fs.readFileSync(path.join(root, 'release/manifest.json'));
const m = JSON.parse(manifestBytes);
check(m.schema === 2 && hex.test(m.release) && gitSha.test(m.generator), 'Unsupported release metadata');
check(m.assets && Object.keys(m.assets).length === 8, 'Expected eight media/palette repositories');
for (const [repo, revision] of Object.entries(m.assets)) check(/^arkpedia-(image-assets|skin-assets|color-palette|voice-(english|japanese|korean|mandarin|regional))$/.test(repo) && gitSha.test(revision), `Invalid asset: ${repo}`);
const expected = new Set(['manifest.json']);
for (const [route, file] of Object.entries(m.pages)) {
  check(file.path === pageFilePath(route), `Invalid page: ${route}`);
}
for (const [name, file] of Object.entries(m.files)) check(safe(name) && file.path === `public/${name}`, `Invalid public file: ${name}`);
for (const file of [...Object.values(m.pages), ...Object.values(m.files)]) {
  check(safe(file.path) && hex.test(file.sha256) && file.bytes > 0 && file.bytes <= 25_000_000, `Invalid file metadata: ${file.path}`);
  check(!expected.has(file.path), `Duplicate output: ${file.path}`);
  expected.add(file.path);
  const bytes = fs.readFileSync(path.join(root, 'release', file.path));
  check(bytes.length === file.bytes && sha(bytes) === file.sha256, `Checksum mismatch: ${file.path}`);
  const json = JSON.parse(bytes);
  check(!/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(bytes.toString()), `Credential-like content: ${file.path}`);
  if (file.path.startsWith('pages/')) check(json.props && typeof json.props === 'object' && !Array.isArray(json.props) && !json.props.__contentRelease, `Invalid page props: ${file.path}`);
}
const actual = walk(path.join(root, 'release')).map(file => path.relative(path.join(root, 'release'), file));
check(actual.length === expected.size && actual.every(file => expected.has(file)), 'Release contains unindexed files');
const untimestamped = [];
const sources = {};
for (const file of walk(path.join(root, 'source')).sort()) {
  const name = path.relative(path.join(root, 'source'), file);
  // Song lyrics are authored by hand in LRC, the format a lyric editor writes and
  // the site's own player reads. They are the one non-JSON record published here;
  // every other source file is still parsed as JSON.
  const lyric = /^data\/lyrics\/[^/]+\.lrc$/.test(name);
  check(safe(name) && (lyric || /^(data\/.*|public\/[^/]+)\.json$/.test(name)), `Invalid source path: ${name}`);
  const bytes = fs.readFileSync(file);
  if (lyric) {
    const text = bytes.toString('utf8');
    check(Buffer.compare(Buffer.from(text, 'utf8'), bytes) === 0, `Lyric file is not UTF-8: ${name}`);
    check(bytes.length > 0 && bytes.length <= 256_000, `Lyric file is empty or oversized: ${name}`);
    // A file with no timestamps parses to zero lines, so its song shows no lyrics.
    // That is a content defect, not an invalid release -- named here rather than
    // blocking every other record in the publication.
    if (!text.split(/\r?\n/).some(line => /^\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(line))) untimestamped.push(name);
    check(!/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(text), `Credential-like content: ${name}`);
  } else {
    const record = JSON.parse(bytes);
    if (/^data\/operators-\dstar\/[^/]+\.json$/.test(name)) checkOperator(name, record);
  }
  sources[name] = sha(bytes);
}
check(JSON.stringify(sources) === JSON.stringify(m.sourceHashes), 'Source records changed without regenerating the release');
check(sha(JSON.stringify({ schema: 2, generator: m.generator, sourceHashes: sources })) === m.release, 'Release input fingerprint mismatch');
for (const route of ['/', '/operators', '/planner', '/gacha', '/schedule', '/skins', '/stages', '/enemies']) check(m.pages[route], `Missing required page: ${route}`);
check(Object.keys(m.pages).filter(route => route.startsWith('/operators/')).length > 100, 'Operator catalogue is incomplete');
for (const file of ['stages-index.json', 'enemies-index.json', 'operator-deploy.json']) check(m.files[file], `Missing catalogue: ${file}`);
if (untimestamped.length) console.warn(`Warning: ${untimestamped.length} lyric file(s) have no timestamps and render no lyrics: ${untimestamped.join(', ')}`);
console.log(`Validated ${Object.keys(m.pages).length} pages, ${Object.keys(m.files).length} data files and ${Object.keys(sources).length} source records.`);
console.log(`Manifest SHA-256: ${sha(manifestBytes)}`);
