import { serverCalendarTime } from '../../lib/time/servers.mjs';
/**
 * Reads the official CN activity announcements (data/official-news/cn, scripts/sync/sync-cn-news.mjs)
 * for what the calendar needs before the CN client carries it: the events that open stages and the
 * banners with their rate-up operators, each with the exact hours the post gives, and the key art
 * that opens its section (sectionArt).
 *
 * A post is numbered sections ("一、全新SideStory「昨日海」，活动关卡开启"), each with its own
 * "活动时间： 10月09日 12:00 - 10月30日 03:59"; a banner's own preview ("[限定寻访·夏季]【…】限时寻访即将
 * 开启") is one unnumbered section. Dates carry no year: it is the post's, or the next one for a
 * December post announcing January.
 *
 * Only what is certain is read. An event is a section naming 「the event」 that opens its stages
 * (SideStory, 故事集, a mode such as 矢量突破); a rerun is left to the client, because its record
 * already exists under its first run's name, as is a collaboration without 「」. A banner is a
 * 【name】 寻访 section whose "寻访为【…】" line says what kind it is (标准寻访 or 限定寻访; a kind
 * this reader does not know is left to the client too). Login campaigns, outfits, furniture and
 * packs are not calendar records.
 */
import { serverDay } from '../lib/server-day.mjs';

