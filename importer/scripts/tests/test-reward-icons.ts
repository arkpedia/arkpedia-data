import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewardIconPath } from '../../lib/events/rewardIcons';
import { buildSkinIconIndex } from '../../lib/skins/skinIconLookup';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { checkCompleteness, eventRewardIcons, LISTED_REWARD_KINDS, reviewCompleteness } from '../content/check-completeness.mjs';
import { TABLE_REWARD_LABEL } from '../../lib/events/tableRewards';
import { furnitureKey } from '../../lib/events/furnitureName.mjs';
import { emptyCatalogue } from './fixtures/catalogue';

/* A made-up store in the shape of the Contingency Contract Obliteration listing that drew a
   broken image: an outfit, the wiki's missing-furniture placeholder, a CN-named furniture
   whose icon is not published yet, and a material that is. Nothing here reads data/, so the
   day's refresh cannot move a case. */
const published = new Set(['material-icons/Module Data Block.webp', 'material-icons/制式木盆.webp',
  'material-icons/furni_enemyduel_diceAll_01.webp', 'profile-avatars/avatar_activity_ed3.webp',
  'five-star-icons/Kestrel - Charm of The Tiles.webp', 'five-star-icons/Kestrel - Base.webp', 'four-star-icons/Ethan - Infiltrator.webp']);
const isPublished = (file: string) => published.has(file);
const folders = (folder: string) => [...published].filter(file => file.startsWith(`${folder}/`)).map(file => file.slice(folder.length + 1));
const outfits = buildSkinIconIndex(folders);
const outfitIcon = (name: string) => outfits.get(name.trim().toLowerCase()) ?? null;
const item = (name: string, extra: object = {}) => ({ name, type: 'material', reward_quantity: 1, stock: '1', price: 1800, id: null as string | null, ...extra });
const store = (items: object[]) => ({ type: 'Events Store', name: 'Crystallization Sanctuary', currency: 'Crystal Contract Bounty', items });

test('a reward icon the image repository has not published is left out instead of drawn broken', () => {
  assert.equal(rewardIconPath(item('Module Data Block'), outfitIcon, isPublished), '/material-icons/Module Data Block.webp');
  assert.equal(rewardIconPath(item('Furniture not found'), outfitIcon, isPublished), null);
  assert.equal(rewardIconPath(item('涤墨之旗'), outfitIcon, isPublished), null);
  // A reward renamed to its Global name shows the CN-named file it still has.
  assert.equal(rewardIconPath(item('Standard Wooden Basin', { iconName: '制式木盆' }), outfitIcon, isPublished), '/material-icons/制式木盆.webp');
  // Outfits resolve through the outfit lookup, and are held to the index the same way.
  assert.equal(rewardIconPath(item('Charm of the Tiles', { type: 'skin' }), outfitIcon, isPublished), '/five-star-icons/Kestrel - Charm of The Tiles.webp');
  assert.equal(rewardIconPath(item('Unseen Terrain', { type: 'skin' }), outfitIcon, isPublished), null);
  assert.equal(rewardIconPath(item('Unseen Terrain', { type: 'skin' }), () => '/five-star-skins/Scene - Unseen Terrain.webp', isPublished), null);
});

test('an outfit reward finds its icon in the rarity folders by outfit name, ignoring case', () => {
  assert.equal(outfitIcon('charm of the tiles'), '/five-star-icons/Kestrel - Charm of The Tiles.webp');
  assert.equal(outfitIcon('Infiltrator'), '/four-star-icons/Ethan - Infiltrator.webp');
  assert.equal(outfitIcon('Base'), '/five-star-icons/Kestrel - Base.webp', 'the rule is the file name, nothing more');
  assert.equal(outfitIcon('Unseen Terrain'), null);
});

