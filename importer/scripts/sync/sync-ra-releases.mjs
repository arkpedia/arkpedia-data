#!/usr/bin/env node
import { SERVER_TIME } from '../../lib/time/servers.mjs';
/** Permanent RA themes live in sandbox_perm_table, not activity_table. Import their
 * launch dates by topicId, with no event end date. Global confirmation replaces the
 * schedule's runtime estimate as soon as the English client carries that same ID. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cnTableUrl, pinnedRef } from '../content/pin-upstream.mjs';
import { serverDay } from '../lib/server-day.mjs';

export function reconcileRaReleases(events, cn, en, { cnSource, enSource }, names = {}) {
  for (const [region, table] of [['CN', cn], ['Global', en]]) {
    if (!table?.basicInfo || !Object.keys(table.basicInfo).length) throw new Error(`${region}: missing RA themes`);
    for (const [id, topic] of Object.entries(table.basicInfo)) {
      if (topic.topicId !== id || !topic.topicName || !Number.isFinite(topic.topicStartTime) || topic.topicStartTime <= 0) throw new Error(`${region}: invalid RA theme ${id}`);
    }
  }
  const next = structuredClone(events);
  for (const id of new Set([...Object.keys(cn.basicInfo), ...Object.keys(en.basicInfo)])) {
    const global = en.basicInfo[id], chinese = cn.basicInfo[id];
    const title = global?.topicName ?? names[id]?.name ?? chinese.topicName;
    let event = next.find(e => e.modeId === id);
    if (!event) {
      event = { name: `[Reclamation Algorithm] ${title}`, modeId: id, year: Number(serverDay((global ?? chinese).topicStartTime, global ? SERVER_TIME.en.offset : SERVER_TIME.cn.offset).slice(0, 4)), poster: names[id]?.poster ?? null, cn: { dateRange: null, note: null }, global: { dateRange: null, note: 'Global release unannounced' }, tw: { dateRange: null, note: null }, hasFashionReview: false };
      next.push(event);
    }
    // Once localization ships, use its actual title and timestamp. Unknown themes
    // remain in their native name until a reviewed translation or Global table exists.
    event.name = `[Reclamation Algorithm] ${title}`;
    if (names[id]?.poster) event.poster = names[id].poster;
    for (const [key, topic, source, offset] of [['cn', chinese, cnSource, SERVER_TIME.cn.offset], ['global', global, enSource, SERVER_TIME.en.offset]]) {
      if (!topic) continue; // A missing regional row never deletes a prior confirmation.
      event[key] = { ...event[key], dateRange: null, releaseDate: serverDay(topic.topicStartTime, offset), startAt: new Date(topic.topicStartTime * 1000).toISOString(), timingSource: source, note: null };
    }
  }
  return next;
}

async function table(root, file, source) {
  const at = path.join(root, file);
  if (fs.existsSync(at)) return JSON.parse(fs.readFileSync(at, 'utf8'));
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  return response.json();
}
export async function syncRaReleases(root = process.cwd()) {
  const cnSource = cnTableUrl('excel/sandbox_perm_table.json');
  const enSource = `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pinnedRef('ArknightsAssets/ArknightsGamedata')}/en/gamedata/excel/sandbox_perm_table.json`;
  const [cn, en] = await Promise.all([
    table(root, `${process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource'}/gamedata/excel/sandbox_perm_table.json`, cnSource),
    table(root, `${process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata/en'}/gamedata/excel/sandbox_perm_table.json`, enSource),
  ]);
  const dir = path.join(root, 'data/events');
  const files = fs.readdirSync(dir).filter(f => /^events_\d+\.json$/.test(f));
  const events = files.flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const names = JSON.parse(fs.readFileSync(new URL('../../config/ra-releases.json', import.meta.url), 'utf8'));
  const next = reconcileRaReleases(events, cn, en, { cnSource, enSource }, names);
  for (const year of new Set(next.map(e => e.year))) {
    const at = path.join(dir, `events_${year}.json`);
    const records = next.filter(e => e.year === year);
    if (fs.existsSync(at) && JSON.stringify(JSON.parse(fs.readFileSync(at, 'utf8'))) === JSON.stringify(records)) continue;
    fs.writeFileSync(at, JSON.stringify(records, null, 2) + '\n');
  }
  console.log(`RA launches: ${next.filter(e => e.modeId).length} themes`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) syncRaReleases().catch(error => { console.error(error); process.exitCode = 1; });