const NUMERAL = /^[一二三四五六七八九十]+、/;
const TIME = /(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/;
const NOT_EVENT = /签到|登录|新装|时装|家具|组合包|礼包|寻访|甄选|招募|模组|回顾|资源收集|更新|优化|上限|剿灭|复刻/;

/** The post's sections: { title, lines, at }; a post without numbered sections is one, under its
 *  title. `at` is the index in the post's lines where the section begins: its heading's, or 0 for
 *  the lines before the first heading. */
export function cnSections(post) {
  const sections = [];
  let current = { title: post.title, lines: [], at: 0 };
  for (const [i, line] of (post.lines ?? []).entries()) {
    if (NUMERAL.test(line)) { if (current.lines.length || current.title !== post.title) sections.push(current); current = { title: line.replace(NUMERAL, ''), lines: [], at: i }; }
    else current.lines.push(line);
  }
  sections.push(current);
  return sections;
}

/**
 * A section's key art: the image right above the line it begins on (sync-cn-news.mjs keeps where
 * each image stands), the closest of several, or null. A post opens each section with its banner
 * -- the event's key art above "一、全新SideStory「昨日海」…", the banner's above "二、【海渊巡游】限时寻访
 * 开启", a banner-only preview's above its first line -- and that is the file the wiki uploads as
 * "CN <name> banner.png". Pictures inside a section (its store, an outfit) stand above lines of their
 * own, never above the heading; a festival's umbrella art above "夏日嘉年华活动 Part.1" belongs to the
 * lines before the first heading, which name no record. A post cached without images has none.
 */
export function sectionArt(post, section) {
  return (post.art ?? []).filter(image => image.line === section.at).at(-1)?.url ?? null;
}

// The dates carry no year, and a post announces the weeks ahead of it: a month more than this
// many before the post's own is next year's (a December post's "01月05日" is January after it).
const ROLLOVER_MONTHS = 6;
/** "10月09日 12:00 - 10月23日 03:59" in the year of a post published at `published` (seconds):
 *  { start, end } as UTC instants of the UTC+8 times, the end of a :59 rounded up a minute. */
export function cnWindow(text, published) {
  const m = String(text ?? '').match(TIME);
  if (!m) return null;
  const posted = serverCalendarTime(new Date(published * 1000), 'cn');
  const yearOf = month => posted.getUTCFullYear() + (month < posted.getUTCMonth() + 1 - ROLLOVER_MONTHS ? 1 : 0);
  const instant = (year, month, day, hour, minute) => Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
  const start = instant(yearOf(+m[1]), +m[1], +m[2], +m[3], +m[4]);
  let end = instant(yearOf(+m[5]), +m[5], +m[6], +m[7], +m[8]);
  // An end before the start is a window across New Year: it ends in the year after its start's.
  if (end < start) end = instant(yearOf(+m[1]) + 1, +m[5], +m[6], +m[7], +m[8]);
  return { start, end: end + (+m[8] === 59 ? 60 : 0) };
}
/** A window's first and last server days, ["2026/10/09", "2026/10/23"]: the last is its last
 *  minute's, so an end rounded up to 04:00 (or to midnight) is the day it closes on. */
export const windowDays = ({ start, end }) => [serverDay(start), serverDay(end - 60)];
/** A window's server days, "2026/10/09–2026/10/23", as the calendar records write them. */
export const cnDays = window => windowDays(window).join('–');
const timeOf = (lines, label) => lines.find(line => new RegExp(`^${label}[：:]`).test(line) && TIME.test(line));

/** The events a post announces: [{ type, name, start, end, source, art, artKey }]. */
export function cnEvents(post) {
  const events = [];
  for (const [index, section] of cnSections(post).entries()) {
    const title = section.title;
    if (title === post.title || NOT_EVENT.test(title)) continue;
    // The 「name」 that opens: "「昨日海」，活动关卡开启", "故事集「丛林症结」限时开启", "「奇象巡展」限时活动开启";
    // not "「夏日嘉年华」，特别活动开启", a series' side activity.
    const last = [...title.matchAll(/「([^」]+)」(?=[，,]?\s*(?:活动关卡|限时活动|限时|活动)开启)/g)].at(-1);
    if (!last) continue;
    // A mode's number is part of its name ("矢量突破#3「拟生态」"); an event series' is not ("「夏日嘉年华」，SideStory「…」").
    const before = title.slice(0, last.index).replace(/^.*[，,]\s*/, '');
    const mode = before.match(/([\p{Script=Han}]+#\d+)$/u)?.[1];
    const name = mode ? `${mode}「${last[1]}」` : last[1];
    // A collaboration's marker is the multiplication sign anywhere ("「A×B」" too), or a Latin x
    // standing alone outside the 「names」, which can hold any word ("「Exodus」" is no crossover).
    // Alone means between neither letters nor digits: "掉落x2" or "2x" is a multiplier, not a "×".
    const sideStory = /SideStory/i.test(before);
    const crossover = sideStory && (/×/.test(title) || /(?<![a-z0-9])x(?![a-z0-9])/i.test(title.replace(/「[^」]*」/g, '')));
    const type = /故事集/.test(before) ? 'Story Collection' : crossover ? 'Side Story – Crossover' : sideStory ? 'Side Story' : 'Event';
    // The stages' window: a SideStory's segments end with its stages, its 活动时间 with its store.
    const segments = section.lines.filter(line => /^◆「[^」]+」开启时间[：:]/.test(line)).map(line => cnWindow(line, post.displayTime)).filter(Boolean);
    const window = segments.length
      ? { start: Math.min(...segments.map(w => w.start)), end: Math.max(...segments.map(w => w.end)) }
      : cnWindow(timeOf(section.lines, '关卡开放时间') ?? timeOf(section.lines, '活动时间'), post.displayTime);
    if (window) events.push({ type, name, ...window, source: post.url, ...announcedArt(post, section, index) });
  }
  return events;
}

/** A record's art as the post gives it: `art`, the image's address, or null; `artKey`, the post and
 *  section it opens ("5101-1"), which names the file the catalogue keeps it in. */
const announcedArt = (post, section, index) => ({ art: sectionArt(post, section), artKey: `${post.cid}-${index + 1}` });

// The two kinds of banner a post's "寻访为【…】" line names, in the catalogue's terms; any other
// (a collaboration's, a kind new to the game) is not guessed at.
const SAID_KINDS = { 标准寻访: 'featured', 限定寻访: 'limited' };
// The banners every post names the same; one is known by its window, not its name.
export const GENERIC_BANNERS = { 联合行动: 'joint', 定向甄选: 'orienteering' };
const names = text => text.split(/\s*[/\\／、]\s*/).map(name => name.replace(/\[限定\]|［限定］/g, '').trim()).filter(Boolean);
/** The banners a post announces: [{ name, kind, start, end, six, five, rateUpSix, source, art, artKey }]. */
export function cnBanners(post) {
  const banners = [];
  for (const [index, section] of cnSections(post).entries()) {
    const name = section.title.match(/【([^】]+)】(?:限时寻访|限定寻访)(?:复刻)?(?:即将)?开启/)?.[1]
      ?? (/(?:联合行动|定向甄选)/.test(section.title) && /寻访开启/.test(section.title) ? section.title.match(/【([^】]+)】/)?.[1] : null);
    if (!name || /中坚/.test(name)) continue;
    const window = cnWindow(timeOf(section.lines, '活动时间'), post.displayTime);
    if (!window) continue;
    const said = section.lines.map(line => line.match(/寻访为【([^】]+)】/)?.[1]).find(Boolean);
    const kind = GENERIC_BANNERS[name] ?? SAID_KINDS[said] ?? null;
    if (!kind) continue;
    const six = [], five = [], rateUpSix = [];
    for (const line of section.lines) {
      // The exchange's lists ("（300寻访数据契约）") and anything after them are not the rates.
      if (/寻访数据契约/.test(line)) break;
      const star = line.match(/^(★{5,6})\s*(?:（[^）]*出率[^）]*）)?\s*[：:]\s*(.+?)\s*(?:（(.*)）)?\s*$/);
      if (!star) continue;
      const listed = names(star[2]);
      if (star[1].length === 6 && /剩余出率|权值/.test(star[3] ?? '')) rateUpSix.push(...listed);
      else (star[1].length === 6 ? six : five).push(...listed);
    }
    banners.push({ name, kind, ...window, six, five, rateUpSix, source: post.url, ...announcedArt(post, section, index) });
  }
  return banners;
}

/** Whether two runs' days, each [first, last] as windowDays gives them, overlap, as a correction's
 *  or an extension's do the run it moves. The next run shares none, or only the day the one
 *  before it closes on, which does not count. The same days are one run, a one-day run's
 *  included: its first day is its last, so the strict test alone would find it overlapping
 *  nothing, itself neither, and a second post repeating a one-day Joint Operation would add a
 *  second record of it. A record with no days ([undefined, undefined], a hand-kept banner with no
 *  cn_date) overlaps nothing; every caller's other side is a post's, whose days are never missing. */
export const daysOverlap = (a, b) => (a[0] < b[1] && b[0] < a[1]) || (a[0] !== undefined && a[0] === b[0] && a[1] === b[1]);
/** Whether two announced banners are one, each { name, kind, days } with days as windowDays gives
 *  them (a post's banner, or a record by the name a post gave it): the same name and kind, and --
 *  for a Joint Operation or an Orienteering, which every post names the same (GENERIC_BANNERS) --
 *  days that overlap. */
export const sameAnnouncedBanner = (a, b) => a.name === b.name && a.kind === b.kind
  && (!Object.hasOwn(GENERIC_BANNERS, a.name) || daysOverlap(a.days, b.days));
/** Every event and banner the cached posts announce, each once, as the newest post gives it: a
 *  later post that moves a window corrects the earlier one, whose record moves with it
 *  (catalogue-model.mjs applyAnnouncements). An event is known by its name, a banner as
 *  sameAnnouncedBanner says. A banner carries `event`, the name of the event its post opens with
 *  it, where there is one. */
export function cnAnnouncements(posts) {
  // Posts of one minute keep the order they come in (readCnNews's, by cid), and no tie-break
  // would tell which is newer: the site does not number posts in time order (9686 is a July
  // preview, 1455 a September one). Corrections come later than the post they correct.
  const sorted = [...posts].sort((a, b) => b.displayTime - a.displayTime);
  const events = new Map(), banners = [];
  for (const post of sorted) {
    const announced = cnEvents(post);
    for (const event of announced) if (!events.has(event.name)) events.set(event.name, event);
    for (const banner of cnBanners(post)) {
      const days = windowDays(banner);
      if (banners.some(newer => sameAnnouncedBanner({ ...newer, days: windowDays(newer) }, { ...banner, days }))) continue;
      // The post's event that opens the same day is the banner's event (its page shows the banner).
      const opening = announced.filter(event => serverDay(event.start) === serverDay(banner.start));
      banners.push(opening.length === 1 ? { ...banner, event: opening[0].name } : banner);
    }
  }
  return { events: [...events.values()], banners };
}
