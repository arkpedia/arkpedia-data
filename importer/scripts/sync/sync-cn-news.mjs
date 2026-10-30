#!/usr/bin/env node
/**
 * Caches Arknights CN's official activity announcements into data/official-news/cn/<cid>.json
 * ({ cid, title, displayTime, url, lines, art }): the "[活动预告]" previews name a coming event, its
 * banner with the rate-up operators and the exact opening hours about a week before the CN client
 * carries any of it. The catalogue reads them (scripts/build/cn-news.mjs) to publish the event and
 * banner on the day of the announcement. The official website is a source the user named for CN
 * news (2026-10-03), ahead of the wiki.
 *
 * `art` is the post's images in order, each { url, line }: `line` is the index in `lines` of the
 * text the image stands above (lines.length for one after the last line). Each section of a post
 * opens with its key art right above its heading -- the event's banner above 「the event」, the
 * banner's above 【the banner】 -- which is the picture the wiki later uploads as "CN <name>
 * banner.png" (the same 1560x500 file), so the catalogue takes an announced event's poster and
 * banner art from here (cn-news.mjs sectionArt). Every image is kept as the post has it; which
 * hosts are ever downloaded from is the art publisher's to decide (publish-catalogue-assets.py).
 * A post cached before `art` was kept is read once more for it (syncCnNews).
 *
 * The site (https://ak.hypergryph.com/news) is server-rendered and answers only a browser user
 * agent; its list page embeds the latest posts of each tab, the activity tab ("tab":"1") holding
 * about three months of previews, so a nightly read never misses one. Each post not cached yet is
 * fetched once: an announcement does not change, and a correction is a post of its own. GET only.
 * A day the list page cannot be read is reported to the quarantine list (stage cn-news) and the
 * cached posts stand. One post that cannot be fetched, or holds no article this reader can find,
 * is that post's problem alone (cn-news:<cid>): the posts after it are still read, and it is
 * asked for again on every run while the list still shows it. Its entry reads the same whichever
 * it was (unreadPost); which one goes to the log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { newsLines } from '../build/official-news.mjs';
import { beginStage, readQuarantine } from '../lib/quarantine.mjs';

const SITE = 'https://ak.hypergryph.com/news';
export const CN_NEWS_DIR = 'data/official-news/cn';
// A cached post is <cid>.json; nothing else in the directory is one.
const POST_FILE = /^\d+\.json$/;
// The site sends a bare client a challenge page instead of the post.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function getText(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** The activity posts the list page embeds: [{ cid, title, displayTime }], each once. */
export function listedPosts(html) {
  const text = String(html ?? '').replace(/\\"/g, '"');
  const posts = new Map();
  for (const match of text.matchAll(/\{"cid":"(\d+)","tab":"(\d+)","sticky":(?:true|false),"title":"((?:[^"\\]|\\.)*)","author":"(?:[^"\\]|\\.)*","displayTime":(\d+)/g)) {
    if (match[2] === '1' && !posts.has(match[1])) posts.set(match[1], { cid: match[1], title: match[3], displayTime: Number(match[4]) });
  }
  return [...posts.values()];
}

// An image's place among the lines: a line of its own that no article text can be (a character
// from the Private Use Area, then the address).
const IMAGE_LINE = '\uE000img ';
const IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** A post page's article: its text as lines, the server-rendered body from the title to the
 *  sign-off, and its images ({ url, line }, see the header); null when it holds no article. */
export function postArticle(html, title, pageUrl = SITE) {
  const page = String(html ?? '');
  const bodyAt = page.indexOf('<body'), scriptAt = page.indexOf('<script', bodyAt);
  // The body up to its first script (the page's data, not its text), or to the end if it has none.
  const body = bodyAt < 0 ? '' : page.slice(bodyAt, scriptAt < 0 ? undefined : scriptAt);
  // Each image as a line of its own, so it keeps its place among the text lines.
  const all = newsLines(body.replace(IMAGE, (_, src) => `</p>${IMAGE_LINE}${src}</p>`));
  const start = all.indexOf(title);
  // The sign-off ends an announcement. A post without one (a fan contest) runs on into the page's
  // own navigation, which opens with INFO / 返回列表 ("back to the list") under the article and
  // reaches the footer's ARKNIGHTS after it, so whichever comes first ends the article.
  const end = all.findIndex((line, i) => i > start && /^(?:【明日方舟】运营组|INFO|返回列表|ARKNIGHTS)$/.test(line));
  if (start < 0 || end < 0) return null;
  const lines = [], art = [];
  for (const line of all.slice(start + 1, end)) {
    if (line.startsWith(IMAGE_LINE)) {
      // As an absolute address: one the page writes relative to itself is resolved against it.
      let url = null;
      try { url = new URL(line.slice(IMAGE_LINE.length), pageUrl).href; } catch { /* not an address */ }
      if (url && /^https?:$/.test(new URL(url).protocol)) art.push({ url, line: lines.length });
    // The date under the title ("2026 // 10 / 03") is the list's displayTime already.
    } else if (!/^\d{4} \/\/ \d{2} \/ \d{2}$/.test(line)) lines.push(line);
  }
  return { lines, art };
}

/** A post page's article as lines (postArticle), or null. */
export const postLines = (html, title) => postArticle(html, title)?.lines ?? null;

/** The cached posts, for the catalogue (scripts/build/cn-news.mjs reads them), in cid order; none
 *  before the first sync. */
export function readCnNews(root) {
  const dir = path.join(root, CN_NEWS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => POST_FILE.test(file)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    .map(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

export async function syncCnNews(root, { fetcher = globalThis.fetch, pause = () => new Promise(resolve => setTimeout(resolve, 500)) } = {}) {
  const dir = path.join(root, CN_NEWS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const cached = new Set(fs.readdirSync(dir).filter(file => POST_FILE.test(file)).map(file => file.slice(0, -5)));
  const listed = listedPosts(await getText(SITE, fetcher));
  if (!listed.length || listed.some(post => !Number.isFinite(post.displayTime) || post.displayTime <= 0)) {
    throw new Error('the news page lists no activity posts with their dates: its layout has probably changed');
  }
  const fresh = listed.filter(post => !cached.has(post.cid));
  // Each one `fetched: false` when its page could not be had at all, true when it holds no article.
  const unreadable = [];
  for (const post of fresh) {
    const url = `${SITE}/${post.cid}`;
    let html;
    try {
      html = await getText(url, fetcher);
    } catch (error) {
      console.warn(`CN news post ${url} could not be fetched: ${error.message}`);
      unreadable.push({ ...post, fetched: false });
      continue;
    } finally {
      await pause();
    }
    const article = postArticle(html, post.title, url);
    if (!article) {
      console.warn(`CN news post ${url} holds no article this reader can find (no "${post.title}" heading, or no sign-off after it).`);
      unreadable.push({ ...post, fetched: true });
      continue;
    }
    fs.writeFileSync(path.join(dir, `${post.cid}.json`), `${JSON.stringify({ ...post, url, ...article }, null, 1)}\n`);
  }
  return { fresh: fresh.length - unreadable.length, unreadable, withArt: await addArt(dir, cached, fetcher, pause) };
}

/** A post cached before its images were kept (no `art`) is read once more for them, whether or
 *  not the list still shows it: its address stands. Its text stays as cached -- the catalogue's
 *  records were read from it, and an announcement does not change -- so an image's `line` is the
 *  cached text's only when the page's text is still that text. A page that cannot be had, or reads
 *  differently, is left as it is and asked again the next run; only the log says so. The post's
 *  records are published either way: an announced event without the post's art has none, as every
 *  announced event had before images were kept, and a banner without art is held by
 *  check-completeness ('no key art yet'). Returns how many gained their art. */
async function addArt(dir, cached, fetcher, pause) {
  let added = 0;
  for (const cid of [...cached].sort((a, b) => Number(a) - Number(b))) {
    const file = path.join(dir, `${cid}.json`), post = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(post.art)) continue;
    let article = null;
    try {
      article = postArticle(await getText(post.url, fetcher), post.title, post.url);
    } catch (error) {
      console.warn(`CN news post ${post.url} could not be fetched again for its images: ${error.message}`);
      continue;
    } finally {
      await pause();
    }
    if (!article || JSON.stringify(article.lines) !== JSON.stringify(post.lines)) {
      console.warn(`CN news post ${post.url} no longer reads as cached, so its images are not added (their places would be another text's).`);
      continue;
    }
    fs.writeFileSync(file, `${JSON.stringify({ ...post, art: article.art }, null, 1)}\n`);
    added++;
  }
  return added;
}

/** The quarantine entry of a post this run could not read. One wording, whether its page could
 *  not be had or held no article this reader can find: a post that failed one way one night and
 *  the other the next changed its reason, and data/quarantine.json, a release input, with it. */
export const unreadPost = ({ cid, title }) => ({ key: `cn-news:${cid}`, action: 'omitted-new',
  reason: `The CN announcement "${title}" (${SITE}/${cid}) could not be read; it is left out until it can be.` });

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  // What the last run reported for single posts: still unread on a day the list cannot be read.
  const unread = readQuarantine(root).entries.filter(entry => entry.stage === 'cn-news' && /^cn-news:\d+$/.test(entry.key));
  const stage = beginStage(root, 'cn-news');
  syncCnNews(root).then(({ fresh, unreadable, withArt }) => {
    for (const post of unreadable) stage.add(unreadPost(post));
    console.log(`CN news: ${fresh} new post(s)${unreadable.length ? `, ${unreadable.length} unreadable` : ''}${withArt ? `; images added to ${withArt} cached post(s)` : ''}.`);
    stage.commit();
  }, error => {
    console.error(error);
    stage.add({ key: 'cn-news', action: 'kept-previous', reason: 'The official CN news could not be read; the cached announcements stand.' });
    for (const { key, action, reason, sourceRef } of unread) stage.add({ key, action, reason, sourceRef });
    stage.commit();
  });
}
