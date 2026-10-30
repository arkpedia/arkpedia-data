#!/usr/bin/env node
import { serverDay, SERVER_TIME } from '../../lib/time/servers.mjs';
/**
 * Add recurring Global Standard and Kernel banners from current sources.
 *
 * The client table is authoritative: a pool it ships is the banner, with its exact
 * start/end timestamps and its pool id (globalPoolId), and for Kernel its rate-up
 * character ids too. Standard rate-ups are not present in the client table, so those
 * names come from the structured yearly banner table on Arknights Terra Wiki and are
 * accepted only when the row has an exact matching client window. This prevents a
 * stale or speculative wiki row from becoming a live countdown.
 *
 * The wiki only enriches. A pool it has no row for is still added when it follows a
 * recorded one (numbered after it; the wiki's own number wins when there is a row).
 * A Standard pool then takes its lineup from the banner's own art in the client
 * (banner-art-lineup.mjs, lineupSource 'client-art'), which ships about two weeks before
 * the wiki's row, or stays 'pending' until one of the two names it. A row that cannot be
 * used -- an unknown name, not two 6-stars and three 5-stars, a Kernel lineup the
 * client contradicts (the client wins), a Standard lineup its art contradicts (the art,
 * published first, stays) -- is reported to the quarantine list under
 * 'recurring-banners', never thrown, as is art that cannot be read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lineupNameLookup, parseWikiRows } from './catalogue-model.mjs';
import { readWikiRows } from './wiki-pages.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { pinnedRef } from '../content/pin-upstream.mjs';
import { lineReader, nameArtUrl, readArtLineup } from './banner-art-lineup.mjs';
import { kernelLocatingNotices, reconcileKernelLocating } from './kernel-locating.mjs';
import { readOfficialNews } from './sync-official-news.mjs';
import { reconcileGlobalClientBanners } from './global-client-banners.mjs';

// At the commit this run pinned (run-stage.mjs), else the branch; a banner created from it
// records that URL as its timingSource.
const CLIENT_BASE = `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/${pinnedRef('ArknightsAssets/ArknightsGamedata')}/en/gamedata/excel`;
const CLIENT_SOURCE = `${CLIENT_BASE}/gacha_table.json`;


function isoEnd(timestamp) {
  return new Date((timestamp + (timestamp % 60 === 59 ? 1 : 0)) * 1000).toISOString();
}

/** The Standard and Kernel rows among the yearly page's parsed Banners cells. */
export function recurringRows(cells) {
  const rows = [];
  for (const row of cells) {
    if (!['standard', 'kernel'].includes(row.type) || !/^\d+$/.test(row.no || '')) continue;
    const start = /^(\d{4}\/\d{2}\/\d{2})\s+\d{2}:\d{2}:\d{2}$/.exec(row.start || '');
    const end = /^(\d{4}\/\d{2}\/\d{2})\s+\d{2}:\d{2}:\d{2}$/.exec(row.end || '');
    const operators = (row.operators || '').split(',').map((name) => name.trim()).filter(Boolean);
    if (!start || !end || operators.length !== 5) continue;
    rows.push({ type: row.type, number: Number(row.no), start: start[1], end: end[1], operators });
  }
  return rows;
}

function clientRows(gachaTable, type) {
  const rule = type === 'standard' ? 'DOUBLE' : 'CLASSIC_DOUBLE';
  return (gachaTable.gachaPoolClient || []).filter((row) => row.gachaRuleType === rule
    && row.openTime && row.endTime && row.endTime - row.openTime <= 15 * 86400);
}

// A pool with no wiki row is added only this long after it opens: enough to ride out a
// wiki outage, never enough to mint the years of pools the bulk import named.
const CREATE_WITHIN = 30 * 86400;
const LABEL = { standard: 'Standard Pool', kernel: 'Kernel' };
const nameFor = (type, number) => `${LABEL[type]} #${number} (Global)`;
const numberOf = (type, name) => {
  const match = new RegExp(`^${LABEL[type]} #(\\d+) \\(Global\\)$`).exec(name ?? '');
  return match ? Number(match[1]) : null;
};

/** The Kernel rate-ups the client names, or null when its metadata is incomplete. */
function namesFromKernelClient(row, characters) {
  const ids = [row.dynMeta?.main6RarityCharId, row.dynMeta?.sub6RarityCharId, ...(row.dynMeta?.rare5CharList || [])];
  return ids.length === 5 && ids.every((id) => id && characters[id]?.name) ? ids.map((id) => characters[id].name) : null;
}

