#!/usr/bin/env node
import { SERVER_TIME } from '../../lib/time/servers.mjs';
/** Discover campaigns from official regional news and the KR official event board.
 * Read-only GET/HEAD; campaign HTML/JSON/entry scripts are read as text, never executed.
 * A regional counterpart is only a candidate until its own canonical URL and rules agree.
 * Unreadable or ambiguous campaigns keep their previous record and enter quarantine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeEntities, newsLines } from '../build/official-news.mjs';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';

export const OUTPUT = 'data/community-web-events.json';
export const REGIONS = [
  { id: 'en', domain: 'arknights.global', region: 'Global (EN)', offset: SERVER_TIME.en.offset, zone: 'UTC−7' },
  { id: 'kr', domain: 'arknights.kr', region: 'Korea (KR)', offset: SERVER_TIME.kr.offset, zone: 'KST' },
  { id: 'jp', domain: 'arknights.jp', region: 'Japan (JP)', offset: SERVER_TIME.jp.offset, zone: 'JST' },
];
const MAX_BYTES = 5_000_000;
const RECENT = 180 * 86400_000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const BOARD = 'https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/29703924';
const byUrl = (a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0;

export function campaignUrl(value, region) {
  try {
    const url = new URL(decodeEntities(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!url.hostname.endsWith(`.${region.domain}`)) return null;
    const subdomain = url.hostname.slice(0, -region.domain.length - 1);
    if (!/^[a-z0-9-]+$/.test(subdomain) || /^(www|user|account|support|login|store|wiki|mail|api)$/.test(subdomain)) return null;
    // Campaign entry links: do not crawl account, participation or sharing actions.
    if (url.pathname !== '/' && !/^\/index\.html$/.test(url.pathname)) return null;
    return `${url.origin}/`;
  } catch { return null; }
}

export function campaignLinks(text, region) {
  const unescaped = String(text).replaceAll('\\/', '/');
  return [...new Set([...unescaped.matchAll(/https:\/\/[^\s"'<>\\]+/g)].map(match => campaignUrl(match[0], region)).filter(Boolean))];
}

function meta(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), decodeEntities(m[2])]));
    if (attrs.property === name || attrs.name === name) return attrs.content;
  }
}
export function officialMedia(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.port && !u.username && !u.password && u.hostname === 'webusstatic.yo-star.com'; } catch { return false; }
}
function stamp(year, month, day, hour = 0, minute = 0, offset = 0) {
  const ms = Date.UTC(+year, +month - 1, +day, +hour, +minute);
  const local = new Date(ms);
  if (local.getUTCFullYear() !== +year || local.getUTCMonth() !== +month - 1 || local.getUTCDate() !== +day || +hour > 23 || +minute > 59) throw new Error('Invalid campaign date');
  return { date: local.toISOString().slice(0, 10), time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, ms: ms - offset * 3600_000 };
}

/** Only the campaign's duration/rules field, not reward-claim or shipping dates. */
export function campaignWindow(text, region) {
  text = String(text).replaceAll('\\"', '"');
  const durations = [...text.matchAll(/"duration"\s*:\s*\[\s*"([^"\n]+)"/g)].map(m => m[1]);
  // Static HTML campaigns may put their rules directly in the page.
  durations.push(...newsLines(text).filter(line => /^(?:DURATION|EVENT (?:PERIOD|DURATION)|開催期間|イベント期間|이벤트 (?:시간|기간))\s*[:：]/i.test(line)));
  const windows = new Map();
  for (const duration of durations) {
    const statedZone = duration.match(/UTC\s*([+\-−])\s*(\d{1,2})/i);
    if (statedZone && Number(`${statedZone[1] === '+' ? '+' : '-'}${statedZone[2]}`) !== region.offset) continue;
    let start, end, exactStart = true;
    if (region.id === 'en' && /UTC\s*[-−]\s*7/.test(duration)) {
      const numeric = [...duration.matchAll(/(\d{1,2})\/(\d{1,2}),?\s*(\d{4}),?\s*(\d{1,2}):(\d{2})(?!:)/g)];
      if (numeric.length === 2) {
        [start, end] = numeric.map(m => stamp(m[3], m[1], m[2], m[4], m[5], region.offset));
      } else {
        const named = [...duration.matchAll(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})(?!:)/g)];
        if (named.length === 2) [start, end] = named.map(m => stamp(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2], m[4], m[5], region.offset));
        else {
          // Year first, as Kal'tsit's Archives' rules give it: "2026/10/13-2026/10/19 12:59
          // (UTC-7)". The end needs its time; a start without one opens that day (no opensAt).
          const ymd = [...duration.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:,?\s*(\d{1,2}):(\d{2})(?!:))?/g)];
          if (ymd.length === 2 && ymd[1][4] != null) {
            exactStart = ymd[0][4] != null;
            [start, end] = ymd.map(m => stamp(m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, region.offset));
          }
        }
      }
    } else if (region.id !== 'en') {
      const local = [...duration.matchAll(/(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일](?:\s*(?:（[^）]*）|\([^)]*\))?\s*(\d{1,2}):(\d{2})(?!:))?/g)];
      if (local.length === 2 && local[1][4] != null) {
        exactStart = local[0][4] != null;
        [start, end] = local.map(m => stamp(m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, region.offset));
      }
    }
    if (!start || !end) continue;
    if (end.ms < start.ms || end.ms - start.ms > RECENT) throw new Error('Implausible campaign window');
    const window = { start: start.date, end: end.date, ...(exactStart ? { opensAt: new Date(start.ms).toISOString() } : {}), closingTime: `${end.time} (${region.zone})`, expiresAt: new Date(end.ms + 60_000).toISOString() };
    windows.set(JSON.stringify(window), window);
  }
  if (windows.size !== 1) throw new Error(windows.size ? 'Conflicting campaign windows' : 'No complete campaign window');
  return [...windows.values()][0];
}

