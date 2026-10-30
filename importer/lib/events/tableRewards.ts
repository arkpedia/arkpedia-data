import type { ResolvedRewardStore } from './rewardTotals';
import { furnitureArtPath } from './furnitureArt.mjs';

/**
 * An event's rewards beyond its store, as data/event-rewards.json carries them
 * (scripts/build/build-event-rewards.mjs, from the Global game tables), and their shape on
 * /events/[slug]: each group becomes a block beside the store, so the page's tabs and its All
 * totals take them in with the store's own listings.
 */
export interface TableRewardItem { name: string; count: number; kind: string; id: string; iconName?: string }
export interface PackContents { name: string; count: number; kind: string }
export interface EventPack { name: string; start?: string; end?: string | null; contents: PackContents[]; limit?: number; notes?: string[] }
export interface FurniturePiece { name: string; id: string; obtain: string | null; comfort: number | null }
export interface TableRewardGroup {
  kind: 'login' | 'banner-gift' | 'free-rolls' | 'missions' | 'milestones' | 'first-clear' | 'pray' | 'packs' | 'notice' | 'news' | 'board' | 'furniture-set';
  title: string;
  source: string;
  start?: string;
  end?: string;
  days?: number;
  /** Ordered sign-in day rewards; totals remain in items. */
  daily?: TableRewardItem[][];
  count?: number;
  items: TableRewardItem[];
  /** packs: the packs a post's section offers. */
  packs?: EventPack[];
  tickets?: Record<string, import('./announcements').TicketDetails>;
  /** notice: the section's DURATION/DETAILS/REWARDS lines as the post words them; news: all of the
   *  section's lines (build-event-rewards.mjs NEWS_LINES). */
  lines?: string[];
  /** news: when the official post was published (ISO); board: the day the in-game board showed it. */
  published?: string;
  /** news: the post's pictures in this section, each above the line `at` (at the end when `at` is
   *  the number of lines; above the heading when -1), on the official website's image host. */
  art?: NewsArt[];
  /** news: the picture the post opens with, above its first section. */
  postArt?: string;
  /** board: the in-game board item's art (a headhunting banner's), on the game's image host. */
  image?: string;
  /** board: the server whose in-game board it is, for JP's and KR's (build-event-rewards.mjs
   *  regionalBoardGroups); none for Global's. */
  server?: 'jp' | 'kr';
  /** board, regional: the board item's id, what tells its items apart. */
  id?: string;
  /** board, regional: what the item is about, and the site's own English name for it. */
  subject?: 'event' | 'banner';
  name?: string;
  /** furniture-set: the set's pieces and its description. */
  pieces?: FurniturePiece[];
  themeId?: string;
  description?: string | null;
  /** A rerun's group repeated from its original run (build-event-rewards.mjs RERUN_REPEATS): that
   *  run's name, until the rerun's own are in the tables. */
  inherited?: string;
  /** 'CN' for a group read from the CN tables while Global has not had the event yet. */
  region?: string;
}

export interface NewsArt { url: string; at: number }

/** data/event-rewards.json, as /events/[slug] reads it. */
export interface EventRewardsFile {
  /** The store's Chinese item names in English, where the Global tables have them. */
  storeNames?: Record<string, string>;
  /** Furniture names a store sells, from the game's furniture data. */
  storeFurniture?: string[];
  events: Record<string, { region?: string; inheritsFrom?: string; groups: TableRewardGroup[] }>;
}

/** The block type an event's own store is listed under (the wiki's store, or the event record's
 *  import): the label the furniture checklist prices a piece from. */
export const EVENTS_STORE = 'Events Store';

/** The tab each kind of group is listed under. A draw login has no fixed payout to list. */
export const TABLE_REWARD_LABEL: Record<TableRewardGroup['kind'], string | null> = {
  login: 'Login event',
  // The limited banner's gifts, its ten-roll permit and its daily free rolls, in one place: a
  // community compilation counts them together ("10x HH + 14 dailies").
  'banner-gift': 'Headhunting',
  'free-rolls': 'Headhunting',
  missions: 'Missions',
  milestones: 'Milestones',
  'first-clear': 'First clears',
  // A draw login: its payout is drawn, so there is nothing fixed to list, and it is not shown.
  pray: null,
  // Not a list of rewards to total: their own tabs (eventExtras, components/events/EventExtras.tsx).
  packs: null,
  notice: null,
  news: null,
  board: null,
  'furniture-set': null,
};

