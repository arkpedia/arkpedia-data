import announcements from '@/data/event-announcements.json';
import type { TableRewardGroup } from './tableRewards';

export interface TicketDetails {
  source: string;
  description: string;
  note?: string;
  operators: string[];
}
interface Supplement { groups: TableRewardGroup[]; tickets: Record<string, TicketDetails> }
const supplements = announcements.events as unknown as Record<string, Supplement>;

/** Reviewed stream previews come from data/event-announcements.json, the record
 * arkpedia-data publishes, so a review lands without an app deploy. The
 * event's own Global table/announcement groups supersede their preview, without counting
 * the same sign-in or paid pack twice. Independent early login gifts stay with the event. */
export function announcedRewards(name: string, groups: TableRewardGroup[]) {
  const supplement = supplements[name];
  const officialTickets = Object.assign({}, ...groups.filter(g => g.region !== 'CN').map(g => g.tickets ?? {})) as Record<string, TicketDetails>;
  if (!supplement) return { groups, tickets: officialTickets };
  const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sameTitle = (a: string, b: string) => a === b || (!!titleKey(a) && !!titleKey(b) && (titleKey(a).includes(titleKey(b)) || titleKey(b).includes(titleKey(a))));
  const earlyTitles = supplement.groups.filter(g => g.region === 'Global').map(g => g.title);
  const hasGlobal = (kind: string) => groups.some(g => g.kind === kind && g.region !== 'CN' && !g.region?.includes('preview') && !earlyTitles.some(title => sameTitle(title, g.title)));
  const additions = supplement.groups.filter(g => {
    if (groups.some(existing => existing.kind === g.kind && sameTitle(existing.title, g.title))) return false;
    if (g.region?.includes('preview') && g.kind !== 'notice' && g.title !== 'A letter from Kal’tsit - Esperanta' && hasGlobal(g.kind)) return false;
    return true;
  });
  const replaced = new Set([...additions.filter(g => g.region?.includes('preview')).map(g => g.kind), ...groups.filter(g => hasGlobal(g.kind)).map(g => g.kind)]);
  const itemKey = (name: string) => titleKey(name.replace(/\s*\(ten-roll\)$/, ''));
  const officialItems = new Set(groups.filter(g => g.region === 'Global' && g.kind !== 'packs').flatMap(g => g.items.map(i => itemKey(i.name))));
  return {
    groups: [...groups.filter(g => !(g.region === 'CN' && (replaced.has(g.kind) || (g.kind === 'banner-gift' && g.items.length > 0 && g.items.every(i => officialItems.has(itemKey(i.name))))))), ...additions],
    tickets: { ...supplement.tickets, ...officialTickets },
  };
}
