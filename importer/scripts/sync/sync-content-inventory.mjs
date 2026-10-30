import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cnTables } from '../content/pin-upstream.mjs';

export function buildInventory(characterTable, skinTable, source) {
  const operators = Object.entries(characterTable)
    .filter(([id, op]) => id.startsWith('char_') && op.isNotObtainable === false)
    .map(([id, op]) => ({ id, name: op.name })).sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(operators.map(op => op.id));
  const skins = Object.values(skinTable.charSkins)
    .filter(skin => ids.has(skin.charId) && skin.skinId.includes('@') && skin.displaySkin?.skinName)
    .map(skin => ({ id: skin.skinId, operatorId: skin.charId, name: skin.displaySkin.skinName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (operators.length < 400 || skins.length < 500) throw new Error('CN inventory is truncated or changed schema');
  return { source, operators, skins };
}

/**
 * The inventory to write over `previous` (the file on record, or null): with the source it
 * was last read from while what it lists is the same. The source names the CN mirror commit,
 * which moves with every commit to the mirror, and the file is a release input, so rewriting
 * it for that alone would make the day a new release. Both writers of the file go through it.
 */
export function withStableSource(previous, inventory) {
  if (!previous?.source) return inventory;
  const { source: _before, ...listedBefore } = previous, { source: _after, ...listed } = inventory;
  return JSON.stringify(listedBefore) === JSON.stringify(listed) ? { ...inventory, source: previous.source } : inventory;
}

async function main() {
  // The CN tables this run settled on (scripts/content/cn-tables.mjs, passed on by run-stage.mjs),
  // else the primary mirror at its pin, else its branch head.
  const { repository: repo, commit, ref, folder } = cnTables();
  const revision = commit ?? await (async () => {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
      headers: process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`CN source revision: HTTP ${response.status}`);
    return (await response.json()).sha;
  })();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid CN source revision');
  const files = ['character_table.json', 'skin_table.json'];
  const sources = await Promise.all(files.map(async file => {
    const url = `https://raw.githubusercontent.com/${repo}/${revision}/${folder}/excel/${file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const bytes = await response.text();
    return { data: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const inventory = buildInventory(sources[0].data, sources[1].data, {
    repository: `https://github.com/${repo}`, revision,
    files: Object.fromEntries(files.map((file, i) => [file, sources[i].sha256])),
  });
  const previous = fs.existsSync('data/content-inventory.json') ? JSON.parse(fs.readFileSync('data/content-inventory.json','utf8')) : null;
  if (previous) for (const key of ['events','banners']) if (previous[key]) inventory[key]=previous[key];
  fs.writeFileSync('data/content-inventory.json', `${JSON.stringify(withStableSource(previous, inventory), null, 2)}\n`);
  console.log(`CN source inventory: ${inventory.operators.length} operators, ${inventory.skins.length} outfits at ${revision}`);
}
// No top-level await, so the tests can import this module as they compile it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
