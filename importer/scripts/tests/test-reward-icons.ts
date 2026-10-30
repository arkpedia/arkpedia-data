import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { eventRewardIcons, reviewCompleteness } from '../content/check-completeness.mjs';
import { furnitureKey } from '../../lib/events/furnitureName.mjs';
import { emptyCatalogue } from './fixtures/catalogue';

/* What scripts/imports/import-reward-icons.py fetches, against what the release holds for want
   of it. The application holds the other side -- which file a row's icon is, and that its pages
   ask for no other (arkpedia-app scripts/tests/test-reward-icons.ts). */
const published = new Set(['material-icons/Module Data Block.webp', 'material-icons/制式木盆.webp',
  'material-icons/furni_enemyduel_diceAll_01.webp', 'profile-avatars/avatar_activity_ed3.webp',
  'five-star-icons/Kestrel - Charm of The Tiles.webp', 'five-star-icons/Kestrel - Base.webp', 'four-star-icons/Ethan - Infiltrator.webp']);

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
  const pieces = { kind: 'furniture-set', title: 'Set', source: 's', items: [], pieces: [{ name: "'Contemplation'", id: 'furni_rhineLab_ceilingLight_01' }, { name: '‘Tree of Life’', id: 'furni_rhineLab_plant_01' }] };
  const stores = { events: { [vision]: { stores: [{ name: 'Store', currency: 'Token', items: [row('"Contemplation"'), row('“Tree of Life”'), row("Rock 'n' Roll")] }] },
    [rerun]: { stores: [{ name: 'Store', currency: 'Token', items: [row('Contemplation'), row('Tree of Life')] }] } } };
  const rewards = { events: { [vision]: { groups: [pieces] }, [rerun]: { groups: [pieces] } } };
  const events = [{ name: vision, activityId: 'act97side', rewards: [] }, { name: rerun, activityId: 'act97side_re', rewards: [] }];
  const held = [...new Set(events.flatMap(event => eventRewardIcons(event, { eventStores: stores, eventRewards: rewards }) as { file?: string }[]).flatMap(icon => (icon.file ? [icon.file] : [])))].sort(byCodeUnit);
  assert.deepEqual(held, ["material-icons/Rock 'n' Roll.webp", 'material-icons/furni_rhineLab_ceilingLight_01.webp', 'material-icons/furni_rhineLab_plant_01.webp']);
  assert.equal(furnitureKey('"Contemplation"'), 'Contemplation');
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
