import events2020 from '@/data/events/events_2020.json';
import events2021 from '@/data/events/events_2021.json';
import events2022 from '@/data/events/events_2022.json';
import events2023 from '@/data/events/events_2023.json';
import events2024 from '@/data/events/events_2024.json';
import events2025 from '@/data/events/events_2025.json';
import events2026 from '@/data/events/events_2026.json';
import events2027 from '@/data/events/events_2027.json';
import { EVENTS_STORE } from './tableRewards';

/**
 * Merges every per-year events file (data/events/events_2020.json
 * through events_2027.json) into one array. Both lib/home/frontPageContent.ts (home page, event
 * listings) and lib/schedule/schedule.ts (skin-countdown matching on
 * pages/skins.tsx) read through here instead of importing the old
 * file directly, so they can't drift out of sync with each other.
 *
 * Returned loosely typed -- each caller casts to whichever event
 * interface it already uses (RawEvent in frontPageContent.ts,
 * ScheduleEvent in schedule.ts), same as the old direct JSON import
 * did.
 */
export function loadAllEventYears(): unknown[] {
  return [
    ...(events2020 as unknown[]),
    ...(events2021 as unknown[]),
    ...(events2022 as unknown[]),
    ...(events2023 as unknown[]),
    ...(events2024 as unknown[]),
    ...(events2025 as unknown[]),
    ...(events2026 as unknown[]),
    ...(events2027 as unknown[]),
  ];
}

export interface RewardItem {
  name: string;
  type: string; // "skin" | "material" | possibly others not yet seen
  reward_quantity: number | string;
  // Not every currency is Cork Stoppers, so newer entries use the
  // generic `price` field instead -- `price_cork_stoppers` is kept as
  // a fallback purely for any older entries that still use the old
  // name. Both optional: some reward items (Login Event, Free Gifts)
  // may have no price at all.
  price?: number;
  price_cork_stoppers?: number;
  stock?: string;
  // Set by scripts/sync/sync-reward-names.mjs when a CN-named reward gets its official
  // Global name: the CN name it was entered under, and -- until an icon file under the
  // new name is published -- the name whose material-icons/ file to show instead.
  cnName?: string;
  iconName?: string;
}

export interface EventRewardBlock {
  /** The block's label, and the event page's tab name for it ("Events Store", "Login Event",
   *  "Free Gifts"). Read by code as well as shown: the furniture checklist prices a piece from
   *  the block labelled EVENTS_STORE (lib/events/tableRewards.ts furniturePieceSource), so that
   *  label is a constant, not a spelling to retype. */
  type: string;
  name: string;
  currency: string;
  items: RewardItem[];
}

interface EventWithRewards {
  name: string;
  // The source data currently only ever has a single reward block per
  // event, but this accepts either shape so multiple reward sources
  // (Events Store + a separate Login Event block, etc.) work the
  // moment they show up in the data without another migration.
  rewards?: EventRewardBlock | EventRewardBlock[] | null;
}

/** Looks up a single event's reward block(s) by exact name match,
 * across every year file, always normalized to an array (empty if the
 * event has none). */
export function getEventRewards(eventName: string): EventRewardBlock[] {
  const all = loadAllEventYears() as EventWithRewards[];
  const match = all.find((e) => e.name === eventName);
  if (!match?.rewards) return [];
  return Array.isArray(match.rewards) ? match.rewards : [match.rewards];
}

/** data/event-stores.json: each event's store as the wiki lists it now (the event-stores stage,
 *  scripts/sync/sync-event-stores.mjs; a rerun's from its /Rerun page). */
export interface EventStoresFile {
  events: Record<string, {
    page?: string;
    source?: string;
    stores: { name: string; currency: string; items: { name: string; type: string; quantity: number; price: number | null; stock: string }[] }[];
  }>;
}

/** An event's wiki stores (data/event-stores.json) as the reward blocks /events/[slug] lists and
 *  totals, under EVENTS_STORE like the event record's own import. One copy for the page and
 *  scripts/tests/test-event-rewards.ts, so the test reads the listings as the page does. */
export function wikiStoreBlocks(stores: EventStoresFile['events'][string]['stores']): EventRewardBlock[] {
  return stores.map((store) => ({
    type: EVENTS_STORE,
    name: store.name,
    currency: store.currency,
    items: store.items.map((item) => ({ name: item.name, type: item.type, reward_quantity: item.quantity, price: item.price ?? undefined, stock: item.stock })),
  }));
}