test('the event page resolves every reward icon through rewardIconPath and the release asset index', () => {
  // The call site is the guard's whole point: one path helper used directly again would
  // draw a broken image for an unpublished icon, and nothing would say so.
  const page = fs.readFileSync(new URL('../../pages/events/[slug].tsx', import.meta.url), 'utf8');
  assert.match(page, /iconPath: rewardIconPath\(\{ \.\.\.item, id: .+ \}, .+, publicFileExists\)/);
  assert.doesNotMatch(page, /getMaterialIconPath|iconPath:\s*\n?\s*item\.type === 'skin'/);
  // Every call, not only the store's: the table rewards (their items and the daily free roll's
  // permit) and a pack's contents resolve through it too, and each is held to the release's
  // asset index. A call given any other check would let an unpublished icon through.
  const calls = [...page.matchAll(/rewardIconPath\(/g)].map((match) => {
    let depth = 0;
    for (let at = match.index! + 'rewardIconPath'.length; at < page.length; at += 1) {
      if (page[at] === '(') depth += 1;
      else if (page[at] === ')' && --depth === 0) return page.slice(match.index, at + 1);
    }
    throw new Error('unbalanced rewardIconPath call');
  });
  assert.ok(calls.length >= 4, `the store's, the table items', the free roll's and the packs' calls: found ${calls.length}`);
  for (const call of calls) assert.match(call, /,\s*publicFileExists,?\s*\)$/, call);
  // And the blocks and extras take their icons from those calls: an operator's from the roster.
  assert.match(page, /const tableIcon = [\s\S]*?return rewardIconPath\([\s\S]*?tableRewardStores\(tableRewards, tableIcon\)/);
  assert.match(page, /iconPath: tableIcon\(item\)/, 'sign-in days use the same publication guard as their totals');
  assert.match(page, /eventExtras\(tableRewards, \(itemName\) => rewardIconPath\(/);
  // And the outfit lookup reads the asset index, not public/, which holds no art.
  const lookup = fs.readFileSync(new URL('../../lib/skins/skinIconLookup.ts', import.meta.url), 'utf8');
  assert.match(lookup, /buildSkinIconIndex\(publicFiles\)/);
  assert.doesNotMatch(lookup, /readdirSync/);
});

test('a placeholder reward or an unpublished reward icon is quarantined, and the release still goes out', () => {
  const event = (items: object[]) => ({ name: 'Contingency Contract Obliteration', rewards: store(items) });
  const review = (...items: object[]) => reviewCompleteness(emptyCatalogue({ events: [event(items)], assets: published }));
  const complete = review(item('Module Data Block'), item('Charm of the Tiles', { type: 'skin' }), item('Standard Wooden Basin', { cnName: '制式木盆', iconName: '制式木盆' }));
  assert.deepEqual(complete, { errors: [], quarantine: [], allowed: [] });
  const held = review(item('Furniture not found'), item('涤墨之旗'), item('Unseen Terrain', { type: 'skin' }), item(''), item('?'), item('Module Data Block'));
  assert.deepEqual(held.errors, [], 'one bad item never blocks the release');
  assert.deepEqual(held.quarantine.map((entry: { key: string; action: string }) => [entry.key, entry.action]),
    Array(5).fill(['event:Contingency Contract Obliteration', 'published-partial']));
  assert.deepEqual(held.quarantine.map((entry: { reason: string }) => entry.reason), [
    'Contingency Contract Obliteration reward "Furniture not found": a placeholder, not an item name',
    'Contingency Contract Obliteration reward outfit Unseen Terrain: no published outfit icon',
    'Contingency Contract Obliteration reward "": a placeholder, not an item name',
    'Contingency Contract Obliteration reward "?": a placeholder, not an item name',
    // The unpublished files are one hold for the event, counted (import-reward-icons.py names each).
    'Contingency Contract Obliteration: 1 reward icon not published: material-icons/涤墨之旗.webp',
  ]);
  // The check and the page agree on which outfit icons exist.
  for (const name of ['Charm of the Tiles', 'INFILTRATOR', 'Unseen Terrain', 'Base']) {
    const heldOutfit = checkCompleteness(emptyCatalogue({ events: [event([item(name, { type: 'skin' })])], assets: published })).length > 0;
    assert.equal(heldOutfit, outfitIcon(name) === null, name);
  }
});

test('a reward with a game id finds its art by the id: a player icon in profile-avatars, a piece of furniture in its own file', () => {
  // Duel Channel: Ivy Vine's milestones: 'ALL IN!' and its Duel Trophy, both drawn as names before.
  assert.equal(rewardIconPath(item("Icon 'ALL IN!'", { id: 'avatar_activity_ED3' }), outfitIcon, isPublished), '/profile-avatars/avatar_activity_ed3.webp');
  assert.equal(rewardIconPath(item('Duel Trophy', { id: 'furni_enemyduel_diceAll_01' }), outfitIcon, isPublished), '/material-icons/furni_enemyduel_diceAll_01.webp');
  // Not by the name: another event's Duel Trophy is another piece.
  assert.equal(rewardIconPath(item('Duel Trophy', { id: 'furni_enemyduel_diceAll_02' }), outfitIcon, isPublished), null);
  assert.equal(rewardIconPath(item("Icon 'Perfect!'", { id: 'avatar_activity_ED2' }), outfitIcon, isPublished), null, 'held to the index like any icon');
});

/* Duel Channel: A, as the page builds it: its store from data/event-stores.json (which hides the
   record's own import), its milestones, free roll and packs from data/event-rewards.json. And
   Duel Channel: B, whose store the wiki does not list: the record's own, a Chinese name in English
   (storeNames) and its piece of furniture by the id B's rewards give it. Each has a row no source
   has an icon for -- a mode's upware, a charm coin typed 'other', a pack's line of kind 'other' --
   and B a scrape's stand-in for an item among its table rewards and its packs. */
const duelA = 'Duel Channel: A', duelB = 'Duel Channel: B';
const row = (name: string, type = 'furniture') => ({ name, type, quantity: 1, price: 10, stock: '1' });
const reward = (name: string, kind: string, id: string) => ({ name, count: 1, kind, id });
const eventStores = { events: { [duelA]: { stores: [{ name: 'Store', currency: 'Token', items: [row('Duel Trophy'), row('Pizzeria Long Table'), row('Module Data Block', 'material'),
  row('Unseen Terrain', 'skin'), row('Pastry Table', 'upware')] }] } } };
const eventRewards = { storeNames: { '制式木盆': 'Standard Wooden Basin' }, events: {
  [duelA]: { groups: [
    { kind: 'milestones', title: 'Vine Program', source: 's', items: [reward('Duel Trophy', 'furniture', 'furni_enemyduel_diceAll_01'), reward("Icon 'ALL IN!'", 'other', 'avatar_activity_ED3'),
      reward("Icon 'Perfect!'", 'other', 'avatar_activity_ED2'), reward('Kestrel', 'operator', 'char_x'), reward('Grand Duel Fireworks', 'event-item', 'duel_point'),
      reward('Kestrel / Charm of the Tiles', 'outfit', 'char_x@skin'), reward('Orirock Cube', 'material', '30013'), reward('Gold Chip', 'other', 'charm_coin_1')] },
    { kind: 'free-rolls', title: 'DAILY FREE ROLL', source: 's', items: [reward('Daily free headhunting roll', 'free-roll', 'free-roll')] },
    // A pack's line of kind 'other' (no item of that name: a cosmetic, or the parser's leftover) has no source.
    { kind: 'packs', title: 'PACKS', source: 's', items: [], packs: [{ name: 'Vista Pack', contents: [{ name: 'Orundum', count: 1600, kind: 'currency' }, { name: 'Top Operator Transfer Permit', count: 1, kind: 'other' }] }] },
    // Not listed as rewards: a notice's prose and a furniture set's checklist have no icons.
    { kind: 'notice', title: 'GIFTS', source: 's', items: [reward('Nothing Listed', 'material', 'x')], lines: [] },
  ] },
  [duelB]: { groups: [{ kind: 'missions', title: 'Event missions', source: 's', items: [reward('Duel Trophy', 'furniture', 'furni_enemyduel_diceAll_02'), reward('?', 'material', '30012')] },
    { kind: 'packs', title: 'PACKS', source: 's', items: [], packs: [{ name: 'Mystery Pack', contents: [{ name: 'TBD', count: 1, kind: 'permit' }] }] }] },
} };
// Both ran on Global (a player icon is held only from the record's Global start).
const ranOnGlobal = { dateRange: '2026/01/01–2026/01/14' };
const duelEvents = [{ name: duelA, activityId: 'act99duel', global: ranOnGlobal, rewards: [{ items: [{ name: 'Furniture not found' }] }] },
  { name: duelB, activityId: 'act98duel', global: ranOnGlobal, rewards: [{ items: [{ name: 'Duel Trophy', type: 'furniture' }, { name: '制式木盆', type: 'furniture' }, { name: 'Furniture not found' }, { name: 'Unseen Terrain', type: 'skin' }] }] }];
const filesOf = (events: object[]) => [...new Set(events.flatMap(event => eventRewardIcons(event, { eventStores, eventRewards }) as { file?: string }[]).flatMap(icon => (icon.file ? [icon.file] : [])))];
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

test('announcement reward aliases keep the official display name and use the same published art in rendering and release checks', () => {
  const name = 'Upcoming announcement';
  const reward = { name: 'New Model Data Terminal', iconName: 'Module Data Block', kind: 'other', id: 'announcement:terminal', count: 1 };
  const icons = eventRewardIcons({ name }, { eventStores: { events: {} }, eventRewards: { events: { [name]: { groups: [{ kind: 'login', items: [reward] }] } } } });
  assert.deepEqual(icons, [{ name: reward.name, file: 'material-icons/Module Data Block.webp' }]);
  assert.equal(rewardIconPath({ ...reward, type: 'material' }, outfitIcon, isPublished), '/material-icons/Module Data Block.webp');
});

test('the release holds every row the page lists without its icon that a stage can source: the wiki\'s store, the table rewards and the packs', () => {
  const [event] = duelEvents;
  // Row by row, the files rewardIconPath asks for: the trophy by the id A's rewards give it, the
  // unnamed table by its name, a player icon in profile-avatars, the free roll as the permit. Not
  // the upware, the charm coin or the pack's line of kind 'other': nothing can source them.
  assert.deepEqual(filesOf([event]), ['material-icons/furni_enemyduel_diceAll_01.webp', 'material-icons/Pizzeria Long Table.webp', 'material-icons/Module Data Block.webp',
    'profile-avatars/avatar_activity_ed3.webp', 'profile-avatars/avatar_activity_ed2.webp', 'material-icons/Orirock Cube.webp',
    'material-icons/Headhunting Permit.webp', 'material-icons/Orundum.webp']);
  const review = (assets: Set<string>) => reviewCompleteness(emptyCatalogue({ events: [event], eventStores, eventRewards, assets })).quarantine.map((entry: { reason: string }) => entry.reason);
  assert.deepEqual(review(published), [
    `${duelA} reward outfit Unseen Terrain: no published outfit icon`,
    `${duelA}: 5 reward icons not published: material-icons/Headhunting Permit.webp, material-icons/Orirock Cube.webp, material-icons/Orundum.webp and 2 more`,
  ]);
  // Each of those files is the one rewardIconPath asks for: once published, nothing is held.
  const all = new Set([...published, ...filesOf([event]), 'five-star-icons/Scene - Unseen Terrain.webp']);
  assert.deepEqual(review(all), []);
  assert.equal(rewardIconPath({ ...item('Pizzeria Long Table'), id: null }, outfitIcon, file => all.has(file)), '/material-icons/Pizzeria Long Table.webp');
  assert.equal(rewardIconPath({ ...item("Icon 'Perfect!'"), id: 'avatar_activity_ED2' }, outfitIcon, file => all.has(file)), '/profile-avatars/avatar_activity_ed2.webp');
  // Without the wiki's store the page shows the record's own, placeholder and all.
  assert.deepEqual(reviewCompleteness(emptyCatalogue({ events: [event], eventStores: { events: {} }, eventRewards, assets: all })).quarantine.map((entry: { reason: string }) => entry.reason),
    [`${duelA} reward "Furniture not found": a placeholder, not an item name`]);
  // B's own store: the trophy by B's id, not A's; the basin under its English name. Its "?" and
  // "TBD" are placeholders, held as such, never files.
  assert.deepEqual(filesOf([duelEvents[1]]), ['material-icons/furni_enemyduel_diceAll_02.webp', 'material-icons/Standard Wooden Basin.webp']);
  assert.deepEqual(reviewCompleteness(emptyCatalogue({ events: [duelEvents[1]], eventStores, eventRewards, assets: new Set([...all, ...filesOf([duelEvents[1]])]) })).quarantine.map((entry: { reason: string }) => entry.reason), [
    `${duelB} reward "Furniture not found": a placeholder, not an item name`, `${duelB} reward "?": a placeholder, not an item name`, `${duelB} reward "TBD": a placeholder, not an item name`]);
});

test('every reward icon the release holds is one import-reward-icons.py fetches or reports, and it asks for no other', () => {
  // Two rule sets over the same rows, in two languages. The importer once asked only for the kinds
  // the item table sorts while the release held every row the page lists: 116 files of 61 events
  // were held, and overdue on the daily issue three days later, with nothing that could ever fetch
  // or report them. Now neither side takes a row no source has an icon for (upware, a table reward
  // or a pack's line of kind 'other'), and neither takes a placeholder for a file.
  // profile-avatars/ is the image repository's own (it publishes the client's player icons); no
  // stage here fetches it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-reward-icons-'));
  try {
    const write = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(data)); };
    write('data/events/events_2099.json', duelEvents);
    write('data/event-stores.json', eventStores);
    write('data/event-rewards.json', eventRewards);
    const run = spawnSync('python3', [path.resolve('scripts/imports/import-reward-icons.py'), '--wanted'], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const wanted = (JSON.parse(run.stdout) as string[]).sort(byCodeUnit);
    const held = filesOf(duelEvents).filter(file => file.startsWith('material-icons/')).sort(byCodeUnit);
    assert.equal(held.length, 8, `the fixture still reaches every rule: ${held.join(', ')}`);
    assert.deepEqual(wanted, held);
    // The rows nothing can source, and the placeholders, are on neither side.
    for (const file of ['material-icons/Pastry Table.webp', 'material-icons/Gold Chip.webp', 'material-icons/Top Operator Transfer Permit.webp', 'material-icons/.webp', 'material-icons/TBD.webp']) {
      assert.ok(!wanted.includes(file) && !held.includes(file), file);
    }
    // And given every file the importer asks for (and the image repository's), the release holds no reward icon.
    const assets = new Set([...published, ...wanted, ...filesOf(duelEvents), 'five-star-icons/Scene - Unseen Terrain.webp']);
    assert.deepEqual(reviewCompleteness(emptyCatalogue({ events: duelEvents, eventStores, eventRewards, assets })).quarantine.map((entry: { reason: string }) => entry.reason),
      [`${duelB} reward "Furniture not found": a placeholder, not an item name`, `${duelB} reward "?": a placeholder, not an item name`, `${duelB} reward "TBD": a placeholder, not an item name`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a store row finds its piece of furniture whichever quotes each source wraps the name in, in the importer and the release alike', () => {
  // Dorothy's Vision: building_data names the pieces 'Contemplation' and 'Tree of Life', the wiki's
  // store "Contemplation" and "Tree of Life", the rerun's store Contemplation: no piece matched, so
  // the rows were asked for and held as "Contemplation".webp (issue #59, 2026-10-13).
  const vision = '[Side Story] Vision', rerun = '[Rerun] Vision Rerun';
  const pieces = { kind: 'furniture-set', title: 'Set', source: 's', items: [], pieces: [{ name: "'Contemplation'", id: 'furni_rhineLab_ceilingLight_01' }, { name: '\u2018Tree of Life\u2019', id: 'furni_rhineLab_plant_01' }] };
  const stores = { events: { [vision]: { stores: [{ name: 'Store', currency: 'Token', items: [row('"Contemplation"'), row('\u201cTree of Life\u201d'), row("Rock 'n' Roll")] }] },
    [rerun]: { stores: [{ name: 'Store', currency: 'Token', items: [row('Contemplation'), row('Tree of Life')] }] } } };
  const rewards = { events: { [vision]: { groups: [pieces] }, [rerun]: { groups: [pieces] } } };
  const events = [{ name: vision, activityId: 'act97side', rewards: [] }, { name: rerun, activityId: 'act97side_re', rewards: [] }];
  const held = [...new Set(events.flatMap(event => eventRewardIcons(event, { eventStores: stores, eventRewards: rewards }) as { file?: string }[]).flatMap(icon => (icon.file ? [icon.file] : [])))].sort(byCodeUnit);
  assert.deepEqual(held, ["material-icons/Rock 'n' Roll.webp", 'material-icons/furni_rhineLab_ceilingLight_01.webp', 'material-icons/furni_rhineLab_plant_01.webp']);
  assert.equal(furnitureKey('"Contemplation"'), 'Contemplation');
  assert.equal(furnitureKey("Rock 'n' Roll"), "Rock 'n' Roll", 'quotes inside a name stay');
  assert.equal(furnitureKey('"Mismatched\u2019'), '"Mismatched\u2019', 'only a matching pair is a wrapping');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-reward-quotes-'));
  try {
    const write = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(data)); };
    write('data/events/events_2099.json', events);
    write('data/event-stores.json', stores);
    write('data/event-rewards.json', rewards);
    const run = spawnSync('python3', [path.resolve('scripts/imports/import-reward-icons.py'), '--wanted'], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual((JSON.parse(run.stdout) as string[]).sort(byCodeUnit), held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an outfit reward named in Chinese finds its icon by its skin id, through the outfit records', () => {
  // Critical Phase Transition's login outfit is "阿罗玛 / 舒心野趣"; its icon is
  // five-star-icons/Aroma - Picnic Times.webp, the English name skins.json gives
  // char_446_aroma@epoque#54. By the Chinese name it was held for good (issue #59, 2026-10-13).
  const name = '[Celebration] Phase';
  const rewards = { events: { [name]: { groups: [{ kind: 'login', title: 'Login', source: 's', items: [reward('阿罗玛 / 舒心野趣', 'outfit', 'char_446_aroma@epoque#54')] }] } } };
  const skins = [{ name: 'Picnic Times', skinId: 'char_446_aroma@epoque#54' }];
  const review = (assets: Set<string>, records: object[]) => reviewCompleteness(emptyCatalogue({ events: [{ name, activityId: 'act96' }], eventStores: { events: {} }, eventRewards: rewards, skins: records, assets }))
    .quarantine.map((entry: { reason: string }) => entry.reason).filter((reason: string) => reason.includes('reward outfit'));
  const icon = new Set(['five-star-icons/Aroma - Picnic Times.webp']);
  assert.deepEqual(review(icon, skins), []);
  assert.deepEqual(review(new Set(), skins), [`${name} reward outfit Picnic Times: no published outfit icon`]);
  // An outfit the records do not have yet is still looked up by the name the reward gives.
  assert.deepEqual(review(icon, []), [`${name} reward outfit 舒心野趣: no published outfit icon`]);
});

test('an event\'s player icon is not held before the record dates its Global run, and is from that day on', () => {
  // Player icons come from Global's client alone: Dolly's Playground (Global unannounced) and two
  // crossovers estimated for November and February were held as overdue for them (issue #59).
  const name = '[Event] Playground';
  const rewards = { events: { [name]: { groups: [{ kind: 'milestones', title: 'Milestones', source: 's', items: [reward("Icon 'Play'", 'other', 'avatar_activity_PG1'), reward('Orirock Cube', 'material', '30013')] }] } } };
  const review = (global: object, now: string) => reviewCompleteness(emptyCatalogue({ events: [{ name, activityId: 'act95', global }], eventStores: { events: {} }, eventRewards: rewards, assets: new Set(), now: new Date(now) }))
    .quarantine.map((entry: { reason: string }) => entry.reason);
  const both = `${name}: 2 reward icons not published: material-icons/Orirock Cube.webp, profile-avatars/avatar_activity_pg1.webp`;
  const material = `${name}: 1 reward icon not published: material-icons/Orirock Cube.webp`;
  assert.deepEqual(review({ dateRange: null, note: 'Global release unannounced' }, '2026-10-13T00:00:00Z'), [material]);
  assert.deepEqual(review({ dateRange: '2026/11/07–2026/11/21', note: 'ESTIMATED Global date' }, '2026-10-13T00:00:00Z'), [material]);
  assert.deepEqual(review({ dateRange: '2026/11/07–2026/11/21', note: 'ESTIMATED Global date' }, '2026-11-07T12:00:00Z'), [both]);
  assert.deepEqual(review({ dateRange: '2025/01/01–2025/01/14' }, '2026-10-13T00:00:00Z'), [both]);
});

test('the kinds of table reward the release checks are the kinds the page lists', () => {
  assert.deepEqual([...LISTED_REWARD_KINDS].sort(), Object.entries(TABLE_REWARD_LABEL).filter(([, label]) => label).map(([kind]) => kind).sort());
});

test('Reward Tracker stages item-ID collisions and furniture but leaves portraits and abstract claims to their own pipelines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-free-reward-icons-'));
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/free-rewards.json'), JSON.stringify({ rewards: [{ rewards: [
      { id: 'permit_a', name: 'Shared Permit' }, { id: 'permit_b', name: 'Shared Permit' },
      { id: 'voucher_a', name: 'New Starter Voucher' }, { id: 'furniM_a', name: 'Furniture' },
      { id: 'char_a', name: 'Operator' }, { id: 'avatar_a', name: 'Avatar' },
      { id: 'GP_freeL_5', name: 'Free pack' }, { id: 'login:choice', name: 'Choice' },
    ] }] }));
    const run = spawnSync('python3', [path.resolve('scripts/imports/import-reward-icons.py'), '--wanted'], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['material-icons/New Starter Voucher.webp', 'material-icons/furniM_a.webp', 'material-icons/permit_a.webp', 'material-icons/permit_b.webp']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