/** Two known 6-stars and three known 5-stars, or why these names are not. */
function splitLineup(names, roster) {
  const unknown = names.filter((name) => ![5, 6].includes(roster.get(name)));
  if (unknown.length) return { problem: `names ${unknown.join(', ')}, which no 5- or 6-star operator record matches` };
  const sixStars = names.filter((name) => roster.get(name) === 6);
  const fiveStars = names.filter((name) => roster.get(name) === 5);
  if (sixStars.length !== 2 || fiveStars.length !== 3) return { problem: 'does not contain two 6-stars and three 5-stars' };
  return { sixStars, fiveStars };
}

/** Why a banner has no lineup: its source's problem, else no usable source. Written the
 *  same on the day the banner is added and every day after (a recorded banner still
 *  pending, and the day-to-day loop below), since data/quarantine.json is a release input:
 *  a change of words alone would make a new release. */
const pendingReason = (name, type, split, subject = type === 'kernel' ? 'lineup' : 'wiki row') => (split?.problem
  ? `${name} is published without its rate-up lineup: the ${subject} ${split.problem}.`
  : `${name} is published without its rate-up lineup, which only ${type === 'kernel' ? 'the client or the wiki\'s yearly banner page supplies' : 'the wiki\'s yearly banner page or the banner\'s art in the client supplies'}.`);

export const parseRecurringWikiRows = (wikitext) => recurringRows(parseWikiRows(wikitext, 'Banners cell'));

/**
 * The banners with every shipped Standard and Kernel pool reconciled. `artLineups` holds
 * what each Standard pool's art names, by pool id (syncRecurringBanners reads it): the
 * lineup, {problem} when it could not be read, or null when the client has no art for it
 * yet. `wantsArt` lists the pools whose lineup would come from their art and which
 * `artLineups` does not answer for: read them and reconcile again.
 */
