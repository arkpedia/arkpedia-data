import { serverInstant } from '../../lib/time/servers.mjs';
/**
 * Reading Arknights Global's official event announcements (www.arknights.global news, cached by
 * scripts/sync/sync-official-news.mjs into data/official-news/global/<id>.json).
 *
 * An announcement is numbered sections ("01 SIDESTORY: PEOPLE, A PEOPLE OPEN", "06 LIMITED-TIME
 * PACKS AVAILABLE"), each a run of KEY: value lines (DURATION, DETAILS, REWARDS, CONTENTS). Every
 * section belongs to the announced event, which is what groups an event's packs, gifts and
 * furniture with it. Only what the post states outright is read as data: a pack's CONTENTS
 * (`Item * N`); a section's REWARDS prose ("..., etc.") is kept as written, never counted.
 */
import fs from 'node:fs';

/* Every named reference HTML5 defines (html-entities.json, generated from the WHATWG list). A
   post comes out of a rich-text editor and can carry any of them: with a table of fourteen, a
   stray "&reg;" stayed in a name, and the event-rewards stage's output guard, which refuses an
   entity left in its output, failed the stage every night until someone added it by hand.
   Except the curly quotes and the no-break space, which read as the plain ones the game's tables
   write, as they always have here: a pack's "Kroos’s ..." must find the item table's "Kroos's ...".
   By what a name decodes to, not by name: HTML5 spells each of them more than one way
   (&CloseCurlyQuote; and &rsquor; are &rsquo;, &NonBreakingSpace; is &nbsp;), and an alias left
   curly would not match the item table either. */
const PLAIN = { ' ': ' ', '‘': "'", '’': "'", '“': '"', '”': '"' };
const ENTITIES = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('./html-entities.json', import.meta.url), 'utf8')).entities)
  .map(([name, text]) => [name, PLAIN[text] ?? text]));
const REFERENCE = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;
/** One character reference as text, or null where it is none: a name HTML does not define, or a
 *  number that is no character -- beyond U+10FFFF or a lone surrogate, which String.fromCodePoint
 *  refuses with a RangeError that stopped the whole stage ("&#x110000;"). */
function reference(hex, dec, name) {
  // Names are case-sensitive ("&Aacute;" is not "&aacute;"); a capitalised spelling HTML lacks
  // reads as the lowercase one, as this has always read them ("&NBSP;").
  if (name) return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? null;
  const code = hex ? parseInt(hex, 16) : Number(dec);
  return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : null;
}
/** HTML entities decoded, again until none is left: posts are sometimes encoded twice ("&amp;apos;").
 *  Text that only looks like a reference ("R&D;", "&#x110000;") is left as it is. */
export function decodeEntities(text) {
  let before;
  do {
    before = text;
    text = text.replace(REFERENCE, (whole, hex, dec, name) => reference(hex, dec, name) ?? whole);
  } while (text !== before);
  return text;
}
/** The first reference in `text` that decodeEntities would decode, as a match, or null: one left
 *  in decoded output is a string that skipped the decoder (build-event-rewards.mjs's guard). */
export function leftoverEntity(text) {
  for (const match of String(text ?? '').matchAll(REFERENCE)) if (reference(match[1], match[2], match[3]) !== null) return match;
  return null;
}

