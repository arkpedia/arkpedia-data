/** Import the planner's supported CN mechanics from official announcements, checked
 * against the pinned client and stable character IDs. No regional JO/Orienteering
 * roster inference and no guesses for a new guarantee or exchange format. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cnSections, cnWindow, windowDays } from '../build/cn-news.mjs';
import { readCnNews } from './sync-cn-news.mjs';
import { beginStage } from '../lib/quarantine.mjs';

const check = (ok, why) => { if (!ok) throw new Error(why); };
const clean = name => name.replace(/\[限定\]|［限定］/g, '').trim();
const names = text => text.split(/\s*[/\\／、]\s*/).map(clean).filter(Boolean);
const same = (a, b) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
const unique = list => new Set(list).size === list.length;
const official = url => /^https:\/\/ak\.hypergryph\.com\/news\/\d+(?:\.html)?$/.test(url ?? '');

export function importPoolRules({ banner, pool, post, section, characters, operators }) {
  check(official(post.url), 'not an official CN announcement');
  check(pool.guarantee5Avail === 1 && pool.guarantee5Count === 10, 'unsupported initial ten-pull guarantee');
  const byName = new Map();
  for (const [id, char] of Object.entries(characters)) {
    if (!byName.has(char.name)) byName.set(char.name, []);
    byName.get(char.name).push(id);
  }
  const records = new Map(operators.map(op => [op.internalName, op]));
  const ids = (text, rarity) => names(text).map(name => {
    const matches = (byName.get(name) ?? []).filter(id => characters[id].rarity === `TIER_${rarity}`);
    check(matches.length === 1 && records.has(matches[0]), `unresolved ${rarity}★ character: ${name}`);
    return matches[0];
  });
  const listed = (line, rarity) => {
    const match = line.match(new RegExp(`^★{${rarity}}(?!★)\\s*[：:]\\s*(.+?)\\s*（`));
    return match ? ids(match[1], rarity) : null;
  };
  const lines = section.lines;
  const rate = (rarity, percent) => {
    const rows = lines.filter(line => new RegExp(`占${rarity}★出率的${percent}%`).test(line));
    check(rows.length === 1, `missing or ambiguous ${rarity}★ ${percent}% rate`);
    const result = listed(rows[0], rarity);
    check(result?.length && unique(result), `invalid ${rarity}★ rate-up roster`);
    return result;
  };
  const six = rate(6, pool.gachaRuleType === 'LIMITED' ? 70 : 50), five = rate(5, 50);
  const recordIds = list => list.map(name => {
    const matches = operators.filter(op => op.name === name || op.aliases?.includes(name));
    check(matches.length === 1, `unresolved catalogue operator: ${name}`);
    return matches[0].internalName;
  });
  check(same(six, recordIds(banner.six_stars)) && same(five, recordIds(banner.five_stars)), 'announcement and catalogue lineups differ');
  const base = { name: banner.name, source: post.url };
  if (pool.gachaRuleType === 'LIMITED') {
    check(six.length === 2 && five.length === 1, 'unsupported limited featured roster');
    const param = pool.limitParam;
    check(param?.hasFreeChar === true && param.freeCount === 300 && param.version === 1 && six.includes(param.limitedCharId), 'unsupported limited gift');
    const gifts = lines.map(line => line.match(/累计寻访300次[，,]\s*可以额外获得限定干员([^（(]+)[（(]仅限一次[）)]/)).filter(Boolean);
    check(gifts.length === 1 && same(ids(gifts[0][1], 6), [param.limitedCharId]), 'announcement and client gift differ');
    check(lines.some(line => /本期寻访数据契约交换所可兑换干员/.test(line)), 'missing exchange roster');
    const exchange = {};
    for (const line of lines) {
      const match = line.match(/^(★{5,6})[（(](\d+)寻访数据契约[）)][：:]\s*(.+)$/);
      if (!match) continue;
      const cost = Number(match[2]), rarity = match[1].length;
      check((rarity === 6 && [200, 300].includes(cost)) || (rarity === 5 && cost === 75), 'unsupported exchange cost');
      check(!exchange[cost], 'duplicate exchange tier');
      exchange[cost] = ids(match[3], rarity);
    }
    check(exchange[300]?.length && exchange[200]?.length && same(exchange[75] ?? [], five), 'incomplete exchange roster');
    check(six.every(id => exchange[300].includes(id)), 'featured operators missing from 300-contract tier');
    check(unique([...exchange[300], ...exchange[200], ...exchange[75]]), 'duplicate exchange operator');
    const boostRows = lines.filter(line => /^★★★★★★[：:]/.test(line) && /剩余出率|权值/.test(line));
    const boosted = boostRows.flatMap(line => {
      check(/30%.*5倍权值/.test(line), 'unsupported returning-operator weight');
      return listed(line, 6) ?? [];
    });
    check(unique(boosted) && same(boosted, recordIds(banner.rate_up_six_stars ?? [])), 'returning rate-up roster differs');
    check(boosted.every(id => exchange[300].includes(id)), 'boosted operator missing from exchange roster');
    return { ...base, bonus: param.limitedCharId, returning300: exchange[300].filter(id => !six.includes(id)), returning200: exchange[200] };
  }
  check(pool.gachaRuleType === 'LINKAGE' && pool.linkageRuleId === 'LINKAGE_LOOP6_NEW5', 'unsupported crossover mechanic');
  check(six.length === 1 && [1, 2].includes(five.length) && pool.linkageParam?.loopTarget6Count === 120 && pool.linkageParam.guaranteeTarget6Char === six[0], 'unsupported crossover guarantee');
  check(lines.some(line => /每120次寻访必定能获得干员/.test(line) && /重新累计次数/.test(line)), 'missing repeating 120-pull guarantee');
  check(lines.some(line => /前50次寻访没有获得本期出率上升的5星干员/.test(line) && /下一次招募到的5星干员必定/.test(line)), 'missing 5-star guarantee');
  if (five.length === 2) check(lines.some(line => /另一[位名]/.test(line) && /5星|五星/.test(line)), 'missing other featured 5-star guarantee');
  return base;
}

export function reconcilePullOdds({ previous, banners, posts, gacha, globalGacha, characters, operators }) {
  const rules = structuredClone(previous), problems = [], imported = [];
  check(rules.version === 1 && Array.isArray(gacha.gachaPoolClient), 'unsupported rules/client schema');
  const pools = new Map(gacha.gachaPoolClient.map(pool => [pool.gachaPoolId, pool]));
  for (const banner of banners) {
    const id = banner.cnPoolId;
    // These two kinds are region-specific, even if a CN client ID exists.
    if (['joint', 'orienteering'].includes(banner.pull_type)) continue;
    const kind = id?.startsWith('LIMITED_') ? 'limited' : id?.startsWith('LINKAGE_') ? 'crossover' : null;
    if (!kind) continue; // single-featured mechanics already need no per-pool entry
    const pool = pools.get(id);
    const matches = posts.filter(post => official(post.url)).flatMap(post => cnSections(post).flatMap(section => {
      if (!/寻访/.test(section.title)) return [];
      const time = section.lines.find(line => /^活动时间[：:]/.test(line));
      const window = cnWindow(time, post.displayTime);
      if (!window || windowDays(window).join('–') !== banner.cn_date) return [];
      const name = banner.announcedName ?? pool?.gachaPoolName;
      if (!name || !section.title.includes(`【${name}】`)) return [];
      return [{ post, section }];
    }));
    // Old editorial rules whose announcements are outside the cache stay intact.
    if (!matches.length && !rules[kind][id]?.verification) continue;
    try {
      check(pool && matches.length, 'missing matching announcement/client pool');
      check(pool.gachaRuleType === (kind === 'limited' ? 'LIMITED' : 'LINKAGE'), 'pool kind differs from its ID');
      if (banner.globalPoolId) {
        const global = globalGacha?.gachaPoolClient?.find(item => item.gachaPoolId === banner.globalPoolId);
        check(global, 'confirmed Global pool is missing from the pinned client');
        const mechanic = item => JSON.stringify([item.gachaRuleType, item.guarantee5Avail, item.guarantee5Count,
          item.limitParam?.hasFreeChar, item.limitParam?.freeCount, item.limitParam?.limitedCharId, item.limitParam?.version,
          item.linkageRuleId, item.linkageParam?.guaranteeTarget6Char, item.linkageParam?.loopTarget6Count]);
        check(mechanic(pool) === mechanic(global), 'Global mechanics differ from the CN forecast');
      }
      const parsed = matches.map(({ post, section }) => ({ post, section, rule: importPoolRules({ banner, pool, post, section, characters, operators }) }));
      const mechanics = ({ source: _source, ...rule }) => JSON.stringify(Object.fromEntries(
        Object.entries(rule).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])));
      check(parsed.every(item => mechanics(item.rule) === mechanics(parsed[0].rule)), 'conflicting official announcements');
      const source = banner.cn_window?.timingSource ?? rules[kind][id]?.source;
      const { post, section, rule } = parsed.find(item => item.post.url.replace(/\.html$/, '') === source?.replace(/\.html$/, '')) ?? parsed[0];
      rule.verification = { importer: 'cn-announcement-v1', announcementSha256: createHash('sha256').update(JSON.stringify(section)).digest('hex') };
      rules[kind][id] = rule;
      imported.push(id);
    } catch (error) {
      // A changed announcement must not continue publishing previously accepted odds.
      delete rules[kind][id];
      problems.push({ key: `odds:${id}`, action: 'published-partial', sourceRef: matches[0]?.post.url,
        reason: `${banner.name}: CN odds not imported: ${error.message}; mechanics need review` });
    }
  }
  return { rules, problems, imported };
}

