import { SERVER_TIME } from '../../lib/time/servers.mjs';
import { serverCalendarTime } from '../../lib/time/servers.mjs';
/**
 * Which operators Global moved from Standard to Kernel Headhunting, and when: the three pool
 * fields of an operator record that the gacha simulator and the pull planner decide every
 * pool by (lib/gacha/gachaOperatorEligibility.ts):
 *
 *   howToObtain['Standard Headhunting']     "Yes" / "No"
 *   howToObtain['Kernel Headhunting']       "Yes" / "No"
 *   characterInfo['Kernel Addition Date']   "YYYY/MM/DD", the day the move took effect
 *
 * Nothing kept them: they were typed by hand, and the batch Global moved on 2026-10-09 (from
 * Standard Pool #177) sat in the Standard pool of every simulated banner for five days until
 * someone noticed. This module is shared by two readers:
 *
 *   - sync-kernel-pool.mjs (the kernel-pool refresh stage) applies the wiki's statements of a
 *     move to the records (parseKernelMoves, planKernelMoves);
 *   - the completeness stage (scripts/content/check-completeness.mjs) holds the records against
 *     what Global's own announcements say is in Kernel Headhunting (reviewKernelPool).
 *
 * THE DATE CONVENTION. A record's Kernel Addition Date is the Global server day (UTC-7) the
 * move took effect: the day the banner that the wiki's statement names opened ("From Standard
 * Pool #177, the following Operators are removed from Standard Headhunting and added to
 * Kernel Headhunting" -> Standard Pool #177's start, 2026/10/09). The pools change at the
 * server reset that opens that banner, 04:00 UTC-7, which is how the simulator reads the day
 * (kernelMoveInstant, lib/operators/kernelAdditionDates.ts). The batches recorded before this
 * existed agree with the wiki's per-operator changelogs, and each is a banner's opening day:
 * 2023/10/24 (Kernel #1, the day Kernel Headhunting opened), 2024/12/17 (Kernel #25),
 * 2025/12/05 (Standard Pool #155). Only Headhunting/Banners/2026 has a statement to read
 * ("Updates (Global)"); the 2023-2025 pages never carried one, then or in their revisions.
 */
import { lineupNameLookup, parseWikiRows } from './catalogue-model.mjs';
import { newsSections, parseDuration } from '../build/official-news.mjs';
import { serverDay } from '../lib/server-day.mjs';

/** The first yearly banner page with an "Updates (Global)" section. */
export const FIRST_UPDATES_YEAR = 2026;
export const STANDARD = 'Standard Headhunting';
export const KERNEL = 'Kernel Headhunting';
export const ADDED = 'Kernel Addition Date';

/** The record key every stage holds an operator under (check-completeness.mjs does the same). */
export const operatorKey = op => `operator:${op.internalName || op.name}`;
const DAY = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const plainName = text => String(text ?? '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').trim();
const snippet = text => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat; };

/*
 * The statement as the wiki writes it, followed by the operators as an {{Operator list}}:
 *
 *   ==Updates (Global)==
 *   From Standard Pool #177, the following Operators are removed from Standard Headhunting and
 *   added to Kernel Headhunting: {{Operator list
 *   |6star = Lee, Goldenglow, ...
 *   |5star = Blacknight, Quercus, ...}}
 *
 * "From Kernel #N" (a move that takes effect with a Kernel banner, as 2023's and 2024's did) is
 * read the same way. Anything else that speaks of a move is not guessed at: a sentence that
 * mentions leaving Standard or joining Kernel Headhunting outside a statement this reads, or
 * text in the Updates section that is not one, is a problem, reported, and changes nothing.
 */
const STATEMENT = /From\s+(Standard Pool|Standard Headhunting|Kernel Headhunting|Kernel)\s+#(\d+)\s*,\s*the following Operators? (?:are|is) removed from Standard Headhunting and added to Kernel Headhunting\s*:\s*\{\{\s*Operator list\s*([\s\S]*?)\}\}/gi;
const MENTION = /removed from (?:the )?Standard|added to (?:the )?Kernel|(?:moved|transferred) (?:from|to|into) (?:the )?(?:Standard|Kernel)/gi;
const UPDATES = /^(={2,})\s*Updates\b[^=\n]*\1\s*$/im;