/** The post's HTML as trimmed lines, with "KEY :" spelled "KEY:". */
export function newsLines(html) {
  const text = decodeEntities(String(html ?? '')
    .replace(/<br\s*\/?>|<\/(?:p|li|tr|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ');
  return text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim().replace(/^([A-Z][A-Z ]{1,20}?)\s+:/, '$1:')).filter(Boolean);
}

/** Where the official website keeps the pictures of its posts. Any other address a post names is
 *  never kept. */
export const NEWS_IMAGE_HOSTS = new Set(['webusstatic.yo-star.com']);

/**
 * The pictures of a post, where it has them: [{ url, line }], `line` being how many of the post's
 * lines (newsLines) come before the picture, so it stands above lines[line] (at the end when
 * that is the last). Only an https address on NEWS_IMAGE_HOSTS; the picture itself is not kept.
 */
export function newsArt(html) {
  const text = String(html ?? '');
  const art = [];
  for (const match of text.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["'][^>]*>/gi)) {
    let url;
    try { url = new URL(decodeEntities(match[1])); } catch { continue; }
    if (url.protocol !== 'https:' || !NEWS_IMAGE_HOSTS.has(url.hostname)) continue;
    art.push({ url: url.href, line: newsLines(text.slice(0, match.index)).length });
  }
  return art;
}

/** The numbered sections: { number, title, lines, at }. A heading is "NN TITLE" in capitals; `at`
 *  is its index in `lines`. */
export function newsSections(lines) {
  const sections = [];
  let current = null;
  for (const [at, line] of lines.entries()) {
    const heading = line.match(/^(\d{2})\s+(.+)$/);
    if (heading && heading[2] === heading[2].toUpperCase() && /[A-Z]/.test(heading[2])) {
      current = { number: heading[1], title: heading[2].replace(/\s+/g, ' ').trim(), lines: [], at };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "September 16, 2026, 08:00 – October 7, 2026, 03:59 (UTC-7)" as { start, end } ISO instants. */
export function parseDuration(line) {
  const stamps = [...String(line ?? '').matchAll(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})/g)];
  const at = match => {
    const month = MONTHS.indexOf(match[1].toLowerCase());
    if (month < 0) return null;
    return new Date(serverInstant(+match[3], month + 1, +match[2], +match[4], 'en') + Number(match[5]) * 60_000).toISOString();
  };
  const [start, end] = stamps.map(at);
  return start ? { start, end: end ?? null } : null;
}

/** "Caster Chip Pack * 8, Caster Chip * 5, and LMD * 210000." as [{ name, count }]. */
export function parseContents(value) {
  // A comma between items, never one inside a number ("LMD * 1,000,000").
  return String(value ?? '').replace(/\.\s*$/, '').split(/,(?!\d{3}(?!\d))\s*(?:and\s+)?|\s+and\s+/)
    .map(part => part.trim().match(/^(.+?)\s*[*×xX]\s*([\d,]+)$/))
    .filter(Boolean)
    .map(match => ({ name: match[1].replace(/^\[|\]$/g, '').trim(), count: Number(match[2].replace(/,/g, '')) }));
}

const KEY = /^([A-Z][A-Z ]*?):\s*(.*)$/;
/**
 * The packs a section offers: each a name line, then its DURATION (or the section's) and its
 * CONTENTS. Special pack rules remain as notes when the post gives no countable contents.
 */
export function parsePacks(section) {
  const packs = new Map();
  const lines = section.lines;
  const begins = (line, next = '') => !KEY.test(line) && !/^[◆•-]|^note|^day \d/i.test(line)
    && line.length <= 90 && /^(?:DURATION|SALES PERIOD|CONTENTS?|INCLUDES|DETAILS|UPDATE TIME|ELIGIBLE PLAYERS|AVAILABLE PURCHASE PERIOD):/.test(next);
  let current = null;
  let sectionDuration = null;
  const finish = () => {
    if (!current) return;
    if (current.contents.length || current.notes?.length) {
      const previous = packs.get(current.name);
      if (!previous) packs.set(current.name, current);
    }
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (begins(line, lines[i + 1])) {
      finish();
      const limit = line.match(/\(Limited to (\d+) purchases?\)/i);
      current = { name: line.replace(/^\[|\]$/g, '').replace(/\s*\(Limited to \d+ purchases?\)/i, ''), ...(sectionDuration ?? {}), contents: [], ...(limit ? { limit: Number(limit[1]) } : {}) };
      continue;
    }
    const key = line.match(KEY);
    if (!current) {
      if (key?.[1] === 'DURATION') sectionDuration = parseDuration(key[2]);
      continue;
    }
    if (['DURATION', 'SALES PERIOD'].includes(key?.[1])) Object.assign(current, parseDuration(key[2]) ?? {});
    else if (['CONTENTS', 'CONTENT', 'INCLUDES', 'DETAILS'].includes(key?.[1])) {
      const items = parseContents(key[2]);
      if (items.length) current.contents.push(...items);
      else if (/PACK|KIT|BUNDLE|PACKAGE/i.test(current.name)) (current.notes ??= []).push(line);
    } else if (!current.contents.length && /PACK|KIT|BUNDLE|PACKAGE/i.test(current.name)) {
      (current.notes ??= []).push(line);
    }
  }
  finish();
  return [...packs.values()];
}

/** Explicit Day N rows; prose is preserved separately, never assigned a quantity. */
export function parseLoginDays(section) {
  const rows = section.lines.map(line => line.match(/^Day (\d+):\s*(.+)$/i)).filter(Boolean);
  if (!rows.length || rows.some((row, i) => Number(row[1]) !== i + 1)) return [];
  let complete = true;
  const daily = rows.map(row => row[2].split(/,(?!\d{3}(?!\d))\s*/).flatMap(part => {
    const counted = parseContents(part);
    if (counted.length) return counted;
    const operator = part.match(/^Operator \[★+:\s*(.+)\]$/i);
    if (operator) return [{ name: operator[1], count: 1, kind: 'operator' }];
    const outfit = part.match(/^.+? Collection - (.+) for (.+)$/i);
    if (outfit) return [{ name: `${outfit[2]} / ${outfit[1]}`, count: 1, kind: 'outfit' }];
    // The post states one named piece of furniture rather than a count.
    if (/^Reception Room Functional Furniture - /i.test(part)) return [{ name: part.replace(/^Reception Room Functional Furniture - /i, ''), count: 1, kind: 'furniture' }];
    complete = false;
    return [];
  }));
  return complete ? daily : [];
}

/** A selector's explicitly enumerated pool, beneath its bracketed permit heading. */
export function parseSelectorTickets(section, source) {
  const tickets = {};
  for (let i = 0; i < section.lines.length; i++) {
    const heading = section.lines[i].match(/^\[([^\]]*(?:Transfer|Selection|Selector)[^\]]*Permit[^\]]*)\]$/i);
    if (!heading) continue;
    const block = [];
    for (let j = i + 1; j < section.lines.length; j++) {
      if (/^(?:DURATION|CONTENTS):/.test(section.lines[j]) || /^\[/.test(section.lines[j]) || /^(?:Advanced|Special|Comprehensive).*Pack$/.test(section.lines[j])) break;
      block.push(section.lines[j]);
    }
    const description = block.find(line => /^You can select/i.test(line));
    const operatorLine = block.find(line => line.includes(',') && !/^(?:You|Note|Top|DURATION|CONTENTS)|expires/i.test(line) && !/\d{4}|UTC|★/.test(line));
    if (!description || !operatorLine) continue;
    const operators = operatorLine.replace(/\.$/, '').split(/\s*[,/]\s*/).filter(Boolean);
    if (!operators.length) continue;
    const expiry = block.find(line => /expires/i.test(line));
    tickets[heading[1]] = { source, description, ...(expiry ? { note: expiry } : {}), operators };
  }
  return tickets;
}

/** The announced event's own window: the first DURATION in the post. */
export function postWindow(lines) {
  for (const line of lines) {
    const key = line.match(KEY);
    if (key && key[1] === 'DURATION') {
      const parsed = parseDuration(key[2]);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** The event a post announces, by its title without "SIDESTORY:" and "OPEN": a name to match. */
export function postEventName(title) {
  return String(title ?? '')
    .replace(/^\s*(?:\[[^\]]*\]\s*)?(?:new\s+)?(?:sidestory|side story|story collection(?: event)?|main theme episode\s*\d+|collab event|intermezzi)\s*:\s*/i, '')
    .replace(/\s+(?:limited-time\s+event\s+)?(?:open|now open|rerun|begins|is open)\s*!?\s*$/i, '')
    .trim();
}