export function syncPullOdds(root, { tableRoot = path.resolve(root, process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata/excel'),
  globalTableRoot = path.resolve(root, process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata', 'en/gamedata/excel') } = {}) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = path.join(root, 'data'), file = path.join(data, 'pull-odds-rules.json');
  const operators = fs.readdirSync(data).filter(dir => /^operators-\dstar$/.test(dir)).flatMap(dir => fs.readdirSync(path.join(data, dir)).filter(name => name.endsWith('.json')).map(name => read(path.join(data, dir, name))));
  const previous = read(file);
  const result = reconcilePullOdds({ previous, banners: read(path.join(data, 'headhunting_banners.json')), posts: readCnNews(root), operators,
    gacha: read(path.join(tableRoot, 'gacha_table.json')), globalGacha: read(path.join(globalTableRoot, 'gacha_table.json')),
    characters: read(path.join(tableRoot, 'character_table.json')) });
  if (JSON.stringify(previous) !== JSON.stringify(result.rules)) fs.writeFileSync(file, JSON.stringify(result.rules, null, 2) + '\n');
  const stage = beginStage(root, 'cn-pull-odds');
  result.problems.forEach(problem => stage.add(problem));
  stage.commit();
  return { imported: result.imported, held: result.problems.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(syncPullOdds(process.cwd())); } catch (error) { console.error(error); process.exitCode = 1; }
}