/** The "Updates (Global)" section's body, from its heading to the next heading of its level or above. */
function updatesSection(text) {
  const heading = UPDATES.exec(text);
  if (!heading) return null;
  const level = heading[1].length;
  const start = heading.index + heading[0].length;
  const next = new RegExp(`^={2,${level}}[^=\\n].*?={2,${level}}\\s*$`, 'm').exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

/**
 * Every Standard -> Kernel statement on one yearly banner page:
 *   { moves: [{ banner: { type, number, label }, operators: [{ name, rarity }] }], problems: [reason] }.
 * A page without an Updates section and without a word about a move has neither.
 */
export function parseKernelMoves(text) {
  const moves = [], problems = [], spans = [];
  for (const match of String(text ?? '').matchAll(STATEMENT)) {
    spans.push([match.index, match.index + match[0].length]);
    const type = /^Kernel/i.test(match[1]) ? 'kernel' : 'standard';
    const label = `${type === 'kernel' ? 'Kernel' : 'Standard Pool'} #${match[2]}`;
    const operators = [];
    let bad = false;
    for (const line of match[3].split('\n')) {
      const field = /^\s*\|\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
      if (!field) { if (line.trim()) { problems.push(`its statement for ${label} has a line the parser does not recognise ("${snippet(line)}")`); bad = true; } continue; }
      const tier = /^([1-6])\s*star$/i.exec(field[1]);
      if (!tier) { problems.push(`its statement for ${label} lists operators under "${field[1]}", which is not a rarity`); bad = true; continue; }
      for (const name of field[2].split(',').map(plainName).filter(Boolean)) operators.push({ name, rarity: Number(tier[1]) });
    }
    if (!bad && !operators.length) { problems.push(`its statement for ${label} names no operator`); bad = true; }
    if (!bad) moves.push({ banner: { type, number: Number(match[2]), label }, operators });
  }
  const inside = index => spans.some(([from, to]) => index >= from && index < to);
  const section = updatesSection(text ?? '');
  if (section) {
    let rest = '';
    let at = section.start;
    for (const [from, to] of spans.filter(([from]) => from >= section.start && from < section.end)) { rest += text.slice(at, from); at = to; }
    rest += text.slice(at, section.end);
    // Comments and blank lines are not text a reader sees.
    rest = rest.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (rest) problems.push(`its Updates section has text the parser does not recognise ("${snippet(rest)}")`);
  }
  for (const match of String(text ?? '').matchAll(MENTION)) {
    if (inside(match.index)) continue;
    if (section && match.index >= section.start && match.index < section.end) continue; // reported above, as the section's text
    const from = Math.max(0, String(text).lastIndexOf('\n', match.index) + 1);
    const to = String(text).indexOf('\n', match.index);
    problems.push(`it speaks of a pool move the parser does not recognise ("${snippet(String(text).slice(from, to < 0 ? undefined : to))}")`);
  }
  return { moves, problems };
}

/** The Global day a statement's banner opened ("2026/10/09"), from the same page's Banners cells, or null. */
export function moveDay(banner, cells) {
  const row = cells.find(cell => String(cell.type ?? '').trim().toLowerCase() === banner.type && String(cell.no ?? '').trim() === String(banner.number));
  return /^(\d{4}\/\d{2}\/\d{2})/.exec(String(row?.start ?? '').trim())?.[1] ?? null;
}

/** Every move a yearly page states, dated: { moves: [{ ...move, day }], problems }. */
export function datedKernelMoves(text) {
  const { moves, problems } = parseKernelMoves(text);
  const cells = parseWikiRows(String(text ?? ''), 'Banners cell');
  const dated = [];
  for (const move of moves) {
    const day = moveDay(move.banner, cells);
    if (day) dated.push({ ...move, day });
    else problems.push(`its statement names ${move.banner.label}, which has no row with a start date on the page`);
  }
  return { moves: dated, problems };
}

/** The record an operator name in a list or a post answers to: by name, alias or Chinese name (lineupNameLookup). */
export function operatorLookup(operators) {
  return lineupNameLookup(operators.flatMap(op => [op.name, ...(op.aliases ?? []),
    ...Object.entries(op.otherLanguages ?? {}).filter(([language]) => /Chinese/.test(language)).map(([, name]) => name)]
    .filter(name => typeof name === 'string' && name.trim()).map(name => [name, op])));
}

const recordedDay = op => {
  const raw = op.characterInfo?.[ADDED];
  return typeof raw === 'string' && DAY.test(raw.trim()) ? raw.trim() : null;
};
const blank = value => value == null || (typeof value === 'string' && (!value.trim() || value.trim().toUpperCase() === 'N/A'));

/**
 * The records the dated moves change, and what cannot be applied. `operators` are the records
 * (not modified); `source` names the page, for the reasons. Returns
 *   { changes: [{ op, next }], held: [{ key, action, reason }] }
 * where `next` is the whole record as it should be written.
 *
 * One way only, and only on evidence: a record still in Standard Headhunting moves (Standard
 * "No", Kernel "Yes", the day); a record already moved on that day is left alone, so a batch
 * applied by hand, or yesterday, writes nothing; one already moved with no day recorded gets the
 * day. Nothing ever moves back to Standard, and a statement that leaves the page takes nothing
 * with it. A statement is applied whole or not at all: a name no record (or more than one)
 * answers to, or one of another rarity than its list, holds the whole statement. A record the
 * statement cannot be squared with -- moved on another day, neither in Standard nor in Kernel
 * Headhunting, or with no pool fields at all -- is held on its own, as it is.
 */
export function planKernelMoves({ operators, moves, source }) {
  const find = operatorLookup(operators);
  const changes = new Map(), held = [];
  for (const move of moves) {
    const where = `${source}, ${move.banner.label} (${move.day})`;
    const resolved = [], unresolved = [];
    for (const { name, rarity } of move.operators) {
      const op = find(name);
      if (!op) unresolved.push(`${name} (no operator record answers to it, or more than one does)`);
      else if (op.rarity !== rarity) unresolved.push(`${name} (listed as ${rarity}★, but the record ${op.name} is ${op.rarity}★)`);
      else resolved.push(op);
    }
    if (unresolved.length) {
      held.push({ key: `kernel-pool:${source}#${move.banner.label}`, action: 'kept-previous',
        reason: `${where} moves operators from Standard to Kernel Headhunting, but names ${unresolved.join(', ')}; the move is applied to none of them until every name resolves` });
      continue;
    }
    for (const op of resolved) {
      const current = changes.get(op)?.next ?? op;
      const obtain = current.howToObtain, info = current.characterInfo;
      const day = recordedDay(current);
      const hold = reason => held.push({ key: operatorKey(op), action: 'kept-previous', reason: `${op.name}: ${where} moves it from Standard to Kernel Headhunting, but ${reason}; the record is left as it is` });
      if (!obtain || typeof obtain !== 'object' || !info || typeof info !== 'object') { hold('its record has no howToObtain or characterInfo to set'); continue; }
      if (obtain[STANDARD] === 'No' && obtain[KERNEL] === 'Yes') {
        if (day === move.day) continue;
        if (blank(info[ADDED])) { changes.set(op, { op, next: { ...current, characterInfo: { ...info, [ADDED]: move.day } } }); continue; }
        hold(`its record dates its move to Kernel Headhunting ${JSON.stringify(info[ADDED])}`);
        continue;
      }
      if (obtain[STANDARD] !== 'Yes') { hold(`its record says Standard Headhunting ${JSON.stringify(obtain[STANDARD] ?? null)} and Kernel Headhunting ${JSON.stringify(obtain[KERNEL] ?? null)}`); continue; }
      changes.set(op, { op, next: { ...current, howToObtain: { ...obtain, [STANDARD]: 'No', [KERNEL]: 'Yes' }, characterInfo: { ...info, [ADDED]: move.day } } });
    }
  }
  return { changes: [...changes.values()], held };
}

/* ---------------------------------------------------------------------------------------------
 * The official evidence: what Global's own announcements (data/official-news/global) say was in
 * Kernel Headhunting, and from when. Two kinds of section say it outright:
 *
 *   (a) a Top Operator Transfer Permit - Kernel: "The range includes all 6★ Operators currently
 *       available in Kernel Headhunting:" and the list -- every 6★ in the Kernel pool on the day
 *       the post went out. That day is read in UTC: the posts go out the evening before the
 *       update they announce on the server's clock (post 4814 at 20:58 UTC-7 on 2026-10-08,
 *       naming the batch Standard Pool #177 moved at 04:00 the next morning).
 *   (b) a Kernel Locating: "All possible Operators:" and a "★★★★★★ (2%): A / B / ..." and a
 *       "★★★★★ (8%): ..." line -- every one of them in the Kernel pool when the banner opens,
 *       its DURATION's first day (UTC-7). A post sometimes leaves the year out of the DURATION
 *       ("January 27, 04:00 – February 10, 03:59 (UTC-7)"); it is the year of the post, or the
 *       next one for a January banner announced in December.
 * ------------------------------------------------------------------------------------------- */
const PERMIT = /range includes all 6★ Operators currently available in Kernel Headhunting\s*:\s*(.*)$/i;
const utcDay = ms => serverDay(Math.floor(ms / 1000), 0);
const globalDay = iso => serverDay(Math.floor(Date.parse(iso) / 1000), SERVER_TIME.en.offset);
const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{1,2}:\d{2})/gi;
/** A DURATION line with the year put back where the post left it out. */
function withYear(line, publishTime) {
  const published = serverCalendarTime(new Date(publishTime), 'en');
  return line.replace(MONTH, (whole, month, day, time) => {
    const index = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(month.toLowerCase());
    const year = published.getUTCFullYear() + (index < published.getUTCMonth() - 6 ? 1 : 0);
    return `${month} ${day}, ${year}, ${time}`;
  });
}
const tier = (lines, stars) => {
  const line = lines.find(text => new RegExp(`^★{${stars}}(?!★)\\s*\\(`).test(text));
  return line ? line.replace(/^[^:]*:\s*/, '').split('/').map(name => name.trim()).filter(Boolean) : null;
};

