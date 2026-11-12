import fs from 'node:fs';
import path from 'node:path';
import { eventWindow, isRerun } from '../lib/event-records.mjs';
import { USER_AGENT } from './wiki-pages.mjs';
import { rewardNamer } from '../build/build-event-rewards.mjs';

const read = (dir, file) => {
  const p = path.join(dir, file + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
export function storeTables(root) {
  const load = (dir) => ({
    activity: read(dir, 'activity_table'),
    items: read(dir, 'item_table'),
    characters: read(dir, 'character_table'),
    skins: read(dir, 'skin_table'),
    building: read(dir, 'building_data'),
  });
  return {
    cn: load(
      path.join(
        process.env.ARKPEDIA_CN ||
          path.join(root, '.cache/upstream/cn-resource'),
        'gamedata/excel',
      ),
    ),
    en: load(
      path.join(
        process.env.ARKPEDIA_EN ||
          path.join(root, '.cache/upstream/en-gamedata'),
        'en/gamedata/excel',
      ),
    ),
  };
}
export function eventActivity(event, tables, region) {
  const start = eventWindow(event, region)?.start;
  const entries = Object.values(tables?.activity?.basicInfo ?? {}).filter(
    (a) =>
      !/(?:SIGN|LOGIN|CHECKIN|PRAY)/.test(a.type) &&
      !!a.isReplicate === isRerun(event.name),
  );
  return (
    entries.find(
      (a) =>
        a.id === event.activityId &&
        start != null &&
        Math.abs(a.startTime * 1000 - start) <= 86400000,
    ) ??
    (() => {
      const matches = entries.filter(
        (a) =>
          (a.hasStage || /SIDE|MINISTORY/.test(a.type)) &&
          start != null &&
          Math.abs(a.startTime * 1000 - start) <= 86400000,
      );
      return matches.length === 1 ? matches[0] : null;
    })()
  );
}
export function storeNames(cn, en) {
  const english = rewardNamer(en),
    local = rewardNamer(cn),
    map = new Map();
  const add = (id, type) => {
    const raw = { id, type, count: 1 },
      c = local(raw),
      e = english(raw);
    map.set(c.name, {
      id,
      name: e.name === id ? c.name : e.name,
      type:
        c.kind === 'outfit'
          ? 'skin'
          : c.kind === 'furniture'
            ? 'furniture'
            : c.kind === 'operator'
              ? 'operator'
              : 'material',
    });
  };
  for (const i of Object.values(cn.items?.items ?? {}))
    add(i.itemId, i.itemType);
  for (const id of Object.keys(cn.building?.customData?.furnitures ?? {}))
    add(id, 'FURN');
  for (const id of Object.keys(cn.characters ?? {})) add(id, 'CHAR');
  for (const [id, s] of Object.entries(cn.skins?.charSkins ?? {})) {
    add(id, 'CHAR_SKIN');
    const n = local({ id, type: 'CHAR_SKIN', count: 1 });
    if (s.displaySkin?.skinName)
      map.set(s.displaySkin.skinName, {
        id,
        name:
          english({ id, type: 'CHAR_SKIN', count: 1 }).name === id
            ? n.name
            : english({ id, type: 'CHAR_SKIN', count: 1 }).name,
        type: 'skin',
      });
  }
  return map;
}
const itemFrom = (cell, names) => {
  const m = cell.match(
    /\{\{(道具图标|材料消耗|家具|皮肤头像)\|([^|}]+)(?:\|([^|}]*))?/,
  );
  if (!m) {
    // A profile theme is real stock too; it must not discard the rest of a shop.
    const theme = cell.match(/'''界面主题'''\s*([^<]+)$/)?.[1]?.trim();
    return theme ? { name: '界面主题 ' + theme, type: 'upware', quantity: 1 } : null;
  }
  let key = m[2].trim();
  if (m[1] === '皮肤头像') {
    const outfit = cell
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/<[^>]+>|'''/g, '')
      .replace(/.*专属时装[’']?\s*/, '')
      .trim();
    if (names.has(outfit)) key = outfit;
    else {
      const op = names.get(m[2].trim())?.name ?? m[2].trim();
      return { name: op + ' / ' + outfit, type: 'skin', quantity: 1 };
    }
  }
  const named = names.get(key) ?? {
    name: key,
    type: m[1] === '家具' ? 'furniture' : 'material',
  };
  const multiplier = cell.match(/[×x]\s*([\d,]+)/)?.[1];
  return {
    ...named,
    quantity: multiplier
      ? Number(multiplier.replace(/,/g, ''))
      : /^\d+(万|千)?$/.test(m[3] ?? '')
        ? parseInt(m[3]) *
          (m[3].endsWith('万') ? 10000 : m[3].endsWith('千') ? 1000 : 1)
        : 1,
  };
};
/** PRTS's shared EventShopList contract, plus finite alchemy reward pools. Never infer random unlimited payouts. */
export function parseCNStores(text, names) {
  const stores = [];
  let heading = 'Event store';
  let store = null;
  let currency = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^==+([^=]+)==+$/);
    if (h) {
      heading = h[1].trim();
      store = null;
    }
    const token = line.match(/\|token_alias=(?:带框_)?([^\n]+)/);
    if (token) currency = names.get(token[1].trim())?.name ?? token[1].trim();
    if (/^\s*[01];;/.test(line)) {
      const cells = line.trim().split(';;'),
        item = itemFrom(cells[1] ?? '', names);
      if (!item) throw Error('Unrecognized CN store item: ' + cells[1]);
      if (!/^(?:\d+|∞)$/.test(cells[2]) || !/^\d+$/.test(cells[3]))
        throw Error('Invalid CN stock/price');
      if (!store) {
        store = { name: heading, currency, items: [] };
        stores.push(store);
      }
      store.items.push({
        ...item,
        stock: cells[2] === '∞' ? 'unlimited' : cells[2],
        price: Number(cells[3]),
      });
    }
  }
  // Collaboration alchemy tables have rows of icons followed by their finite stock counts.
  for (const table of text.matchAll(
    /\{\|[^\n]*event-alchemy-table[\s\S]*?\n\|\}/g,
  )) {
    const title =
      table[0].match(/colspan="?5"?\|([^\n]+)/)?.[1]?.trim() ?? 'Alchemy';
    const items = [];
    let pending = [];
    for (const row of table[0].split(/\n\|-[^\n]*\n/)) {
      if (/\{\{(?:道具图标|家具)\|/.test(row)) {
        pending = row
          .split(/\n\||\|\|/)
          .filter((c) => c.includes('{{'))
          .map((c) => itemFrom(c, names));
      } else if (pending.length && /×|∞/.test(row)) {
        const stock = [...row.matchAll(/×\s*(\d+)|∞/g)].map((m) => m[1] ?? '∞');
        if (stock.length !== pending.length)
          throw Error('Incomplete alchemy stock row');
        pending.forEach((item, i) => {
          if (item)
            items.push({
              ...item,
              stock: stock[i] === '∞' ? 'unlimited' : stock[i],
              price: null,
            });
        });
        pending = [];
      }
    }
    if (items.length)
      stores.push({ name: title, currency: 'Alchemy points', items });
  }
  return stores;
}
/** Some collaboration exchanges are fully specified in the client; prefer these over either wiki. */
export function clientStores(activity, tables, english = tables) {
  const data = tables.activity?.activity?.[activity?.type]?.[activity?.id];
  if (!data?.meldingGachaBoxGoodDataMap) return [];
  const local = rewardNamer(tables),
    en = rewardNamer(english);
  return Object.entries(data.meldingGachaBoxGoodDataMap).map(([id, goods]) => ({
    name: data.meldingGachaBoxDataList?.[id]?.gachaBoxName ?? id,
    currency: 'Alchemy points',
    items: [...goods]
      .sort((a, b) => a.orderId - b.orderId)
      .map((good) => {
        const raw = {
          id: good.itemId,
          type: good.itemType,
          count: good.perCount,
        };
        const translated = en(raw),
          item = translated.name === good.itemId ? local(raw) : translated;
        return {
          id: good.itemId,
          name: item.name,
          type:
            item.kind === 'furniture'
              ? 'furniture'
              : item.kind === 'outfit'
                ? 'skin'
                : item.kind === 'operator'
                  ? 'operator'
                  : 'material',
          quantity: good.perCount,
          stock:
            good.gachaType === 'LIMITED'
              ? String(good.totalCount)
              : 'unlimited',
          price: null,
        };
      }),
  }));
}
/** PRTS gives reruns their CN release year, rather than the client’s ·复刻 suffix. */
export function cnStorePage(activity) {
  return activity.isReplicate && /[·・]复刻$/.test(activity.name)
    ? activity.name.replace(/[·・]复刻$/, '') +
        new Date((activity.startTime + 8 * 3600) * 1000).getUTCFullYear()
    : activity.name;
}
export async function cnStoreFallbacks(
  root,
  events,
  existing,
  {
    fetcher = fetch,
    now = Date.now(),
    tables = storeTables(root),
    report = () => {},
  } = {},
) {
  if (!tables.cn.activity || !tables.en.activity) return existing;
  const names = storeNames(tables.cn, tables.en),
    out = { ...existing };
  const dir = path.join(root, 'data/wiki-cache/event-stores');
  fs.mkdirSync(dir, { recursive: true });
  for (const event of events) {
    const cn = eventActivity(event, tables.cn, 'CN'),
      en = eventActivity(event, tables.en, 'Global');
    const fromEN = en && clientStores(en, tables.en);
    if (fromEN?.length) {
      out[event.name] = {
        page: en.name,
        source: 'Global activity_table ' + en.id,
        region: 'Global',
        stores: fromEN,
      };
      continue;
    }
    if (
      en &&
      out[event.name]?.region !== 'CN' &&
      out[event.name]?.stores?.length
    ) {
      out[event.name] = { ...out[event.name], region: 'Global' };
      continue;
    }
    if (!cn) continue;
    const fromCN = clientStores(cn, tables.cn, tables.en);
    if (fromCN.length) {
      out[event.name] = {
        page: cn.name,
        source: 'CN activity_table ' + cn.id,
        region: 'CN',
        stores: fromCN,
      };
      continue;
    }
    const page = cnStorePage(cn);
    const file = path.join(dir, `CN-${cn.id}.json`),
      cached = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : null;
    let entry = cached;
    if (!cached || now - (cached.checkedAt ?? 0) > 86400000) {
      try {
        const url = new URL('https://prts.wiki/api.php');
        url.search = new URLSearchParams({
          action: 'parse',
          page,
          prop: 'wikitext',
          format: 'json',
          redirects: '1',
        });
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetcher(url, {
            signal: AbortSignal.timeout(30000),
            headers: { 'user-agent': USER_AGENT },
          });
          if (
            response.ok ||
            ![429, 502, 503, 504].includes(response.status) ||
            attempt === 2
          )
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1)),
          );
        }
        if (!response.ok) throw Error('CN store HTTP ' + response.status);
        const body = await response.json();
        const text = body.parse?.wikitext?.['*'];
        if (typeof text !== 'string')
          throw Error(
            'CN store page unavailable: ' +
              (body.error?.code ?? 'missing wikitext'),
          );
        const stores = parseCNStores(text, names);
        if (stores.length || !cached?.stores?.length) {
          entry = {
            page,
            source: `https://prts.wiki/w/${encodeURIComponent(page)}`,
            region: 'CN',
            stores,
            checkedAt: now,
          };
          fs.writeFileSync(file, JSON.stringify(entry, null, 1) + '\n');
        }
      } catch (error) {
        report(event.name, {
          page,
          problem: error.message,
          kept: !!cached?.stores?.length,
        });
      }
    }
    if (entry?.stores?.length)
      out[event.name] = {
        page: entry.page,
        source: entry.source,
        region: 'CN',
        stores: entry.stores,
      };
    else if (out[event.name])
      out[event.name] = { ...out[event.name], region: en ? 'Global' : 'CN' };
  }
  return out;
}
