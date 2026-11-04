import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcilePullOdds, syncPullOdds } from '../sync/sync-pull-odds.mjs';

// Exact announcement lines and client metadata, not translated roster guesses.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/cn-pull-odds.json', import.meta.url)));
const empty = () => ({ version: 1, limited: {}, crossover: {}, orienteering: {} });
const input = () => ({ ...structuredClone(fixture), previous: empty() });
const limited = 'LIMITED_79_0_1';
const crossover = 'LINKAGE_77_0_1';

test('confirmed Talulah and Persona rules are discovered without per-banner editorial entries', () => {
  const result = reconcilePullOdds(input());
  assert.deepEqual(result.problems, []);
  assert.deepEqual(new Set(result.imported), new Set([limited, crossover]));
  assert.deepEqual(result.rules.limited[limited], {
    name: '[Celebration] Cinders of Snow', source: 'https://ak.hypergryph.com/news/0787', bonus: 'char_4247_oxi',
    returning300: ['char_1045_svash2', 'char_1041_angel2', 'char_1038_whitw2', 'char_1035_wisdel', 'char_245_cello', 'char_249_mlyss'],
    returning200: ['char_1028_texas2', 'char_1023_ghost2', 'char_1014_nearl2', 'char_1012_skadi2', 'char_391_rosmon', 'char_113_cqbw'],
    verification: result.rules.limited[limited].verification,
  });
  assert.match(result.rules.limited[limited].verification.announcementSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.rules.crossover[crossover].source, 'https://ak.hypergryph.com/news/1457');
  assert.deepEqual(reconcilePullOdds({ ...input(), previous: result.rules }).rules, result.rules, 'idempotent refresh');
});

test('duplicate official notices agree, while contradictory exchange rosters withdraw stale odds', () => {
  const data = input();
  const post = structuredClone(data.posts.find(p => p.cid === '0787'));
  post.cid = '9999'; post.url = 'https://ak.hypergryph.com/news/9999';
  data.posts.push(post);
  const accepted = reconcilePullOdds(data);
  assert.equal(accepted.problems.length, 0);
  const row = post.lines.findIndex(line => line.startsWith('★★★★★★（200'));
  post.lines[row] = post.lines[row].replace('缄默德克萨斯 \\ ', '');
  const conflict = reconcilePullOdds({ ...data, previous: accepted.rules });
  assert.equal(conflict.rules.limited[limited], undefined);
  assert.match(conflict.problems[0].reason, /conflicting official announcements/);
  assert.ok(conflict.rules.crossover[crossover], 'another valid banner is not blocked');
});

test('unknown mechanics, missing evidence and unresolved identities never manufacture odds', () => {
  const changes = [
    data => { data.gacha.gachaPoolClient.find(p => p.gachaPoolId === limited).limitParam.freeCount = 400; },
    data => { data.gacha.gachaPoolClient.find(p => p.gachaPoolId === limited).limitParam.limitedCharId = 'char_4244_tocka'; },
    data => { data.gacha.gachaPoolClient.find(p => p.gachaPoolId === limited).guarantee5Count = 20; },
    data => { data.posts[0].lines = data.posts[0].lines.map(line => line.replace('占6★出率的70%', '占6★出率的80%')); },
    data => { data.posts[0].lines = data.posts[0].lines.map(line => line.replace('200寻访数据契约', '150寻访数据契约')); },
    data => { data.posts[0].lines = data.posts[0].lines.filter(line => !line.startsWith('★★★★★★（200')); },
    data => { data.posts[0].lines = data.posts[0].lines.map(line => line.replace('5倍权值', '10倍权值')); },
    data => { data.posts[0].lines = data.posts[0].lines.map(line => line.replace('新约能天使', '不认识的干员')); },
    data => { data.operators = data.operators.filter(op => op.internalName !== 'char_1045_svash2'); },
  ];
  for (const change of changes) {
    const data = input();
    data.previous = reconcilePullOdds(data).rules;
    change(data);
    const result = reconcilePullOdds(data);
    assert.equal(result.rules.limited[limited], undefined, change.toString());
    assert.equal(result.problems.length, 1, change.toString());
    assert.ok(result.rules.crossover[crossover]);
  }
});

