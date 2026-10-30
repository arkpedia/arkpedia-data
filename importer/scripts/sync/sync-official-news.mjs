#!/usr/bin/env node
/**
 * Caches Arknights Global's official event announcements into data/official-news/global/<id>.json
 * ({ id, title, publishTime, url, lines, art }), for build-event-rewards.mjs to read packs, gifts and
 * the like from (scripts/build/official-news.mjs). `art` is where the post's pictures stand
 * ({ url, line }, newsArt): their addresses on the website's own image host, never the pictures;
 * a post cached before it gets it when it is next fetched (within RETRY_DAYS, or the Sunday walk). The official website is a source the user named
 * for news (2026-10-03), ahead of the wiki.
 *
 * Reads the public list, newest first, page by page until a page holds nothing new, and fetches
 * each uncached or recent event post. Recent posts are refetched for corrections; the weekly
 * archive walk also revisits older posts, back to January 2020.
 * GET only. A day the list cannot be read is reported to the quarantine list (stage
 * official-news) and the cached posts stand.
 *
 * Posts are fetched OLDEST first. The paging stops at the first page with nothing new, so a gap
 * left behind cached posts is never paged to again: fetched newest first, a run that stopped
 * part-way (a timeout, a crash) cached the newest posts and left the older ones unread for good.
 * Oldest first, the gap is at the newest end, where the next run's first page finds it.
 *
 * A gap the newest-first code may already have left at the older end, behind a page with nothing
 * new, is healed once a week: on a Sunday (UTC, of the run's `now`) the paging walks every page
 * whatever it finds, one list GET per thirty posts of the archive, and fetches every event post.
 * This reads no total from the list to compare the cache with, so the walk goes by
 * the day.
 *
 * One post that cannot be read (an error page, a body the parser cannot take) is that post's
 * problem: it is reported as official-news:<id> and the rest are still fetched. Its entry is what
 * brings it back: each run asks again for every post the last run reported, wherever it now sits
 * in the list, until one reads it -- for RETRY_DAYS from the day it was first reported, or until
 * the site answers 404 for one today's pages do not list. A post the site deleted is never listed
 * again, and was asked for, and reported, every night for good. One still listed is asked for
 * whenever its page is read, however old its entry: it exists, and its packs are missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { newsArt, newsLines } from '../build/official-news.mjs';
import { beginStage, defaultNow, readQuarantine } from '../lib/quarantine.mjs';

const API = 'https://www.arknights.global/api/resource/news';
export const NEWS_DIR = 'data/official-news/global';
// A cached post is <id>.json; nothing else in the directory is one.
const POST_FILE = /^\d+\.json$/;
const PAGE = 30;

async function getJson(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Arkpedia-refresh/1.0 (+https://arkpedia.net)' } });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  const body = await response.json();
  if (body?.code !== 0 || !body.data) throw new Error('unexpected response');
  return body.data;
}

/** The cached posts, for build-event-rewards.mjs, in file-name order; none before the first sync. */
export function readOfficialNews(root) {
  const dir = path.join(root, NEWS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => POST_FILE.test(file)).sort().map(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

export const STAGE = 'official-news';
const POST_KEY = /^official-news:(\d+)$/;
const postUrl = id => `https://www.arknights.global/news/${id}`;
const DAY = 86_400_000;
/** How long a post the last runs could not read is asked for again when no page read lists it. */
export const RETRY_DAYS = 30;
/** The stage's per-post entries a run still asks about at `now` (ms): the others are given up. */
export const retriedPosts = (entries, now) => entries.filter(entry => entry.stage === STAGE && POST_KEY.test(entry.key)
  && !(now - Date.parse(entry.firstSeen) >= RETRY_DAYS * DAY));
/** The weekday (UTC, 0 = Sunday) a run walks every list page (see the top). */
export const FULL_WALK_DAY = 0;
/** The most list pages a run reads (1,500 posts): a list that never ends does not hold the run. */
const MAX_PAGES = 50;

/** The posts cached: { fresh: how many this run added, unreadable: [{ id, title, url }] }.
 *  Throws only when the list itself cannot be read. */
export async function syncOfficialNews(root, { fetcher = globalThis.fetch, now = defaultNow().getTime(), pause = () => new Promise(resolve => setTimeout(resolve, 300)) } = {}) {
  const dir = path.join(root, NEWS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const cached = new Set(fs.readdirSync(dir).filter(file => POST_FILE.test(file)).map(file => Number(file.slice(0, -5))));
  // The posts the last run could not read, asked for again whether or not today's pages reach them,
  // for RETRY_DAYS (see the top); given up after, which drops its entry.
  const reported = readQuarantine(root).entries;
  const asked = new Set(retriedPosts(reported, now));
  const retry = [...asked].map(entry => Number(entry.key.match(POST_KEY)[1])).filter(id => !cached.has(id));
  const walkAll = new Date(now).getUTCDay() === FULL_WALK_DAY;
  const fresh = [];
  for (let index = 1; index <= MAX_PAGES; index++) {
    // A moment between list pages: a Sunday walk reads every one of them back to back otherwise.
    if (index > 1) await pause();
    const { rows } = await getJson(`${API}/list?index=${index}&size=${PAGE}&type=latest`, fetcher);
    if (!Array.isArray(rows) || !rows.length) break;
    const unseen = rows.filter(row => row.type === 'event' && (!cached.has(row.id) || walkAll || (Number.isFinite(row.publishTime) && now - row.publishTime < RETRY_DAYS * DAY)));
    fresh.push(...unseen);
    if (!unseen.length && index > 1 && !walkAll) break;
    if (rows.length < PAGE) break;
  }
  const listed = new Set(fresh.map(row => row.id));
  // A given-up post is said once in the log, on the run that drops its entry: only one no page read
  // today lists. One still listed is asked for below, and reported again if it still fails, however
  // old its entry; said of every given-up entry, the warning printed every night for such a post.
  for (const entry of reported) {
    if (entry.stage !== STAGE || !POST_KEY.test(entry.key) || asked.has(entry)) continue;
    const id = Number(entry.key.match(POST_KEY)[1]);
    if (!listed.has(id) && !cached.has(id)) console.warn(`Official news post ${id}, unread since ${entry.firstSeen}, is no longer asked for: no page read today lists it.`);
  }
  // Oldest first (see the top): the list is newest first. A post asked for again that today's pages
  // do not list is `unlisted`.
  const queue = [...retry.filter(id => !listed.has(id)).sort((a, b) => a - b).map(id => ({ id, unlisted: true })), ...fresh.reverse()];
  const unreadable = [];
  let written = 0;
  for (const row of queue) {
    try {
      const post = await getJson(`${API}/detail?id=${row.id}`, fetcher);
      const record = { id: post.id ?? row.id, title: post.title ?? row.title, publishTime: post.publishTime ?? row.publishTime, url: postUrl(row.id), lines: newsLines(post.content), art: newsArt(post.content) };
      const file = path.join(dir, `${record.id}.json`);
      const text = `${JSON.stringify(record, null, 1)}\n`;
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { fs.writeFileSync(file, text); written++; }
    } catch (error) {
      // Unlisted and not found: the site deleted it. A listed post exists whatever its detail
      // answers (a detail endpoint that moved answers 404 for every post, and is reported).
      if (row.unlisted && error.status === 404) console.warn(`Official news post ${row.id} is gone from the site (HTTP 404, and no page lists it): no longer asked for.`);
      else {
        console.warn(`Official news post ${row.id} could not be read: ${error.message}`);
        unreadable.push({ id: row.id, title: row.title ?? null, url: postUrl(row.id) });
      }
    }
    await pause();
  }
  return { fresh: written, unreadable };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const now = defaultNow();
  // What the last run reported for single posts and still asks about: unread, whatever stops
  // today's run. The ones given up are not carried over either.
  const unread = retriedPosts(readQuarantine(root).entries, now.getTime());
  const stage = beginStage(root, STAGE, now);
  // The words name the post by its address alone: a post asked for again from the quarantine has
  // no title from the list, and the entry must read the same every day it stays unread.
  const unreadPost = ({ id, url }) => ({ key: `official-news:${id}`, action: 'omitted-new', sourceRef: url,
    reason: `The official Global announcement ${url} could not be read; its packs and gifts are left out until a later run reads it.` });
  syncOfficialNews(root, { now: now.getTime() }).then(({ fresh, unreadable }) => {
    for (const post of unreadable) stage.add(unreadPost(post));
    console.log(`Official news: ${fresh} new post(s)${unreadable.length ? `, ${unreadable.length} unreadable` : ''}.`);
    stage.commit();
  }, error => {
    console.error(error);
    stage.add({ key: 'official-news:global', action: 'kept-previous', reason: 'The official Global news could not be read; the cached announcements stand.' });
    // Not asked for today, so still unread: their entries stand, and the next run asks again.
    for (const { key, action, reason, sourceRef } of unread) stage.add({ key, action, reason, sourceRef });
    stage.commit();
  });
}
