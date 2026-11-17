/** CN paid offers remain a separate, source-scoped preview until Global announces its own list. */
import { cnSections, cnWindow } from './cn-news.mjs';
import { eventWindow } from '../lib/event-records.mjs';

const packHeading = line => String(line).match(/^\[([^\]]+)\]\s*(.*)$/);
const saleSection = section => /组合包|礼包/.test(section.title) && /限时|售卖|上架/.test(section.title);
// Some sales spell out a year on either boundary (rename packs often span six months).
export function cnPackWindow(text, published) {
  const raw = String(text ?? '');
  const m = raw.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*[-–~]\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  const inferred = cnWindow(raw.replace(/\d{4}年/g, ''), published);
  if (!m || !inferred) return null;
  if (!m[1] && !m[6]) return inferred;
  const year = m[1] ? +m[1] : new Date(inferred.start * 1000).getUTCFullYear();
  const start = Date.UTC(year, +m[2] - 1, +m[3], +m[4] - 8, +m[5]) / 1000;
  let endYear = m[6] ? +m[6] : year;
  let end = Date.UTC(endYear, +m[7] - 1, +m[8], +m[9] - 8, +m[10]) / 1000;
  if (!m[6] && end < start) end = Date.UTC(++endYear, +m[7] - 1, +m[8], +m[9] - 8, +m[10]) / 1000;
  return end > start ? { start, end: end + (+m[10] === 59 ? 60 : 0) } : null;
}
const isoWindow = window => window ? { start: new Date(window.start * 1000).toISOString(), end: new Date(window.end * 1000).toISOString() } : {};

/** Keep original line numbers so artwork is joined to this announcement's exact offers. */
export function cnPackSections(post, localize = name => ({ name, kind: 'other' })) {
  return cnSections(post).filter(saleSection).flatMap(section => {
    const sectionEnd = section.at + section.lines.length + 1;
    const firstHeading = section.lines.findIndex(line => packHeading(line));
    const sharedTime = section.lines.slice(0, firstHeading < 0 ? undefined : firstHeading).find(line => /^(?:售卖|贩售|活动)时间[：:]/.test(line));
    const common = cnPackWindow(sharedTime, post.displayTime);
    const headings = post.lines.flatMap((line, at) => {
      const match = at > section.at && at < sectionEnd && packHeading(line);
      return match ? [{ at, name: match[1].trim(), suffix: match[2] }] : [];
    });
    const packs = headings.flatMap((heading, index) => {
      // Free rename gifts are not paid packs, even when they share a sale heading.
      if (/免费/.test(heading.suffix)) return [];
      const lines = post.lines.slice(heading.at + 1, headings[index + 1]?.at ?? sectionEnd);
      const contentsAt = lines.findIndex(line => /^(?:组合包|礼包)内容[：:]/.test(line));
      if (contentsAt < 0) return [];
      const raw = lines[contentsAt].replace(/^(?:组合包|礼包)内容[：:]\s*/, '');
      const tokens = raw.split(/[、，,]/).map(s => s.trim()).filter(Boolean);
      const contents = tokens.map(token => {
        const m = token.match(/^(.+?)\s*[*×]\s*(\d+)\s*$/);
        return m && +m[2] > 0 && Number.isSafeInteger(+m[2]) ? { ...localize(m[1].trim()), count: +m[2] } : null;
      });
      // Do not invent missing quantities or publish a partially parsed contents list.
      if (!contents.length || contents.some(item => !item)) return [];
      const time = lines.find(line => /^(?:售卖|贩售|活动)时间[：:]/.test(line));
      const window = time ? cnPackWindow(time, post.displayTime) : common;
      if (!window) return [];
      return [{ name: heading.name, ...isoWindow(window), contents, at: heading.at }];
    });
    return packs.length ? [{ ...section, endAt: sectionEnd, packs }] : [];
  });
}

/** Match the post's explicit event source; older records need both a CN activity name and window.
 * Ambiguous posts never attach their paid offers to an arbitrary event with overlapping dates. */
export function cnPackGroups(events, posts, cn, localize) {
  const result = {};
  for (const post of [...posts].sort((a, b) => b.displayTime - a.displayTime)) {
    const sections = cnPackSections(post, localize);
    if (!sections.length) continue;
    const primary = cnSections(post).find(s => /关卡|主题曲|SideStory|故事集|限时活动(?:即将)?开启|合作活动开启/.test(s.title) && !/寻访|签到|家具|时装|组合包/.test(s.title) && s.lines.some(line => cnWindow(line, post.displayTime)));
    if (!primary) continue;
    const primaryWindow = primary.lines.map(line => cnWindow(line, post.displayTime)).find(Boolean);
    if (!primaryWindow) continue;
    // A festival post can also announce a museum/mode and packs opening earlier. The
    // primary event's own section/window owns its packs, never the earliest sale date.
    const sameStart = event => Math.abs((eventWindow(event, 'CN')?.start ?? Infinity) - primaryWindow.start * 1000) < 86400000;
    let candidates = events.filter(event => event.cn?.timingSource === post.url && sameStart(event));
    if (!candidates.length) candidates = events.filter(event => {
      if (!sameStart(event)) return false;
      const window = eventWindow(event, 'CN');
      return Object.values(cn?.activity?.basicInfo ?? {}).some(a => {
        if (Math.abs(a.startTime * 1000 - window.start) >= 86400000) return false;
        const name = String(a.name ?? '').replace(/\s*[-–]?\s*(?:复刻|Retrospection|Rerun)\s*$/i, '');
        return name && primary.title.includes(name);
      });
    });
    if (candidates.length !== 1 || result[candidates[0].name]) continue;
    result[candidates[0].name] = sections.map(section => ({ kind: 'packs', title: section.title, region: 'CN', source: post.url, items: [],
      packs: section.packs.map(({ at: _at, ...pack }) => pack) }));
  }
  return result;
}

/** Replace the whole paid catalogue, rather than pairing translated names or retaining CN-only offers. */
export function applyCnPacks(rewards, cnGroups) {
  for (const name of new Set([...Object.keys(rewards), ...Object.keys(cnGroups)])) {
    const groups = cnGroups[name];
    const entry = rewards[name] ??= { activity: null, groups: [] };
    if (entry.groups.some(g => g.kind === 'packs' && g.region !== 'CN')) {
      entry.groups = entry.groups.filter(g => g.kind !== 'packs' || g.region !== 'CN');
      continue;
    }
    if (groups) entry.groups = [...entry.groups.filter(g => g.kind !== 'packs'), ...groups];
  }
  return rewards;
}