test('a changed crossover guarantee is held instead of reusing the fixed 120-pull model', () => {
  const data = input();
  data.previous = reconcilePullOdds(data).rules;
  data.gacha.gachaPoolClient.find(p => p.gachaPoolId === crossover).linkageRuleId = 'NEW_MECHANIC';
  const result = reconcilePullOdds(data);
  assert.equal(result.rules.crossover[crossover], undefined);
  assert.match(result.problems[0].reason, /unsupported crossover mechanic/);
  assert.ok(result.rules.limited[limited]);
});

test('confirmed Global mechanics supersede a CN forecast and cannot silently reuse different guarantees', () => {
  const data = input();
  data.previous = reconcilePullOdds(data).rules;
  data.banners.find(banner => banner.cnPoolId === limited).globalPoolId = 'LIMITED_EN_FIXTURE';
  const global = { ...structuredClone(data.gacha.gachaPoolClient.find(pool => pool.gachaPoolId === limited)), gachaPoolId: 'LIMITED_EN_FIXTURE' };
  data.globalGacha = { gachaPoolClient: [global] };
  assert.ok(reconcilePullOdds(data).rules.limited[limited]);
  global.limitParam.freeCount = 250;
  const result = reconcilePullOdds(data);
  assert.equal(result.rules.limited[limited], undefined);
  assert.match(result.problems[0].reason, /Global mechanics differ/);
});

test('Joint Operation and Orienteering never import a CN lineup, even under a misleading pool ID', () => {
  const data = input();
  data.banners = data.banners.map((banner, i) => ({ ...banner, pull_type: i ? 'joint' : 'orienteering' }));
  assert.deepEqual(reconcilePullOdds(data).rules, empty());
});

test('missing automatic inputs withdraw previously imported rules but preserve unrelated editorial history', () => {
  const data = input();
  data.previous = reconcilePullOdds(data).rules;
  data.previous.limited.OLD = { name: 'Historical', source: 'https://ak.hypergryph.com/news/1' };
  data.posts = [];
  const result = reconcilePullOdds(data);
  assert.equal(result.problems.length, 2);
  assert.equal(result.rules.limited[limited], undefined);
  assert.deepEqual(result.rules.limited.OLD, data.previous.limited.OLD);
});

test('the scheduled stage writes a complete rule and clears its quarantine after an input recovers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-pull-odds-'));
  try {
    const data = input(), dir = path.join(root, 'data'), tables = path.join(root, 'tables');
    const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    put(path.join(dir, 'pull-odds-rules.json'), empty());
    put(path.join(dir, 'headhunting_banners.json'), data.banners);
    for (const post of data.posts) put(path.join(dir, `official-news/cn/${post.cid}.json`), post);
    for (const op of data.operators) put(path.join(dir, `operators-${op.rarity}star/${op.internalName}.json`), op);
    put(path.join(tables, 'character_table.json'), data.characters);
    put(path.join(tables, 'gacha_table.json'), data.gacha);
    const options = { tableRoot: tables, globalTableRoot: tables };
    assert.equal(syncPullOdds(root, options).held, 0);
    const ruleFile = path.join(dir, 'pull-odds-rules.json'), first = fs.readFileSync(ruleFile, 'utf8');
    syncPullOdds(root, options);
    assert.equal(fs.readFileSync(ruleFile, 'utf8'), first);
    const original = structuredClone(data.gacha);
    data.gacha.gachaPoolClient.find(p => p.gachaPoolId === limited).limitParam.version = 9;
    put(path.join(tables, 'gacha_table.json'), data.gacha);
    assert.equal(syncPullOdds(root, options).held, 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'quarantine.json'))).entries.some(entry => entry.key === `odds:${limited}`));
    put(path.join(tables, 'gacha_table.json'), original);
    assert.equal(syncPullOdds(root, options).held, 0);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'quarantine.json'))).entries.some(entry => entry.stage === 'cn-pull-odds'));
    assert.equal(fs.readFileSync(ruleFile, 'utf8'), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const run = fs.readFileSync(new URL('../content/run-imports.sh', import.meta.url), 'utf8');
  assert.match(run, /stage cn-pull-odds --needs catalogue,upstream-cn,upstream-en -- node scripts\/sync\/sync-pull-odds\.mjs/);
});
