#!/usr/bin/env node
/**
 * Writes data/event-stores.json: each event's store, as arknights.wiki.gg lists it -- an original
 * run's on the event's page, a rerun's on its "/Rerun" page (a rerun sells its own store: tokens
 * for the operator, other stock). Neither the game tables nor the official announcements carry a
 * store's listings (the server sends them; the announcements say "..., etc."), so this is the
 * wiki as a named gap filler (2026-10-03: the wiki only for what the datamining is missing). It
 * replaces the one-off wiki import in the event records (`rewards`), which never refreshed and
 * left "Furniture not found" placeholders.
 *
 * A store is one {{Event store head}} ... {{Event store cell|...}} run on the page, named by the
 * heading above it; a cell is item=, furniture=, outfit= or upware=, each Name[,qty] (a quantity
 * after the last comma, else one), with price=Currency,amount and stock=N.
 *
 * Read like every structured wiki page (wiki-pages.mjs): the URL from wikiParseUrl, so
 * ARKPEDIA_WIKI_BASE reaches this reader too (a test server, or a closed port to rehearse an
 * outage), the same user agent, the same page links and the same '/'-to-'-' file naming.
 *
 * Fetching: a page parsed before is kept (data/wiki-cache/event-stores/<page>.json) and fetched
 * again only while its event is running or ahead, or ended in the last 30 days; the rest of the
 * archive never changes. About ten GETs a day after the first run (one per event, ~200). The
 * last parse with a store stands whenever today's cannot replace it, and the stage reports why
 * (event-store:<event>, kept-previous; omitted-new where no parse with a store was ever cached):
 *
 *   - the wiki cannot be reached, or answers with an error other than "no such page"
 *     (ratelimited, maxlag): never read as the page being gone;
 *   - the page is still a redirect after redirects were followed (a double redirect);
 *   - the page parses to no store where its last parse had one: a template rename, or a store
 *     cut out of the page, not a store that sold nothing. Taken, the empty parse would stand for
 *     good once the event is past its 30 days and the page is never read again;
 *   - the page is gone where a store was parsed from it.
 *
 * A page the wiki does not have is cached as such ({ page, missing: true, stores: [] }), so a past
 * event with no store page is not asked about every night; it is reported only while the event
 * is running, when a reader would look for its store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { eventTitle, eventWindow, isRerun } from '../lib/event-records.mjs';
import { wikiParseUrl } from './catalogue-model.mjs';
import { USER_AGENT, wikiPageUrl } from './wiki-pages.mjs';

export const CACHE = 'data/wiki-cache/event-stores';
const DAY = 86_400_000;

/** The wiki page an event's store is on: the event's, or for a rerun its "/Rerun" subpage. */
export function storePage(name) {
  const base = eventTitle(name).replace(/\s+Rerun$/, '');
  return isRerun(name) ? `${base}/Rerun` : base;
}

/** Where a page's last parse is kept: its name with '/' as '-', the rule wikiCacheFile keeps. */
export const storeCacheFile = (root, page) => path.join(root, CACHE, `${page.replaceAll('/', '-')}.json`);
/* The name the cache used before it took that rule: every character a Windows file name refuses
   as '_' ("Path of Life_Rerun.json", "Duel Channel_ Vine.json"). A file still under it is taken
   over once, renamed, rather than left behind in arkpedia-data while its page is fetched again. */
const legacyCacheFile = (root, page) => path.join(root, CACHE, `${page.replace(/[\\/:*?"<>|]/g, '_')}.json`);

/** "Name,qty" as [name, qty]; a name may itself hold commas ("People, A People Token,5",
 *  "Healing Hand, Evil Heart"), so only digits after the last comma are a quantity. */
function nameCount(value) {
  const match = String(value ?? '').trim().match(/^(.*?)(?:,\s*([\d,]+))?$/);
  return [match[1].trim(), match[2] ? Number(match[2].replace(/,/g, '')) : 1];
}

