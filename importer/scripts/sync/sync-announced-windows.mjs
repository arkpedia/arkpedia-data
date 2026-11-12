#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readOfficialNews } from './sync-official-news.mjs';
import { reconcileGlobalEventNotices } from './global-event-notices.mjs';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';

const root = process.cwd(), now = defaultNow();
const stage = beginStage(root, 'announced-windows', now);
const files = fs.readdirSync(path.join(root, 'data/events')).filter(file => /^events_\d{4}\.json$/.test(file))
  .map(file => ({ path: path.join(root, 'data/events', file), rows: JSON.parse(fs.readFileSync(path.join(root, 'data/events', file), 'utf8')) }));
const bannerPath = path.join(root, 'data/headhunting_banners.json');
const banners = JSON.parse(fs.readFileSync(bannerPath, 'utf8'));
const snapshots = files.map(file => JSON.stringify(file.rows));
const oldBanners = JSON.stringify(banners);
const changes = reconcileGlobalEventNotices({ events: files.flatMap(file => file.rows), banners, posts: readOfficialNews(root), now: now.getTime(),
  onProblem: (post, reason) => stage.add({ key: `notice:${post.id}`, action: 'kept-previous', sourceRef: post.url, reason }) });
files.forEach((file, index) => { if (JSON.stringify(file.rows) !== snapshots[index]) fs.writeFileSync(file.path, JSON.stringify(file.rows, null, 2) + '\n'); });
if (JSON.stringify(banners) !== oldBanners) fs.writeFileSync(bannerPath, JSON.stringify(banners, null, 2) + '\n');
stage.commit();
console.log(`Official EN windows: ${changes.length} update(s). ${changes.join('; ')}`);
