import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { campaignLinks, campaignUrl, campaignWindow, discoverCampaigns, readCampaign, REGIONS, syncWebEvents } from '../sync/sync-community-web-events.mjs';

const NOW = Date.parse('2026-10-09T00:00:00Z');
const periods = {
  en: '10/08, 2026, 00:00 – 11/07, 2026, 19:59 (UTC-7)',
  kr: '이벤트 시간: 2026년 10월 8일 ~ 2026년 11월 8일 11:59',
  jp: '開催期間：2026年10月08日 16:00 ～ 2026年11月08日 11:59',
};
const rules = text => JSON.stringify({ rule: { duration: [text] } });
const campaign = region => `https://journey.${region.domain}/`;
const art = 'https://webusstatic.yo-star.com/campaign/share.png';
const html = (url, name = 'Journey', image = art) => `<meta content="${url}" property="og:url"><meta property="og:title" content="${name}"><meta content="${image}" property="og:image"><script src="/index.js"></script>`;

function fixture({ empty = false, broken = [], invalid = {}, imageStatus = 200, cafeOnly = false } = {}) {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET' });
    if (broken.some(prefix => url.startsWith(prefix))) throw new Error('Fixture outage');
    if (url === art) return new Response(null, { status: imageStatus, headers: { 'content-type': 'image/png' } });
    for (const region of REGIONS) {
      if (url === `https://www.${region.domain}/api/resource/home`) return Response.json({ code: 0, data: {} });
      if (url.includes(`www.${region.domain}/api/resource/news/list`)) return Response.json({ code: 0, data: { rows: !empty && !cafeOnly && region.id === 'en' ? [{ id: 999, publishTime: NOW, content: `<a href="${campaign(region)}?utm_source=official">Join</a>` }] : [] } });
      if (url === campaign(region)) return new Response(html(url));
      if (url === `${campaign(region)}index.js`) return new Response(`throw new Error('This script must never execute'); ${rules(invalid[region.id] ?? periods[region.id])}`);
    }
    if (url.includes('cafe-boardlist-api')) return Response.json({ result: { articleList: !empty && cafeOnly ? [{ item: { menuId: 3, articleId: 123, writeDateTimestamp: NOW, subject: '특별 웹 콘텐츠 안내' } }] : [] } });
    if (url === 'https://article.cafe.naver.com/gw/v4/cafes/29703924/articles/123') return Response.json({ result: { article: { menu: { id: 3 }, contentHtml: `<a href="${campaign(REGIONS[1])}?utm_source&#x3D;official&amp;utm_medium&#x3D;link">Join</a>` } } });
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetcher, requests };
}

test('regional rules keep their timezone, exact opening time and final minute', () => {
  for (const region of REGIONS) {
    const window = campaignWindow(rules(periods[region.id]), region);
    assert.equal(window.expiresAt, '2026-11-08T03:00:00.000Z');
    assert.equal(window.end, region.id === 'en' ? '2026-11-07' : '2026-11-08');
    assert.equal(window.opensAt, region.id === 'kr' ? undefined : '2026-10-08T07:00:00.000Z');
  }
  assert.equal(campaignWindow('DURATION: December 20, 2026, 10:00 – January 2, 2027, 03:59 (UTC-7)', REGIONS[0]).expiresAt, '2027-01-02T11:00:00.000Z');
  assert.equal(campaignWindow(JSON.stringify(rules(periods.jp)), REGIONS[2]).expiresAt, '2026-11-08T03:00:00.000Z');
});

test('invalid, incomplete and conflicting periods are held for review', () => {
  assert.throws(() => campaignWindow(rules('02/31, 2026, 00:00 – 03/07, 2026, 19:59 (UTC-7)'), REGIONS[0]), /Invalid/);
  assert.throws(() => campaignWindow(rules('February 31, 2026, 00:00 – March 7, 2026, 19:59 (UTC-7)'), REGIONS[0]), /Invalid/);
  assert.throws(() => campaignWindow(rules(periods.en.replace('UTC-7', 'UTC+8')), REGIONS[0]), /No complete/);
  assert.throws(() => campaignWindow(rules(`${periods.jp} (UTC+8)`), REGIONS[2]), /No complete/);
  assert.throws(() => campaignWindow(rules(periods.kr.replace('11:59', '')), REGIONS[1]), /No complete/);
  assert.throws(() => campaignWindow(`${rules(periods.en)} ${rules(periods.en.replace('11/07', '11/06'))}`, REGIONS[0]), /Conflicting/);
});

test('only campaign entry links on official regional subdomains are followed', () => {
  assert.equal(campaignUrl('https://journey.arknights.global/?utm_source=official', REGIONS[0]), campaign(REGIONS[0]));
  for (const url of ['https://journey.arknights.global.evil.test/', 'https://www.arknights.global/news/123', 'https://user.arknights.global/', 'http://journey.arknights.global/', 'https://journey.arknights.global/submit', 'https://journey.arknights.global:8443/', 'https://user:password@journey.arknights.global/']) assert.equal(campaignUrl(url, REGIONS[0]), null);
  assert.deepEqual(campaignLinks('<a href="https://journey.arknights.kr?utm_source&#x3D;official&amp;utm_medium&#x3D;link">Join</a>', REGIONS[1]), [campaign(REGIONS[1])]);
});