/**
 * Every statement of the Kernel pool in the cached posts:
 *   { lists: [{ kind: 'permit' | 'locating', post, label, day, six, five }], problems: [{ post, reason }] }
 * `day` is the YYYY/MM/DD by which every listed operator was in Kernel Headhunting. A permit's
 * six-star list is complete: no other 6★ was in the pool that day. A section that speaks of the
 * pool but cannot be read is a problem, never skipped.
 */
export function officialKernelLists(posts) {
  const lists = [], problems = [];
  for (const post of [...posts].sort((a, b) => (a.publishTime ?? 0) - (b.publishTime ?? 0) || String(a.id).localeCompare(String(b.id)))) {
    const lines = post.lines ?? [];
    const ref = { id: String(post.id), url: post.url ?? null, title: post.title ?? '' };
    lines.forEach((line, index) => {
      const permit = PERMIT.exec(line);
      if (!permit) return;
      const text = (permit[1].trim() || lines[index + 1] || '').replace(/\.\s*$/, '');
      const six = text.split(',').map(name => name.trim()).filter(Boolean);
      if (!Number.isFinite(post.publishTime) || six.length < 2) { problems.push({ post: ref, reason: 'its Top Operator Transfer Permit - Kernel section lists no operators the check can read' }); return; }
      lists.push({ kind: 'permit', post: ref, label: `the Top Operator Transfer Permit - Kernel range in ${ref.url ?? `post ${ref.id}`}`, day: utcDay(post.publishTime), six, five: [] });
    });
    for (const section of newsSections(lines)) {
      if (!/\bKERNEL LOCATING\b/.test(section.title)) continue;
      const durationLine = section.lines.find(text => /^DURATION:/.test(text));
      const duration = parseDuration(durationLine) ?? (durationLine && Number.isFinite(post.publishTime) ? parseDuration(withYear(durationLine, post.publishTime)) : null);
      const six = tier(section.lines, 6), five = tier(section.lines, 5);
      if (!duration?.start || !six?.length || !five?.length) {
        problems.push({ post: ref, reason: `its section "${section.title}" has no DURATION or no "★★★★★★ (2%)" and "★★★★★ (8%)" lines the check can read` });
        continue;
      }
      const day = globalDay(duration.start);
      lists.push({ kind: 'locating', post: ref, label: `the Kernel Locating opening ${day} in ${ref.url ?? `post ${ref.id}`}`, day, six, five });
    }
  }
  return { lists, problems };
}