export function reconcileRecurringBanners({ banners, gachaTable, characters, wikiRows: rawWikiRows, roster, artLineups = new Map(), now = Date.now() }) {
  // The wiki's names as the records spell them, whatever their word order
  // (lineupNameLookup); a name no record answers to stays as written, and is reported.
  const recordName = lineupNameLookup([...roster.keys()].map((name) => [name, name]));
  const wikiRows = rawWikiRows.map((row) => ({ ...row, operators: row.operators.map((name) => recordName(name) ?? name) }));
  const next = structuredClone(banners);
  const additions = [], quarantine = [], wantsArt = new Set();
  let changed = false;
  const report = (client, action, reason) => quarantine.push({ key: `banner:${client.gachaPoolId}`, action, reason, sourceRef: CLIENT_SOURCE });

  for (const type of ['standard', 'kernel']) {
    const shipped = clientRows(gachaTable, type).sort((a, b) => a.openTime - b.openTime);
    const windowOf = (row) => `${serverDay(row.openTime, SERVER_TIME.en.offset)}–${serverDay(row.endTime, SERVER_TIME.en.offset)}`;
    const recordOf = (client) => next.find((banner) => banner.globalPoolId === client.gachaPoolId)
      ?? next.find((banner) => numberOf(type, banner.name) != null && banner.global_date === windowOf(client));
    /* A Kernel pool's rate-ups as the client names them, when its metadata is complete. The
       client wins, and a wiki row that disagrees is reported, every day it does. */
    const clientLineup = (client, wiki, name) => {
      const clientNames = type === 'kernel' ? namesFromKernelClient(client, characters) : null;
      if (clientNames && wiki && (new Set(clientNames).size !== wiki.operators.length || wiki.operators.some((operator) => !clientNames.includes(operator)))) {
        report(client, 'published-partial', `${name}: the wiki's rate-ups (${wiki.operators.join(', ')}) disagree with the client's (${clientNames.join(', ')}); the client's are published.`);
      }
      return clientNames;
    };
    /* A Standard pool's lineup as its art names it, for a pool with no wiki row: the names in
       plate order (the two 6-stars, then the three 5-stars), {problem}, or null when the art
       is not out yet or not read yet (then wantsArt asks for it). */
    const artLineup = (client) => {
      if (type !== 'standard') return null;
      if (!artLineups.has(client.gachaPoolId)) { wantsArt.add(client.gachaPoolId); return null; }
      const art = artLineups.get(client.gachaPoolId);
      return art?.problem ? art : art ? { names: [...art.sixStars, ...art.fiveStars] } : null;
    };
    /* The lineup a pool's banner takes, the same on the day it is added and every day after:
       for Kernel the client's (clientLineup), else the wiki row's, else for Standard its art's. */
    const lineupOf = (client, wiki, name) => {
      const clientNames = clientLineup(client, wiki, name);
      const art = clientNames || wiki ? null : artLineup(client);
      if (art?.problem) {
        report(client, 'published-partial', `${name} is published without its rate-up lineup: ${art.problem}.`);
        return { split: null, source: 'pending' };
      }
      const names = clientNames ?? wiki?.operators ?? art?.names ?? null;
      const source = clientNames ? 'client' : wiki ? 'wiki' : art ? 'client-art' : 'pending';
      const split = names ? splitLineup(names, roster) : null;
      if (!split || split.problem) {
        // No split: the day-to-day loop below reports it, in the same words.
        if (split) report(client, 'published-partial', pendingReason(name, type, split, art ? 'banner art' : undefined));
        return { split, source: 'pending' };
      }
      return { split, source };
    };
    shipped.forEach((client, i) => {
      const wiki = wikiRows.find((row) => row.type === type && row.start === serverDay(client.openTime, SERVER_TIME.en.offset) && row.end === serverDay(client.endTime, SERVER_TIME.en.offset));
      const recorded = recordOf(client) ?? (wiki ? next.find((banner) => banner.name === nameFor(type, wiki.number)) : null);
      if (recorded) {
        // A banner added before its lineup was known takes it once it is: a Standard one
        // from its wiki row or its art, a Kernel one from the client, as when it was added.
        if (recorded.lineupSource === 'pending') {
          const { split, source } = lineupOf(client, wiki, recorded.name);
          if (source !== 'pending') {
            Object.assign(recorded, { five_stars: split.fiveStars, six_stars: split.sixStars, lineupSource: source });
            changed = true;
          }
        } else if (recorded.lineupSource === 'client') {
          // Published from the client: a wiki row that disagrees stays reported until it agrees.
          clientLineup(client, wiki, recorded.name);
        } else if (recorded.lineupSource === 'client-art' && wiki) {
          // Published from the art: the same, against the names the record carries. Nothing
          // is read again, so a later read cannot change a published lineup.
          const art = [...recorded.six_stars, ...recorded.five_stars];
          if (new Set(art).size !== wiki.operators.length || wiki.operators.some((operator) => !art.includes(operator))) {
            report(client, 'published-partial', `${recorded.name}: the wiki's rate-ups (${wiki.operators.join(', ')}) disagree with the banner art's (${art.join(', ')}); the art's are published.`);
          }
        }
        return;
      }
      // With no wiki row, only a recent pool that follows a recorded one is added, and it
      // takes the next number; anything older is history this importer never mints.
      const previous = shipped[i - 1] && recordOf(shipped[i - 1]);
      const number = wiki?.number ?? (numberOf(type, previous?.name) != null ? numberOf(type, previous.name) + 1 : null);
      if (!wiki && client.openTime < Math.floor(now / 1000) - CREATE_WITHIN) return;
      const name = number != null ? nameFor(type, number) : null;
      if (!name || next.some((banner) => banner.name === name)) {
        report(client, 'omitted-new', `${LABEL[type]} pool ${client.gachaPoolId} (${windowOf(client)}) has no wiki row, and ${name ? `${name} is already another window's name` : 'the pool before it has no record to number it after'}, so it is not added.`);
        return;
      }

      const { split, source: lineupSource } = lineupOf(client, wiki, name);
      const imageName = name.replace('#', '');
      next.push({
        name,
        category: type === 'standard' ? 'standard_pool' : 'kernel',
        cn_date: null,
        global_date: windowOf(client),
        global_date_estimated: false,
        global_window: {
          startAt: new Date(client.openTime * 1000).toISOString(),
          endAt: isoEnd(client.endTime),
          timingSource: CLIENT_SOURCE,
        },
        banner_image: `/headhunting-banner-images/${imageName}.webp`,
        year: Number(serverDay(client.openTime, SERVER_TIME.en.offset).slice(0, 4)),
        four_stars: [],
        five_stars: lineupSource === 'pending' ? [] : split.fiveStars,
        rate_up_six_stars: [],
        six_stars: lineupSource === 'pending' ? [] : split.sixStars,
        pull_type: type,
        linked_event: null,
        globalPoolId: client.gachaPoolId,
        lineupSource,
      });
      additions.push(name);
      changed = true;
    });
  }
  // A lineup still pending stays on the list until the wiki row fills it in.
  for (const banner of next) {
    if (banner.lineupSource === 'pending' && banner.globalPoolId && !quarantine.some((entry) => entry.key === `banner:${banner.globalPoolId}`)) {
      quarantine.push({ key: `banner:${banner.globalPoolId}`, action: 'published-partial', sourceRef: CLIENT_SOURCE,
        reason: pendingReason(banner.name, banner.pull_type) });
    }
  }
  return { banners: next, additions, quarantine, changed, wantsArt: [...wantsArt] };
}

async function json(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Arkpedia-refresh/1.0 (+https://arkpedia.net)' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** A name plate's PNG bytes, or null when the client has none at that path (404). */
async function nameArt(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Arkpedia-refresh/1.0 (+https://arkpedia.net)' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * What each pool's art names (see reconcileRecurringBanners' artLineups). Art that cannot
 * be downloaded is a problem for that pool, reported like art that cannot be read, so a
 * day the mirror is down still updates every banner's window.
 */
export async function readArtLineups(poolIds, roster, fetchArt = nameArt) {
  const lineups = new Map();
  const reader = await lineReader();
  try {
    for (const poolId of poolIds) {
      try {
        const art = await readArtLineup({ roster, reader, fetchImage: (slot) => fetchArt(nameArtUrl(poolId, slot)) });
        lineups.set(poolId, art && (art.problem ? { problem: art.problem } : { sixStars: art.sixStars, fiveStars: art.fiveStars }));
        if (art) console.log(`${poolId}: the banner art reads ${art.reads.map((read) => `"${read.text}"`).join(', ')}`);
      } catch (error) {
        console.warn(`${poolId}: cannot read the banner art: ${error.message}`);
        lineups.set(poolId, { problem: 'its banner art could not be downloaded' });
      }
    }
  } finally {
    await reader.close();
  }
  return lineups;
}

async function readTable(root, file) {
  const cached = path.join(root, '.cache/upstream/en-gamedata/en/gamedata/excel', file);
  try {
    // This command is also useful standalone. Prefer the current published
    // table so a stale local cache cannot hide the banner that triggered the
    // refresh; the workflow cache remains a network-failure fallback.
    return await json(`${CLIENT_BASE}/${file}`);
  } catch (error) {
    if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
    throw error;
  }
}

export async function syncRecurringBanners(root = process.cwd(), now = new Date()) {
  const bannersAt = path.join(root, 'data/headhunting_banners.json');
  const operatorFolders = fs.readdirSync(path.join(root, 'data')).filter((name) => /^operators-[1-6]star$/.test(name));
  const roster = new Map();
  const operators = [];
  for (const folder of operatorFolders) {
    for (const file of fs.readdirSync(path.join(root, 'data', folder)).filter((name) => name.endsWith('.json'))) {
      const operator = JSON.parse(fs.readFileSync(path.join(root, 'data', folder, file), 'utf8'));
      roster.set(operator.name, operator.rarity);
      operators.push(operator);
    }
  }
  // One clock names the year's page and decides whether its absence is excused, and
  // the page is read under the same rule as sync-catalogue.mjs's copy of it: a page the
  // wiki cannot serve today is read from its last good copy and reported, not thrown.
  const alerts = beginStage(root, 'recurring-banners', now);
  const page = `Headhunting/Banners/${now.getUTCFullYear()}`;
  const [gachaTable, characters, cells] = await Promise.all([
    readTable(root, 'gacha_table.json'),
    readTable(root, 'character_table.json'),
    readWikiRows(root, page, 'Banners cell', { now, alerts }),
  ]);
  const banners = JSON.parse(fs.readFileSync(bannersAt, 'utf8'));
  const input = { banners, gachaTable, characters, wikiRows: recurringRows(cells), roster, now: now.getTime() };
  let result = reconcileRecurringBanners(input);
  // Most days no pool needs its art read, and no reader is started.
  if (result.wantsArt.length) result = reconcileRecurringBanners({ ...input, artLineups: await readArtLineups(result.wantsArt, roster) });
  // Kernel Locating, Global's own kind (kernel-locating.mjs): the client, then the official
  // posts this content run's previous official-news stage cached, then the wiki rows.
  const posts = readOfficialNews(root);
  const recordName = lineupNameLookup([...roster.keys()].map((name) => [name, name]));
  const locating = reconcileKernelLocating({ banners: result.banners, gachaTable, characters, notices: kernelLocatingNotices(posts),
    wikiRows: cells, roster, recordName, clientSource: CLIENT_SOURCE, now: now.getTime() });
  // Last: wiki/CN catalogue enrichment must never overwrite a shipped EN candidate pool.
  const global = reconcileGlobalClientBanners({ banners: result.banners, gachaTable, operators, posts, clientSource: CLIENT_SOURCE, now: now.getTime() });
  if (result.changed || locating.changed || global.changed) fs.writeFileSync(bannersAt, `${JSON.stringify(result.banners, null, 2)}\n`);
  for (const entry of [...result.quarantine, ...locating.quarantine, ...global.quarantine]) alerts.add(entry);
  result.additions.push(...locating.additions, ...global.additions);
  alerts.commit();
  return result.additions;
}

// No top-level await, so the tests can import this module as they compile it.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  syncRecurringBanners().then((additions) => {
    console.log(additions.length ? `Added recurring banners:\n${additions.map((name) => `  + ${name}`).join('\n')}` : 'Recurring banners are current.');
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