test('the KR official board discovers an unseeded campaign and its regional candidates', async () => {
  const mock = fixture({ cafeOnly: true });
  const candidates = await discoverCampaigns({ fetcher: mock.fetcher, now: NOW });
  assert.equal(candidates.size, 3);
  assert.equal(candidates.get(campaign(REGIONS[1])).announced, true);
  assert.equal(candidates.get(campaign(REGIONS[0])).announced, false);
  assert.equal(mock.requests.filter(request => request.url.includes('gw/v4')).length, 1, 'duplicate board and notice references fetch the article once');
});

test('localized candidates require their own canonical URL and rules; scripts are never executed', async () => {
  const mock = fixture();
  const event = await readCampaign(campaign(REGIONS[0]), REGIONS[0], { fetcher: mock.fetcher });
  assert.equal(event.image, art);
  assert.equal(event.closingTime, '19:59 (UTC−7)');
  assert.ok(mock.requests.some(request => request.method === 'HEAD' && request.url === art));
  await assert.rejects(readCampaign(campaign(REGIONS[0]), REGIONS[0], { fetcher: async () => new Response(html(campaign(REGIONS[2]))) }), /canonical/);
  const withoutArt = await readCampaign(campaign(REGIONS[0]), REGIONS[0], { fetcher: fixture({ imageStatus: 404 }).fetcher });
  assert.equal(withoutArt.image, undefined);
});

test('discovery publishes unseeded records, retains them during outages, and does not churn daily', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-events-'));
  try {
    const first = await syncWebEvents(root, { seeds: [], fetcher: fixture({ cafeOnly: true }).fetcher, now: NOW });
    assert.equal(first.length, 3);
    assert.ok(first.every(event => event.image && event.sourceUrl.includes('articles/123')));
    const before = fs.readFileSync(path.join(root, 'data/community-web-events.json'), 'utf8');
    await syncWebEvents(root, { seeds: [], fetcher: fixture({ cafeOnly: true }).fetcher, now: NOW + 86400_000 });
    assert.equal(fs.readFileSync(path.join(root, 'data/community-web-events.json'), 'utf8'), before);
    await syncWebEvents(root, { seeds: [], fetcher: fixture({ broken: ['https://'] }).fetcher, now: NOW + 86400_000 });
    assert.equal(fs.readFileSync(path.join(root, 'data/community-web-events.json'), 'utf8'), before);
    const quarantine = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8'));
    assert.ok(quarantine.entries.some(entry => entry.key.startsWith('campaign:') && entry.action === 'kept-previous'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unverifiable regional sibling is not published on the strength of another region', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-events-'));
  try {
    const events = await syncWebEvents(root, { seeds: [], fetcher: fixture({ invalid: { jp: 'Deadline coming soon' } }).fetcher, now: NOW });
    assert.deepEqual(events.map(event => event.region).sort(), ['Global (EN)', 'Korea (KR)']);
    const quarantine = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8'));
    assert.ok(quarantine.entries.some(entry => entry.key === `campaign:${campaign(REGIONS[2])}` && entry.action === 'omitted-new'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('year-first periods parse, as in Kal\'tsit\'s Archives\' rules (a start with no time opens that day)', () => {
  const window = campaignWindow(rules('Event Period: 2026/10/13-2026/10/19 12:59 (UTC-7).'), REGIONS[0]);
  assert.deepEqual(window, { start: '2026-10-13', end: '2026-10-19', closingTime: '12:59 (UTC−7)', expiresAt: '2026-10-19T20:00:00.000Z' });
  assert.equal(campaignWindow(rules('2026/10/13 04:00 – 2026/10/19 12:59 (UTC-7)'), REGIONS[0]).opensAt, '2026-10-13T11:00:00.000Z');
  assert.throws(() => campaignWindow(rules('2026/10/13 – 2026/10/19 (UTC-7)'), REGIONS[0]), /No complete/);
});

test('a window read by a person from an official rules image stands while its page still verifies', async () => {
  // Kal'tsit's Archives (2026-10-13) was announced only on the official X account and gives its
  // period only as an image: the page verifies but carries no text window.
  for (const curated of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-events-'));
    try {
      const record = { name: 'Journey', region: 'Global (EN)', start: '2026-10-08', end: '2026-11-07', closingTime: '19:59 (UTC−7)',
        expiresAt: '2026-11-08T03:00:00.000Z', url: campaign(REGIONS[0]), image: art, sourceUrl: campaign(REGIONS[0]), ...(curated ? { windowSource: 'official rules image' } : {}) };
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data/community-web-events.json'), JSON.stringify([record]));
      const events = await syncWebEvents(root, { seeds: [], fetcher: fixture({ empty: true, invalid: { en: 'The rules are an image' } }).fetcher, now: NOW });
      assert.deepEqual(events, [record], 'the record stands either way');
      const quarantine = fs.existsSync(path.join(root, 'data/quarantine.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8')).entries : [];
      assert.equal(quarantine.some(entry => entry.key === `campaign:${campaign(REGIONS[0])}`), !curated, curated ? 'no nightly report' : 'an uncurated record is still reported');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
