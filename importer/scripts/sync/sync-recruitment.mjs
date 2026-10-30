import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pinnedCommit } from '../content/pin-upstream.mjs';

const repository = 'ArknightsAssets/ArknightsGamedata';
const tablePath = 'en/gamedata/excel';
const classes = { PIONEER: 'Vanguard', WARRIOR: 'Guard', TANK: 'Defender', SNIPER: 'Sniper', CASTER: 'Caster', MEDIC: 'Medic', SUPPORT: 'Supporter', SPECIAL: 'Specialist' };
const normalizeName = name => name.normalize('NFKC').replace(/["“”]/g, '').trim().replace(/^['‘]|['’]$/g, '').toLowerCase();

/** Recruitment membership comes from recruitDetail, never character availability,
 * CN records, or the presence of a recruitment-compatible trait. */
export function buildRecruitmentPool(gacha, characters) {
  if (typeof gacha?.recruitDetail !== 'string' || !Array.isArray(gacha.gachaTags)) throw new Error('Invalid English recruitment table');
  const knownTags = new Set(gacha.gachaTags.map(tag => tag.tagName));
  const charactersByName = new Map();
  for (const [id, character] of Object.entries(characters)) {
    if (!character?.name || !id.startsWith('char_')) continue;
    const key = normalizeName(character.name);
    const entries = charactersByName.get(key) || [];
    entries.push({ id, ...character });
    charactersByName.set(key, entries);
  }
  const lines = gacha.recruitDetail.replace(/<[^>]*>/g, '').split(/\r?\n/);
  const groups = new Set();
  const seen = new Set();
  const operators = [];
  let rarity = 0;
  for (const line of lines.map(line => line.trim()).filter(Boolean)) {
    if (/^★{1,6}$/.test(line)) {
      rarity = line.length;
      if (groups.has(rarity)) throw new Error(`Duplicate rarity group: ${rarity}`);
      groups.add(rarity);
      continue;
    }
    if (!rarity || /^-+$/.test(line)) continue;
    for (const name of line.split(/\s+\/\s+/)) {
      const candidates = charactersByName.get(normalizeName(name)) || [];
      if (candidates.length !== 1) throw new Error(`Unresolved or ambiguous recruit: ${name}`);
      const character = candidates[0];
      if (seen.has(character.id)) throw new Error(`Duplicate recruit: ${name}`);
      seen.add(character.id);
      if (character.rarity !== `TIER_${rarity}` || !classes[character.profession]
        || !['MELEE', 'RANGED'].includes(character.position)
        || !Array.isArray(character.tagList) || !character.tagList.length
        || character.tagList.some(tag => !knownTags.has(tag))) throw new Error(`Invalid recruitment fields: ${name}`);
      operators.push({ id: character.id, name: character.name, rarity,
        class: classes[character.profession], position: character.position === 'MELEE' ? 'Melee' : 'Ranged',
        tags: [...new Set(character.tagList)].sort() });
    }
  }
  if (groups.size !== 6 || [...groups].some(rarity => !operators.some(operator => operator.rarity === rarity))) {
    throw new Error('Incomplete recruitment rarity groups');
  }
  return operators.sort((a, b) => a.id.localeCompare(b.id));
}

export function validateLocalOperators(operators, local) {
  for (const recruit of operators) {
    const matches = local.filter(operator => operator.internalName === recruit.id);
    if (matches.length !== 1) throw new Error(`Missing or duplicate local operator: ${recruit.id}`);
    const operator = matches[0];
    for (const field of ['rarity', 'class', 'position', 'tags']) {
      const value = field === 'tags' ? [...(operator.tags || [])].sort() : operator[field];
      if (JSON.stringify(value) !== JSON.stringify(recruit[field])) throw new Error(`Review ${operator.name}: ${field} differs from English game data`);
    }
  }
}

export async function syncRecruitment(root) {
  const headers = { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
  // The commit this run pinned (run-stage.mjs), else the branch head.
  const revision = await pinnedCommit(repository, async (repo, branch) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot resolve English game data: ${response.status}`);
    return (await response.json()).sha;
  });
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid game-data revision');
  const tables = await Promise.all(['gacha_table', 'character_table'].map(async name => {
    const url = `https://raw.githubusercontent.com/${repository}/${revision}/${tablePath}/${name}.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot read ${name}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { data: JSON.parse(bytes.toString()), source: { url, sha256: createHash('sha256').update(bytes).digest('hex') } };
  }));
  const operators = buildRecruitmentPool(tables[0].data, tables[1].data);
  if (operators.length < 100) throw new Error('Incomplete Global recruitment pool; preserving the reviewed snapshot');
  const local = fs.readdirSync(path.join(root, 'data')).filter(name => /^operators-\dstar$/.test(name)).flatMap(directory =>
    fs.readdirSync(path.join(root, 'data', directory)).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(root, 'data', directory, file), 'utf8'))));
  validateLocalOperators(operators, local);
  const snapshot = { schema: 1, region: 'Global', source: { repository, revision, gacha: tables[0].source, characters: tables[1].source }, operators };
  const file = path.join(root, 'data/recruitment-global.json');
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  // Keep the original evidence when unrelated upstream commits change. No daily timestamp churn.
  if (JSON.stringify(previous?.operators) === JSON.stringify(operators)) return console.log(`Global recruitment unchanged (${operators.length} operators).`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Prepared ${operators.length} Global recruits for review; source ${revision}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  syncRecruitment(process.cwd()).catch(error => { console.error(error.message); process.exitCode = 1; });
}