/** The stores on a page's wikitext: [{ name, currency, items: [{ name, type, quantity, price, stock }] }]. */
export function parseStores(wikitext) {
  const stores = [];
  let heading = null;
  let current = null;
  for (const line of String(wikitext ?? '').split('\n')) {
    const h = line.match(/^=+\s*(.*?)\s*=+\s*$/);
    if (h) { heading = h[1].replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1'); current = null; continue; }
    for (const cell of line.matchAll(/\{\{Event store cell\|([^}]*)\}\}/g)) {
      const params = Object.fromEntries(cell[1].split('|').map(part => {
        const at = part.indexOf('=');
        return at < 0 ? [part.trim(), ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
      }));
      const kind = ['item', 'furniture', 'outfit', 'upware'].find(k => params[k]);
      if (!kind) continue;
      // Every kind takes a quantity: "furniture=Prison Chair with Handcuffs,2" is two chairs.
      const [name, quantity] = nameCount(params[kind]);
      const [currency, price] = nameCount(params.price);
      if (!current) {
        current = { name: heading ?? 'Event Store', currency, items: [] };
        stores.push(current);
      }
      current.items.push({
        name,
        type: kind === 'item' ? 'material' : kind === 'outfit' ? 'skin' : kind,
        quantity,
        price: params.price ? price : null,
        stock: params.stock && /^\d+$/.test(params.stock) ? params.stock : 'unlimited',
        ...(params.cert ? { ambience: Number(params.cert) || null } : {}),
      });
    }
  }
  return stores;
}

/* Why a page cannot be used today, in words that stay the same while the problem does: they go
   into data/quarantine.json, a release input, so an outage that answers 502 one day and refuses
   the connection the next reads as one problem (wiki-pages.mjs words it the same way). The
   exact error goes to the log. */
const UNREACHABLE = 'the wiki could not be reached';
const REDIRECT = 'it is still a redirect after redirects were followed';
const GONE = 'the wiki has no page by that name';
class Unusable extends Error {}

/** The page's wikitext, { title, text }, or null when the wiki has no page by that name. Throws
 *  Unusable, in the words above, for anything else that keeps the page from being read. */
async function wikitext(page, fetcher) {
  let body;
  try {
    const response = await fetcher(wikiParseUrl(page), { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new Unusable(UNREACHABLE, { cause: error });
  }
  // The one error that means the page is not there. Any other (ratelimited, maxlag, readonly) is
  // the wiki not answering today, and the last parse stands.
  if (body?.error?.code === 'missingtitle') return null;
  if (body?.error) throw new Unusable(UNREACHABLE, { cause: new Error(`API error ${body.error.code ?? JSON.stringify(body.error)}`) });
  const text = body?.parse?.wikitext?.['*'];
  if (typeof text !== 'string') throw new Unusable(UNREACHABLE, { cause: new Error('the answer holds no wikitext') });
  if (/^\s*#redirect\b/i.test(text)) throw new Unusable(REDIRECT, { cause: new Error(text.trim().split('\n')[0]) });
  return { title: body.parse.title ?? page, text };
}

function readCache(root, page) {
  const file = storeCacheFile(root, page);
  const legacy = legacyCacheFile(root, page);
  if (!fs.existsSync(file) && legacy !== file && fs.existsSync(legacy)) fs.renameSync(legacy, file);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
const writeCache = (root, page, entry, cached) => {
  if (JSON.stringify(entry) !== JSON.stringify(cached)) fs.writeFileSync(storeCacheFile(root, page), `${JSON.stringify(entry, null, 1)}\n`);
};

/**
 * Every event's store: { stores: { [event name]: { page, source, stores } }, fetched }. `report`
 * is told each event whose page cannot be used: report(name, { page, problem, kept }), where
 * `kept` says whether a parse with a store stands for it.
 */
export async function syncEventStores(root, { fetcher = globalThis.fetch, now = Date.now(), pause = () => new Promise(resolve => setTimeout(resolve, 500)), report = () => {} } = {}) {
  const events = fs.readdirSync(path.join(root, 'data/events')).filter(file => /^events_\d+\.json$/.test(file))
    .flatMap(file => JSON.parse(fs.readFileSync(path.join(root, 'data/events', file), 'utf8')));
  fs.mkdirSync(path.join(root, CACHE), { recursive: true });
  const out = {};
  let fetched = 0;
  for (const event of events) {
    const page = storePage(event.name);
    const cached = readCache(root, page);
    // The window an event record gives, Global first, else CN.
    const span = eventWindow(event, 'Global') ?? eventWindow(event, 'CN');
    const live = !span || span.end + 30 * DAY >= now;
    const running = Boolean(span) && span.start <= now && now <= span.end;
    const kept = Boolean(cached?.stores?.length);
    let entry = cached;
    if (!cached || live) {
      try {
        const got = await wikitext(page, fetcher);
        fetched++;
        await pause();
        if (!got) {
          if (kept) report(event.name, { page, problem: GONE, kept });
          else {
            writeCache(root, page, { page, missing: true, stores: [] }, cached);
            if (running) report(event.name, { page, problem: GONE, kept });
          }
        } else {
          const stores = parseStores(got.text);
          if (!stores.length && kept) {
            report(event.name, { page, problem: `no store parses from it, where its last parse had ${cached.stores.length}; the store template has probably changed`, kept });
          } else {
            entry = { page: got.title, source: wikiPageUrl(got.title), stores };
            writeCache(root, page, entry, cached);
          }
        }
      } catch (error) {
        if (!(error instanceof Unusable)) throw error;
        const cause = error.cause?.cause?.code ?? error.cause?.message;
        console.warn(`${event.name}: reading ${page} failed: ${error.message}${cause ? ` (${cause})` : ''}`);
        report(event.name, { page, problem: error.message, kept });
      }
    }
    if (entry?.stores?.length) out[event.name] = entry;
  }
  return { stores: out, fetched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const now = defaultNow();
  const stage = beginStage(root, 'event-stores', now);
  syncEventStores(root, {
    now: now.getTime(),
    report: (name, { page, problem, kept }) => {
      console.error(`${name}: ${page} cannot be used: ${problem}`);
      stage.add({
        key: `event-store:${name}`, action: kept ? 'kept-previous' : 'omitted-new', sourceRef: wikiPageUrl(page),
        reason: `${name}: its wiki store page ${page} cannot be used: ${problem}; ${kept ? 'its last parse stands' : 'no earlier parse with a store is cached, so the event page shows no store from the wiki'}.`,
      });
    },
  }).then(({ stores, fetched }) => {
    const text = `${JSON.stringify({ about: 'Each event\'s store from the Arknights wiki (scripts/sync/sync-event-stores.mjs), a rerun\'s from its /Rerun page. Generated every refresh: do not edit.', events: stores }, null, 1)}\n`;
    const file = path.join(root, 'data/event-stores.json');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    stage.commit();
    console.log(`Event stores: ${Object.keys(stores).length} events, ${fetched} page(s) read.`);
  }, error => { console.error(error); process.exitCode = 1; });
}
