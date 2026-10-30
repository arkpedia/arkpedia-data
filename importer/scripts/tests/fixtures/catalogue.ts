/**
 * The smallest input checkCompleteness passes: nothing expected from the CN tables and
 * nothing published. A test adds only the records it is about, so its result never
 * depends on what the day's refresh left in data/: npm test runs in the release job
 * against freshly refreshed data, where any enemy icon or reward name may be new.
 */
import { plannerCostNames } from '../../../lib/farming/materialCatalogue.mjs';
import operatorFixture from './operator-costs.json';

/** The planner's material catalogue for these fixtures: everything the fixture operator
 *  (operator-costs.json, which most cases start from) costs, so no case trips the
 *  catalogue hold unless it is about it. */
export const fixtureMaterials = { order: ['EXP', ...plannerCostNames(operatorFixture.operator)] as string[] };

export function emptyCatalogue(parts: object = {}) {
  return {
    materials: fixtureMaterials,
    // The artworks data/color-palettes.json has palettes for: none, and no art is published.
    palettes: new Set<string>(),
    inventory: { operators: [], skins: [], events: [], banners: [] },
    operators: [], skins: [], banners: [], events: [], bundles: [],
    // No event's store from the wiki, and no event's rewards from the tables (data/event-stores.json,
    // data/event-rewards.json).
    eventStores: { events: {} }, eventRewards: { events: {} },
    assets: new Set<string>(),
    // No confirmed outfit windows, at a fixed instant: never the real date.
    skinWindows: [] as object[], now: new Date('2026-09-23T00:00:00Z'),
    stageEnemies: new Map<string, string>(),
    // No listed stage with a map (stageMapRows).
    mappedStages: [] as object[],
    enemyRecords: new Map<string, { name: string; icon?: string }>(), enemyIndex: new Set<string>(),
    ...parts,
  };
}