/** What the page shows beside the reward blocks: packs, furniture sets and announced gifts. */
export interface EventExtras {
  packs: { title: string; source: string; packs: (Omit<EventPack, 'contents'> & { imagePath?: string | null; contents: (PackContents & { iconPath: string | null })[] })[] }[];
  furniture: { title: string; source: string; imagePath?: string | null; description: string | null; pieces: FurniturePiece[] }[];
  notices: { title: string; source: string; lines: string[] }[];
  /** The rest of the event's official announcement, section by section: the page's News tab. */
  news: { title: string; source: string; published: string | null; lines: string[]; art: NewsArt[]; postArt: string | null }[];
  /** The in-game boards' items for the event, with their art: atop the News tab. Global's (its
   *  banners') and JP's and KR's (their own event items and banners'); the page shows the site's
   *  server's (components/events/EventExtras.tsx EventNews). `name` is the site's English name of
   *  what a regional item is about, null for Global's, whose title is English; a regional item's
   *  image is null when the board's picture is too large to load (regional-board.mjs). */
  board: BoardItem[];
}

export interface BoardItem { server: 'en' | 'jp' | 'kr'; title: string; name: string | null; source: string | null; shown: string | null; image: string | null }

export const NO_EXTRAS: EventExtras = { packs: [], furniture: [], notices: [], news: [], board: [] };

export function eventExtras(groups: TableRewardGroup[], iconFor: (name: string) => string | null, packArt: (name: string) => string | null = () => null, isPublished: (file: string) => boolean = () => false): EventExtras {
  return {
    packs: groups.filter(g => g.kind === 'packs' && g.packs?.length).map(g => ({
      title: g.title, source: g.source,
      packs: g.packs!.map(pack => ({ ...pack, imagePath: packArt(pack.name), end: pack.end ?? null, contents: pack.contents.map(item => ({ ...item, iconPath: iconFor(item.name) })) })),
    })),
    furniture: groups.filter(g => g.kind === 'furniture-set' && g.pieces?.length).map(g => ({ title: g.title, source: g.source, imagePath: furnitureArtPath(g, isPublished), description: g.description ?? null, pieces: g.pieces! })),
    notices: groups.filter(g => g.kind === 'notice' && g.lines?.length).map(g => ({ title: g.title, source: g.source, lines: g.lines! })),
    news: groups.filter(g => g.kind === 'news' && g.lines?.length).map(g => ({ title: g.title, source: g.source, published: g.published ?? null, lines: g.lines!, art: g.art ?? [], postArt: g.postArt ?? null })),
    // Global's items are its banners' art, so one without a picture is nothing; a regional item is
    // still its notice when its picture is left out.
    board: groups.filter(g => g.kind === 'board' && (g.image || g.server)).map(g => ({ server: g.server ?? 'en', title: g.title, name: g.name ?? null,
      source: g.source || null, shown: g.published ?? null, image: g.image ?? null })),
  };
}

/* Event tokens are the store's currency, already spent in its listings: counted again here
   they would read as a reward of their own in the All totals. They are dropped from the blocks
   themselves, so no tab lists them either: the Missions tab shows a mission's other rewards and
   not its tokens, and a group that gives nothing but tokens is no block at all (on 2026-10-05,
   166 token rows and 24 whole groups, all but one of each in missions). */
const LEFT_OUT = new Set(['event-item']);

export function tableRewardStores(groups: TableRewardGroup[], iconFor: (item: TableRewardItem) => string | null): ResolvedRewardStore[] {
  return groups.flatMap(group => {
    const label = TABLE_REWARD_LABEL[group.kind];
    const items = group.items.filter(item => !LEFT_OUT.has(item.kind));
    if (!label || !items.length) return [];
    return [{
      type: label,
      name: group.title,
      items: items.map(item => ({ name: item.name, quantity: item.count, price: null, currency: '', stock: '1', iconPath: iconFor(item) })),
    }];
  });
}

/**
 * Where this event gives a piece of its furniture set, for the set's checklist: its store and the
 * price there, else the block it is in (its missions, its sign-in, a milestone). Null when no
 * block lists it; the page then says how the game says it is obtained. The labels are the ones
 * the blocks carry (EVENTS_STORE, TABLE_REWARD_LABEL), not copies of them, so a label renamed
 * there cannot quietly stop matching here.
 */
export function furniturePieceSource(piece: string, stores: readonly ResolvedRewardStore[]): string | null {
  for (const store of stores) {
    const item = store.items.find((i) => i.name === piece);
    if (!item) continue;
    if (store.type === EVENTS_STORE) return item.price != null ? `${store.name}: ${item.price} ${item.currency}` : store.name;
    return store.type === TABLE_REWARD_LABEL.missions ? 'Event missions' : store.type;
  }
  return null;
}
