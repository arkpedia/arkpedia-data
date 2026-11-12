import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCNStores,
  eventActivity,
  cnStoreFallbacks,
  cnStorePage,
} from '../sync/cn-event-stores.mjs';
const fixture = (name) =>
  fs.readFileSync(
    new URL('./fixtures/cn-event-stores/' + name, import.meta.url),
    'utf8',
  );
test('real PRTS stores retain quantities, separate prices, repeated token tiers and unlimited stock', () => {
  const names = new Map([
    ['寻访凭证', { name: 'Headhunting Permit', id: '7003', type: 'material' }],
    ['八音蛋匠人', { name: 'Greyy / Eggcellent Craftsman', type: 'skin' }],
  ]);
  const stores = parseCNStores(fixture('unrealized-realities.txt'), names);
  assert.equal(stores.length, 1);
  const items = stores[0].items;
  assert.equal(items.filter((i) => /天空盒的信物/.test(i.name)).length, 5);
  assert.deepEqual(
    items.find((i) => i.id === '7003'),
    {
      id: '7003',
      name: 'Headhunting Permit',
      type: 'material',
      quantity: 1,
      stock: '3',
      price: 150,
    },
  );
  assert.equal(
    items.find((i) => i.name === '龙门币' && i.stock === '100').quantity,
    5000,
  );
  assert.ok(items.some((i) => i.stock === 'unlimited'));
  assert.ok(items.some((i) => i.type === 'skin'));
});
test('collaboration alchemy keeps finite pools and never invents unlimited payouts', () => {
  const stores = parseCNStores(fixture('thunder-alchemy.txt'), new Map());
  assert.equal(stores.length, 2);
  assert.equal(stores[0].items.find((i) => i.name === '寻访凭证').stock, '3');
  assert.equal(
    stores[0].items.find((i) => i.name === '数据增补仪').quantity,
    2,
  );
  assert.equal(stores[0].items.find((i) => i.name === '数据增补仪').stock, '5');
  assert.ok(stores[1].items.some((i) => i.stock === 'unlimited'));
});
test('CN survives passed Global dates, gains Global names and is replaced only by an available Global store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-stores-cn-'));
  try {
    const event = {
      name: '[Side Story] Test',
      activityId: 'act1side',
      cn: { dateRange: '2025/01/01–2025/01/15' },
      global: { dateRange: '2025/07/01–2025/07/15' },
    };
    const act = {
      id: 'act1side',
      name: '测试',
      type: 'TYPE_ACT9D0',
      isReplicate: false,
      startTime: Date.parse('2025-01-01T08:00:00Z') / 1000,
    };
    const cn = {
      activity: { basicInfo: { act1side: act } },
      items: {
        items: {
          7003: { itemId: '7003', name: '寻访凭证', itemType: 'TKT_GACHA' },
        },
      },
    };
    const en = {
      activity: { basicInfo: {} },
      items: {
        items: {
          7003: {
            itemId: '7003',
            name: 'Headhunting Permit',
            itemType: 'TKT_GACHA',
          },
        },
      },
    };
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          parse: {
            wikitext: {
              '*': '==商店==\n|token_alias=货币\n1;;{{道具图标|寻访凭证}};;3;;150;;金',
            },
          },
        }),
      );
    const first = await cnStoreFallbacks(
      root,
      [event],
      {},
      { tables: { cn, en }, fetcher, now: Date.parse('2026-01-01') },
    );
    assert.equal(first[event.name].region, 'CN');
    assert.equal(
      first[event.name].stores[0].items[0].name,
      'Headhunting Permit',
    );
    const kept = await cnStoreFallbacks(
      root,
      [event],
      {},
      {
        tables: { cn, en },
        fetcher: async () => {
          throw Error('offline');
        },
        now: Date.parse('2026-01-03'),
      },
    );
    assert.deepEqual(kept, first);
    en.activity.basicInfo.act1side = {
      ...act,
      startTime: Date.parse('2025-07-01T08:00:00Z') / 1000,
    };
    const global = {
      stores: [{ name: 'Global shop', currency: 'Token', items: [] }],
    };
    const promoted = await cnStoreFallbacks(
      root,
      [event],
      { [event.name]: global },
      { tables: { cn, en }, fetcher },
    );
    assert.equal(promoted[event.name].region, 'Global');
    assert.equal(promoted[event.name].stores[0].name, 'Global shop');
    assert.equal(
      eventActivity({ ...event, name: '[Rerun] Test Rerun' }, cn, 'CN'),
      null,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native client exchange stock uses the real per-draw quantities and finite limits', async () => {
  const { clientStores } = await import('../sync/cn-event-stores.mjs');
  const data = JSON.parse(fixture('thunder-client.json'));
  const tables = {
    activity: { activity: { TYPE_ACT24SIDE: { act50side: data } } },
    items: { items: { 7003: { name: 'Headhunting Permit' } } },
  };
  const stores = clientStores(
    { type: 'TYPE_ACT24SIDE', id: 'act50side' },
    tables,
  );
  assert.equal(stores.length, 2);
  assert.equal(stores[0].items.find((item) => item.id === '7003').stock, '3');
  assert.equal(
    stores[0].items.filter((item) => item.type === 'furniture').length,
    13,
  );
  assert.ok(
    stores[0].items
      .filter((item) => item.type === 'furniture')
      .every((item) => item.quantity === 1 && item.stock === '1'),
  );
  assert.ok(
    stores[1].items.some(
      (item) => item.quantity === 200 && item.stock === '10',
    ),
  );
});