async function read(url, fetcher, acceptJson = false) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Arkpedia-refresh/1.0 (+https://arkpedia.net)', accept: acceptJson ? 'application/json' : 'text/html,application/javascript,application/json' } });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${url}`), { status: response.status });
  if (+response.headers?.get('content-length') > MAX_BYTES) throw new Error('Campaign response too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Campaign response too large');
  return acceptJson ? JSON.parse(text) : text;
}

export async function readCampaign(url, region, { fetcher = globalThis.fetch, sourceUrl = url } = {}) {
  const html = await read(url, fetcher);
  if (campaignUrl(meta(html, 'og:url'), region) !== url) throw new Error('Campaign canonical URL is missing or differs');
  const name = (meta(html, 'og:title') ?? html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '').trim();
  if (!name || name.length > 100) throw new Error('Campaign title is missing');
  const texts = [html];
  // Read first-party entry scripts as text. Ignore analytics, login SDKs and runtime vendors.
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => new URL(decodeEntities(m[1]), url).href)
    .filter(script => !script.includes('/websdk/') && (new URL(script).origin === new URL(url).origin || officialMedia(script)) && /\/(?:index|main|app)[^/]*\.js(?:\?|$)/i.test(script)).slice(0, 4);
  for (const script of scripts) texts.push(await read(script, fetcher));
  let window;
  try { window = campaignWindow(texts.join('\n'), region); }
  catch (error) { error.verifiedCampaign = true; throw error; }
  const image = meta(html, 'og:image');
  let verifiedImage;
  if (officialMedia(image)) {
    try {
      const response = await fetcher(image, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (response.ok && /^image\//.test(response.headers.get('content-type') ?? '')) verifiedImage = image;
    } catch { /* A missing image never hides a verified campaign. */ }
  }
  return { name: decodeEntities(name), region: region.region, ...window, url, ...(verifiedImage ? { image: verifiedImage } : {}), sourceUrl };
}

export async function discoverCampaigns({ fetcher = globalThis.fetch, now = defaultNow().getTime(), report = () => {} } = {}) {
  const candidates = new Map();
  const add = (text, region, sourceUrl) => { for (const url of campaignLinks(text, region)) if (!candidates.has(url)) candidates.set(url, { region, sourceUrl, announced: true }); };
  for (const region of REGIONS) {
    const base = `https://www.${region.domain}`;
    // Bound the archive walk. Already discovered campaigns are rechecked separately.
    for (const kind of ['home', 'news/list?index=1&size=30&type=latest']) {
      const url = `${base}/api/resource/${kind}`;
      try {
        const body = await read(url, fetcher, true);
        if (body.code !== 0 || !body.data) throw new Error('Invalid official feed');
        const rows = body.data.rows;
        if (kind.startsWith('news') && !Array.isArray(rows)) throw new Error('Invalid news rows');
        if (rows) {
          for (const row of rows) if (Number.isFinite(row.publishTime) && row.publishTime >= now - RECENT) add(JSON.stringify(row), region, `${base}/news/${row.id}`);
        } else add(JSON.stringify(body.data), region, url);
      } catch (error) { console.warn(error.message); report(`source:${region.id}:${kind.split('/')[0]}`, 'The official regional feed could not be read; previously verified campaigns stand.', url); }
    }
  }
  // KR's own website directs announcements to this official cafe (event board 3).
  for (const route of ['menus/3/articles?page=1&pageSize=30', 'notices/menus/3']) {
    const source = `${BOARD}/${route}`;
    try {
      const body = await read(source, fetcher, true);
      if (!Array.isArray(body.result?.articleList)) throw new Error('Invalid Korean official board');
      for (const entry of body.result.articleList) {
        const post = entry.item;
        if (post?.menuId !== 3 || !Number.isSafeInteger(post.articleId) || !Number.isFinite(post.writeDateTimestamp) || post.writeDateTimestamp < now - RECENT || !/웹|web/i.test(post.subject)) continue;
        const url = `https://cafe.naver.com/f-e/cafes/29703924/articles/${post.articleId}`;
        if ([...candidates.values()].some(candidate => candidate.sourceUrl === url)) continue;
        const article = await read(`https://article.cafe.naver.com/gw/v4/cafes/29703924/articles/${post.articleId}`, fetcher, true);
        if (article.result?.article?.menu?.id !== 3 || typeof article.result.article.contentHtml !== 'string') throw new Error('Invalid official Korean article');
        add(article.result.article.contentHtml, REGIONS.find(region => region.id === 'kr'), url);
      }
    } catch (error) { console.warn(error.message); report('source:kr:cafe', 'The official Korean event board could not be read completely; previously verified campaigns stand.', source); }
  }
  // A link announced in one region can reveal its localized siblings. No record is
  // published on naming alone: readCampaign requires that sibling's own URL and rules.
  for (const [url, { region, sourceUrl }] of [...candidates]) {
    const label = new URL(url).hostname.slice(0, -region.domain.length - 1);
    for (const sibling of REGIONS) {
      const candidate = `https://${label}.${sibling.domain}/`;
      if (!candidates.has(candidate)) candidates.set(candidate, { region: sibling, sourceUrl, announced: false });
    }
  }
  return candidates;
}

export async function syncWebEvents(root, { fetcher = globalThis.fetch, now = defaultNow().getTime(), seeds } = {}) {
  // The record is the only source: what a previous run verified is what this run starts from.
  const fallback = seeds ?? [];
  const at = path.join(root, OUTPUT);
  const prior = fs.existsSync(at) ? JSON.parse(fs.readFileSync(at, 'utf8')) : [];
  const events = new Map([...fallback, ...prior].map(event => [event.url, event]));
  const stage = beginStage(root, 'community-web-events', now);
  const report = (key, reason, sourceRef, action = 'kept-previous') => stage.add({ key, reason, sourceRef, action });
  const candidates = await discoverCampaigns({ fetcher, now, report });
  for (const event of events.values()) {
    // Closed campaigns are retained as history, but no longer polled forever.
    if (Date.parse(event.expiresAt) <= now) continue;
    const region = REGIONS.find(region => campaignUrl(event.url, region));
    if (region && !candidates.has(event.url)) candidates.set(event.url, { region, sourceUrl: event.sourceUrl ?? event.url, announced: true });
  }
  for (const [url, { region, sourceUrl, announced }] of [...candidates].sort(([a], [b]) => a < b ? -1 : 1)) {
    try {
      const event = await readCampaign(url, region, { fetcher, sourceUrl });
      events.set(url, event);
      if (!event.image) report(`art:${url}`, 'The official campaign artwork is unavailable; the verified event is published without art.', url, 'published-partial');
    }
    catch (error) {
      console.warn(`Web campaign ${url}: ${error.message}`);
      // Some campaigns publish their rules only as an image (Kal'tsit's Archives, 2026-10-13):
      // the page verifies (canonical URL and title) but holds no text window. A record whose
      // window was read from that official rules image by a person (windowSource) stands as
      // it is, rather than being reported every night; a page that stops verifying still is.
      const prior = events.get(url);
      if (prior?.windowSource && error.verifiedCampaign && /campaign window/.test(error.message)) continue;
      // An absent sibling is normal; an announced or already published page needs review.
      if (announced || events.has(url) || error.verifiedCampaign) report(`campaign:${url}`, 'The campaign canonical URL or regional rules could not be verified; no dates were inferred.', sourceUrl, events.has(url) ? 'kept-previous' : 'omitted-new');
    }
  }
  const output = [...events.values()].sort(byUrl);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, `${JSON.stringify(output, null, 2)}\n`);
  stage.commit();
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) syncWebEvents(process.cwd()).then(events => console.log(`Web campaigns: ${events.length} verified records.`)).catch(error => { console.error(error); process.exitCode = 1; });