/**
 * The records the official lists contradict, as completeness holds ({ key, action, reason }).
 * Every operator a list names must be kernel-exclusive by its record (Standard "No", Kernel
 * "Yes") with a Kernel Addition Date on or before the list's day; and a permit's list being every
 * 6★ in the pool, every 6★ record kernel-exclusive since on or before that day must be on it. A
 * name no record of that rarity answers to is held too: the post cannot be checked whole.
 */
export function reviewKernelPool({ operators, posts }) {
  const { lists, problems } = officialKernelLists(posts);
  const find = operatorLookup(operators);
  const holds = problems.map(({ post, reason }) => ({ key: `official-news:${post.id}`, action: 'published-partial',
    reason: `${post.url ?? `Official post ${post.id}`} (${post.title}): ${reason}, so the operator records' Kernel Headhunting fields are not checked against it` }));
  const hold = (op, reason) => holds.push({ key: operatorKey(op), action: 'published-partial', reason: `${op.name}: ${reason}` });
  for (const list of lists) {
    const named = new Set();
    for (const [rarity, names] of [[6, list.six], [5, list.five]]) {
      const unknown = [];
      for (const name of names) {
        const op = find(name);
        if (!op || op.rarity !== rarity) { unknown.push(name); continue; }
        named.add(op);
        const obtain = op.howToObtain && typeof op.howToObtain === 'object' ? op.howToObtain : {};
        const day = recordedDay(op);
        const says = `${list.label} has it in Kernel Headhunting by ${list.day}`;
        if (obtain[STANDARD] !== 'No' || obtain[KERNEL] !== 'Yes') hold(op, `${says}, but its record says Standard Headhunting ${JSON.stringify(obtain[STANDARD] ?? null)} and Kernel Headhunting ${JSON.stringify(obtain[KERNEL] ?? null)}, so the gacha simulator puts it in the wrong pools`);
        else if (!day) hold(op, `${says}, but its record has no ${ADDED} (${JSON.stringify(op.characterInfo?.[ADDED] ?? null)}), so the gacha simulator leaves it out of Kernel banners`);
        else if (day > list.day) hold(op, `${says}, but its record dates the move ${day}, later, so the gacha simulator leaves it out of Kernel banners before then`);
      }
      if (unknown.length) holds.push({ key: `official-news:${list.post.id}`, action: 'published-partial',
        reason: `${list.label} names ${unknown.join(', ')}, which no ${rarity}★ operator record answers to, so the check of that list is incomplete` });
    }
    if (list.kind !== 'permit') continue;
    for (const op of operators) {
      const day = recordedDay(op);
      if (op.rarity !== 6 || named.has(op) || !day || day > list.day || op.howToObtain?.[STANDARD] !== 'No' || op.howToObtain?.[KERNEL] !== 'Yes') continue;
      hold(op, `its record has it in Kernel Headhunting from ${day}, but ${list.label}, every 6★ in Kernel Headhunting on ${list.day}, does not name it`);
    }
  }
  return holds;
}