test('rerun pages use their own CN release year and date-only matching excludes side activities', () => {
  assert.equal(
    cnStorePage({
      name: '落叶逐火·复刻',
      isReplicate: true,
      startTime: Date.parse('2026-03-01') / 1000,
    }),
    '落叶逐火2026',
  );
  assert.equal(
    cnStorePage({ name: '落叶逐火', isReplicate: false, startTime: 0 }),
    '落叶逐火',
  );
  const event = { name: 'Test', cn: { dateRange: '2025/01/01–2025/01/15' } };
  assert.equal(
    eventActivity(
      event,
      {
        activity: {
          basicInfo: {
            login: {
              id: 'login',
              name: 'Login',
              type: 'TYPE_ACT9D0',
              startTime: Date.parse('2025-01-01T08:00:00Z') / 1000,
            },
          },
        },
      },
      'CN',
    ),
    null,
  );
});

test('an unsupported profile-theme icon does not remove the other store inventory', () => {
  const stores = parseCNStores("1;;[[文件:界面主题 迷城 道具.png|30px]] '''界面主题''' 迷城;;1;;500\n1;;{{道具图标|寻访凭证}};;3;;150", new Map());
  assert.equal(stores[0].items.length, 2);
  assert.equal(stores[0].items[0].type, 'upware');
  assert.equal(stores[0].items[1].stock, '3');
});


test('Sharpened by Flame rerun has its own 33 alchemy listings, not the original operator tokens', async () => {
  const { clientStores } = await import('../sync/cn-event-stores.mjs');
  const data = JSON.parse(fixture('flurry-rerun-client.json'));
  const tables = { activity: { activity: { TYPE_ACT24SIDE: { act24sre: data } } }, items: { items: { 7003: { name: 'Headhunting Permit' } } } };
  const stores = clientStores({type:'TYPE_ACT24SIDE',id:'act24sre'}, tables);
  assert.deepEqual(stores.map(store => store.items.length), [13,20]);
  assert.equal(stores[0].items.find(item => item.id === '7003').stock, '3');
  assert.equal(stores[0].items.find(item => item.id === '7003').quantity, 1);
  assert.ok(!stores.flatMap(store => store.items).some(item => item.id === 'p_char_4077_palico'));
});
