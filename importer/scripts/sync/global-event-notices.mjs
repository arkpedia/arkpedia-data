/** Official EN announcements can confirm dates before the client ships its tables. */
import { newsSections, parseNoticeWindow, postEventName } from '../build/official-news.mjs';
import { globalBannerNotices } from './global-client-banners.mjs';
import { serverDay, SERVER_TIME } from '../../lib/time/servers.mjs';

const DAY = 86400000;
const bare = name => String(name ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+rerun\s*$/i, '')
  .normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const officialEN = source => /^https:\/\/(?:www\.)?arknights\.global\/news\/\d+\/?$/.test(source ?? '');
const days = span => `${serverDay(Date.parse(span.startAt) / 1000, SERVER_TIME.en.offset)}–${serverDay((Date.parse(span.endAt) - 1) / 1000, SERVER_TIME.en.offset)}`;
const valid = span => span && Date.parse(span.endAt) > Date.parse(span.startAt) && Date.parse(span.endAt) - Date.parse(span.startAt) <= 60 * DAY;

/** Read stage phases separately from the encompassing event/store duration. */
export function eventNoticeWindow(post) {
  const section = newsSections(post.lines ?? []).find(section => /(?:SIDESTORY|SIDE STORY|STORY COLLECTION|INTERMEZZI|COLLAB EVENT)/i.test(section.title));
  if (!section) return null;
  const durations = section.lines.flatMap((line, index) => /^DURATION:/i.test(line)
    ? [{ index, span: parseNoticeWindow(line, post.publishTime), before: section.lines.slice(Math.max(0, index - 2), index).join('\n') }] : []);
  const phases = durations.filter(row => /(?:^|\n)Phase\s+\d|EVENT STAGE DURATION/i.test(row.before));
  // A stage heading with an unreadable interval must not fall back to the shop's later close.
  const hasStages = section.lines.some(line => /^Phase\s+\d|EVENT STAGE DURATION/i.test(line));
  const phaseCount = section.lines.filter(line => /^Phase\s+\d/i.test(line)).length;
  if (phaseCount && phases.length !== phaseCount) return null;
  const selected = hasStages ? phases : durations.slice(0, 1);
  if (!selected.length || selected.some(row => !valid(row.span))) return null;
  const startAt = selected.map(row => row.span.startAt).sort()[0];
  const endAt = selected.map(row => row.span.endAt).sort().at(-1);
  const span = { startAt, endAt, timingSource: post.url };
  if (!valid(span)) return null;
  const shops = durations.filter((row, index) => {
    const following = section.lines.slice(row.index + 1, durations[index + 1]?.index ?? section.lines.length).join('\n');
    return valid(row.span) && /redeem items from/i.test(following) && row.span.startAt <= endAt && row.span.endAt >= endAt;
  });
  const closes = [...new Set(shops.map(row => row.span.endAt))];
  return { ...span, ...(closes.length === 1 ? { shopEndAt: closes[0] } : {}) };
}

/** Mutate only uniquely named runs, with explicit official windows and provenance. */
export function reconcileGlobalEventNotices({ events, banners, posts, now = Date.now(), onProblem = () => {} }) {
  const changes = [];
  const recent = posts.filter(post => officialEN(post.url) && Number.isFinite(post.publishTime)
    && post.publishTime >= now - 45 * DAY && post.publishTime <= now + DAY).sort((a, b) => a.publishTime - b.publishTime);
  for (const post of recent) {
    const name = bare(postEventName(post.title));
    const matches = events.filter(event => !event.modeId && bare(event.name) === name
      && /rerun/i.test(event.name) === /rerun/i.test(post.title));
    if (matches.length !== 1) { if (matches.length > 1) onProblem(post, 'Ambiguous event identity'); continue; }
    const event = matches[0], span = eventNoticeWindow(post);
    if (!span) { onProblem(post, 'Unreadable event stage duration'); continue; }
    if (Date.parse(span.endAt) < now - 45 * DAY) continue;
    const previousEnd = Date.parse(event.global?.endAt ?? String(event.global?.dateRange ?? '').split(/[–—]/)[1]?.replaceAll('/', '-'));
    if (Number.isFinite(previousEnd) && Math.abs(previousEnd - Date.parse(span.endAt)) > 120 * DAY) {
      onProblem(post, 'Announcement does not match the recorded event run'); continue;
    }
    const next = { ...event.global, ...span, dateRange: days(span), note: null };
    if (JSON.stringify(next) !== JSON.stringify(event.global)) { event.global = next; changes.push(event.name); }
  }
  for (const notice of globalBannerNotices(recent)) {
    if (!notice.name || !valid(notice)) continue;
    const matches = banners.filter(banner => !['joint', 'orienteering'].includes(banner.pull_type)
      && [banner.name, ...(banner.aliases ?? [])].some(name => bare(name) === bare(notice.name))
      && /rerun/i.test(banner.name) === /rerun/i.test(notice.name));
    if (matches.length !== 1) continue;
    const banner = matches[0];
    const previousEnd = Date.parse(banner.global_window?.endAt ?? String(banner.global_date ?? '').split(/[–—]/)[1]?.replaceAll('/', '-'));
    if (Number.isFinite(previousEnd) && Math.abs(previousEnd - Date.parse(notice.endAt)) > 120 * DAY) continue;
    const before = JSON.stringify(banner);
    Object.assign(banner, { global_date: days(notice), global_date_estimated: false, globalScheduleStatus: 'announced',
      global_window: { startAt: notice.startAt, endAt: notice.endAt, timingSource: notice.source } });
    delete banner.schedule_anchor;
    delete banner.globalForecastWithdrawn;
    if (JSON.stringify(banner) !== before) changes.push(banner.name);
  }
  return changes;
}

/** EN-only: do not project an English announcement into JP/KR confirmation. */
export function applyAnnouncedENWindows(eventWindows, bannerWindows, events, banners) {
  for (const event of events) {
    const span = event.global;
    if (event.modeId || !officialEN(span?.timingSource) || !valid(span) || /estimat|predict/i.test(span.note ?? '')) continue;
    eventWindows[event.name] = { ...eventWindows[event.name], startAt: span.startAt, endAt: span.endAt,
      ...(span.shopEndAt ? { shopEndAt: span.shopEndAt } : {}), timingSource: span.timingSource, status: 'announced', ...(event.activityId ? { activityId: event.activityId } : {}) };
  }
  for (const banner of banners) {
    const span = banner.global_window;
    if (banner.globalScheduleStatus !== 'announced' || banner.global_date_estimated || !officialEN(span?.timingSource) || !valid(span)) continue;
    bannerWindows[banner.name] = { ...bannerWindows[banner.name], ...span, status: 'announced', ...(banner.globalPoolId ? { poolId: banner.globalPoolId } : {}) };
  }
}
