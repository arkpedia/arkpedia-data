#!/usr/bin/env node
import { reconcileCatalogueBaseSkills } from '../imports/import-base-skills.mjs';
import { reconcileBaseRosters } from '../imports/import-base-rosters.mjs';
import { baseWorkshopRecipes } from '../imports/import-base-workshop.mjs';
/** Discover content before derived pages are compiled. --dry-run never writes source records. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reconcileOperators, reconcileSkins, reconcileCalendars, operatorReleaseDates, renameReferences, renameAlternates, mergeMedia, serverDay, safeName, rarityWord, onYearlyPage, inGlobalClient } from './catalogue-model.mjs';
import { buildInventory, withStableSource } from './sync-content-inventory.mjs';
import { readWikiRows } from './wiki-pages.mjs';
import { beginStage } from '../lib/quarantine.mjs';
import { cnAnnouncements } from '../build/cn-news.mjs';
import { readCnNews } from './sync-cn-news.mjs';
import { readOfficialBulletins } from './sync-official-bulletins.mjs';
import { applyBoardEvents, boardBannerMedia } from './board-events.mjs';
import { cnTables, pinnedCommit } from '../content/pin-upstream.mjs';
const read = p => JSON.parse(fs.readFileSync(p,'utf8'));
const write = (p,data) => { if (fs.existsSync(p) && JSON.stringify(read(p)) === JSON.stringify(data)) return; fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n'); };
// The tables source() fetches, by key; sync-operator-english.mjs reads its own by these keys too.
export const tableFiles = { characters:'character_table.json', skins:'skin_table.json', skills:'skill_table.json', items:'item_table.json', building:'building_data.json', handbook:'handbook_info_table.json', modules:'uniequip_table.json', battleEquip:'battle_equip_table.json', activity:'activity_table.json', gacha:'gacha_table.json', voices:'charword_table.json', constants:'gamedata_const.json', patch:'char_patch_table.json' };
async function json(url) {
  const response = await fetch(url,{signal:AbortSignal.timeout(60000),headers: url.startsWith('https://api.github.com/') && process.env.GH_TOKEN ? {Authorization:`Bearer ${process.env.GH_TOKEN}`} : {}});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
/** The commit this run pinned for a mirror (run-stage.mjs), else its branch head from the API. */
export const revision = (repo, env = process.env) => pinnedCommit(repo, async (repository, branch) => {
  const {sha} = await json(`https://api.github.com/repos/${repository}/commits/${branch}`);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid revision: ${repository}`);
  return sha;
}, env);
/** The tables of one regional mirror under `folder`, at `commit`, else the commit this run
 * pinned for it, else its branch head. */
export async function source(repo, folder, cache, env = process.env, commit = null) {
  const sha = commit ?? await revision(repo, env);
  const base = `https://raw.githubusercontent.com/${repo}/${sha}/${folder}`;
  const result = {source:base, revision:sha, repository:`https://github.com/${repo}`};
  // Bound concurrency and persist immutable inputs so a failed run is reproducible.
  for (const [key,file] of Object.entries(tableFiles)) {
    const target = path.join(cache,repo.replace('/','-'),sha,file);
    result[key] = fs.existsSync(target) ? read(target) : await json(`${base}/${file}`);
    if (!fs.existsSync(target)) write(target,result[key]);
  }
  if (Object.keys(result.characters ?? {}).length < 400 || Object.keys(result.skins?.charSkins ?? {}).length < 500
    || Object.keys(result.skills ?? {}).length < 500 || Object.keys(result.handbook?.handbookDict ?? {}).length < 300
    || !Array.isArray(result.gacha?.gachaPoolClient) || result.gacha.gachaPoolClient.length < 100
    || !result.activity?.basicInfo || !Array.isArray(result.constants?.evolveGoldCost)) throw new Error(`Truncated or changed regional source schema: ${repo}`);
  if (folder.startsWith('en/') && Object.values(result.characters).filter(c=>c.name && !/\p{Script=Han}/u.test(c.name)).length < 300)
    throw new Error('Global mirror does not contain an English roster');
  // Everything below reads enums by name ("TIER_6", "LIMITED"). The CN fallback mirror numbers
  // them, and read as names they would misfile every operator and banner: refuse it, and this
  // stage keeps its records as last published until the primary mirror is back. By the most of
  // them, not every one: a mirror that names enums still numbers a value its decoder does not
  // know yet (the Global mirror's RETURN_EN_41_0_1 pool is gachaRuleType 11 in 2026-09).
  const numbered = values => values.filter(value => typeof value === 'number').length * 2 > values.length;
  if (numbered(Object.values(result.characters).map(c => c?.rarity)) || numbered(result.gacha.gachaPoolClient.map(p => p.gachaRuleType)))
    throw new Error(`${repo} numbers the game's enums, and the catalogue reads them by name: its records stay as last published`);
  result.voiceTables = [result.voices];
  return result;
}
/** The CN tables at the mirror and commit this run settled on (scripts/content/cn-tables.mjs):
 * the same bytes every stage of the run reads from its checkout. */
export function cnSource(cache, env = process.env) {
  const tables = cnTables(env);
  return source(tables.repository, `${tables.folder}/excel`, cache, env, tables.commit);
}
/* An event reward's icon is not planned here: import-reward-icons.py (the reward-icons stage, after
   event-rewards writes data/event-rewards.json, which this stage runs before) plans every icon an
   event page asks for, from the same item art. */
export function assetPlan(operators, skins, cn, en, published, extra) {
  if (!Array.isArray(extra)) throw new Error('assetPlan needs the extra media, as [] where there are none');
  // Official board art replaces what a file holds (the publisher skips it once it holds that art).
  const planned = new Map(extra.filter(a => a.boardImage || !published.has(a.path)).map(a => [a.path,a]));
  const add = (target,source) => { if (!published.has(target)) planned.set(target,{path:target,sourcePath:source}); };
  for (const op of operators) {
    const id=op.internalName, c=cn.characters[id]; if (!c) continue;
    const word=rarityWord(op.rarity), name=safeName(op.name);
    for (const [label,suffix] of [['Base',''],...(c.phases.length >= 3 ? [['Elite 2','_2']] : [])]) {
      const skin=cn.skins.charSkins[`${id}#${suffix ? 2 : 1}`];
      if (!skin) continue;
      add(`${word}-star-icons/${name} - ${label}.webp`,`avatar/${skin.avatarId}.png`);
      add(`${word}-star-skins/${name} - ${label}.webp`,`skin/${skin.illustId.replace(/^illust_/,'')}b.png`);
    }
    const tables=op.sourceRegion==='Global' ? en : cn;
    for (const [i,skill] of (op.skills?.skillList ?? []).entries()) {
      const source=tables.skills[c.skills[i]?.skillId]; if (!source || !skill.name) continue;
      add(`skill-icons/${name} - ${safeName(skill.name)}.webp`,`skill/skill_icon_${source.iconId || c.skills[i].skillId}.png`);
    }
    const buffs=(tables.building.chars[id]?.buffChar ?? []).flatMap(slot => slot.buffData);
    for (const [i,base] of (op.baseSkills ?? []).entries()) {
      const buff=tables.building.buffs[base.buffId ?? buffs[i]?.buffId]; if (!buff) continue;
      add(`base-skill-icons/${safeName(op.rawName || name)} - ${safeName(base.rawName || base.name)}.webp`,`building_skill/${buff.skillIcon}.png`);
    }
  }
  const roster=new Map(operators.map(op=>[op.internalName,op]));
  for (const skin of skins) {
    const source=cn.skins.charSkins[skin.skinId],op=roster.get(skin.skinId?.split('@')[0]) ?? roster.get(source?.charId); if (!op) continue;
    // Existing explicitly pinned artwork may deliberately use a different spelling.
    if (skin.image?.startsWith('https://')) continue;
    const stem=`${safeName(op.name)} - ${safeName(skin.name)}.webp`,word=rarityWord(op.rarity);
    add(`${word}-star-skins/${stem}`,`skin/${source.illustId.replace(/^illust_/,'')}b.png`);
    add(`${word}-star-icons/${stem}`,`avatar/${source.avatarId}.png`);
  }
  const items=new Map(Object.values({...cn.items.items,...en.items?.items}).map(item=>[item.name,item]));
  for (const op of operators.filter(op=>op.sourceRegion)) {
    const costs=[...(op.promotion ?? []).flatMap(p=>p.cost ?? []),...Object.values(op.skills?.skillCost ?? {}).flat(),
      ...(op.skills?.skillList ?? []).flatMap(s=>Object.values(s.cost ?? {}).flat()),...(op.modules ?? []).flatMap(m=>(m.stages ?? []).flatMap(s=>s.cost ?? []))];
    for (const cost of costs) { const item=items.get(cost.name); if (item?.iconId) add(`material-icons/${safeName(cost.name)}.webp`,`item/${item.iconId}.png`); }
  }
  return [...planned.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
/** The wiki's calendar pages (wiki-pages.mjs). A row leaves an Upcoming page when Global catches up on it, and where
 * it went tells that from a loss, so the yearly page is read first and the Global client's activity table is at hand. */
export async function readCalendarPages(root, {now,cn,en,alerts,write}) {
  const read=(page,template,movedTo)=>readWikiRows(root,page,template,{now,alerts,write,movedTo});
  const yearlyPage=`Headhunting/Banners/${now.getUTCFullYear()}`,yearly=await read(yearlyPage,'Banners cell');
  const [upcoming,events]=await Promise.all([read('Headhunting/Banners/Upcoming','Banners cell',{name:`to ${yearlyPage}`,has:onYearlyPage(yearly)}),read('Event/Upcoming','Upcoming events cell',{name:'into the Global client\'s activity table',has:inGlobalClient(cn,en)})]);
  return {upcoming,yearly,events};
}
export async function syncCatalogue(root, options={}) {
  const cache=path.resolve(root,'.cache/catalogue'), now=options.now ?? new Date();
  // The wiki only enriches: a page it cannot serve today is read from its last good copy
  // and reported under the 'wiki' stage, never thrown (wiki-pages.mjs).
  const wikiStage=beginStage(root,'wiki',now);
  const sources=options.sources || await (async()=>{
    const [cn,en]=await Promise.all([
      cnSource(cache),
      source('ArknightsAssets/ArknightsGamedata','en/gamedata/excel',cache),
    ]);
    const {upcoming,yearly,events}=await readCalendarPages(root,{now,cn,en,alerts:wikiStage,write:!options.dryRun});
    // The asset plan's revision: publish-catalogue-assets fetches every planned file at it.
    const resourceRevision=await revision('yuanyan3060/ArknightsGameResource');
    return {cn,en,bannerRows:[...upcoming,...yearly],eventRows:events,resourceRevision};
  })();
  const {cn,en}=sources;
  const operatorFiles=fs.readdirSync(path.join(root,'data')).filter(dir=>/^operators-\dstar$/.test(dir)).flatMap(dir=>fs.readdirSync(path.join(root,'data',dir)).filter(f=>f.endsWith('.json')).map(f=>path.join(root,'data',dir,f)));
  const operators=operatorFiles.map(read), skins=read(path.join(root,'data/skins.json')), banners=read(path.join(root,'data/headhunting_banners.json'));
  const eventFiles=fs.readdirSync(path.join(root,'data/events')).filter(f=>/^events_\d+\.json$/.test(f)).map(f=>path.join(root,'data/events',f));
  const events=eventFiles.flatMap(read);
  const initial=reconcileOperators({operators,cn,en});
  // The official CN announcements cached by sync-cn-news.mjs: events and banners a week before the client has them.
  const announced=cnAnnouncements(readCnNews(root));
  const calendars=reconcileCalendars({events,banners,operators:initial.operators,cn,en,eventRows:sources.eventRows,bannerRows:sources.bannerRows,announced,now:now.getTime()});
  // Global's in-game notice board: the day an event was announced, and its key art ahead of the wiki's.
  const enBoard=readOfficialBulletins(root).regions.en;
  const board=applyBoardEvents(calendars.events,enBoard);
  // And a banner's key art where its picture is missing (an Orienteering's retired CN art).
  const publishedArt=new Set(read(path.join(root,'data/assets/external-asset-index.json')).files);
  calendars.media=mergeMedia([...calendars.media,...board.media,...boardBannerMedia(calendars.banners,enBoard,publishedArt)]);
  if (board.announced.length) console.log(`Announced on Global's in-game board: ${board.announced.join(', ')}`);
  const updated=reconcileOperators({operators:initial.operators,cn,en,releases:operatorReleaseDates(initial.operators,calendars.banners,cn,en)});
  // Populate CN release dates for newly imported records too; reconciliation only revisits Global releases.
  const releases=operatorReleaseDates(updated.operators,calendars.banners,cn,en);
  for (const op of updated.operators) if (initial.changes.includes(op.internalName) && releases.get(op.internalName)?.cn && !op.characterInfo?.['CN Release Date']) {
    op.characterInfo['CN Release Date']=serverDay(releases.get(op.internalName).cn);
  }
  // Preserve each operator's last valid Base skills while other catalogue records continue.
  // Unsupported facilities and unreviewed translations remain visible in quarantine.
  const translations = read(path.join(root, 'data/base-skill-translations.json'));
  const baseProblems = reconcileCatalogueBaseSkills(updated.operators, operators, cn, en, translations);
  const baseRosters = reconcileBaseRosters({ operators: updated.operators, constants: cn.constants, characters: cn.characters, previous: read(path.join(root, 'data/base-group-rosters.json')) });
  const workshopRecipes = baseWorkshopRecipes(en.building, en.items.items);
  const outfits=reconcileSkins({skins,operators:updated.operators,cn,en,events:calendars.events});
  const outfitNames=new Map(outfits.renames.map(([before, after])=>[before.split(' / ').slice(1).join(' / '),after.split(' / ').slice(1).join(' / ')]));
  for (const op of updated.operators) op.skins=(op.skins ?? []).map(name=>outfitNames.get(name) ?? name);
  const renames=new Map([...initial.renames,...updated.renames,...outfits.renames,...calendars.renames]);
  // The alters an operator's record names follow an operator's rename too (renameAlternates); the
  // records themselves are written as they are, not through replace().
  const alternatesRenamed=renameAlternates(updated.operators,new Map([...initial.renames,...updated.renames]));
  if (alternatesRenamed.length) console.log(`Alternate names renamed, or released on Global, on: ${alternatesRenamed.join(', ')}`);
  // Every reference to a renamed record follows it; the names a record is found by, its aliases and
  // announcedName, stay as they are (renameReferences).
  const replace=value=>renameReferences(value,renames);
  const published=new Set(read(path.join(root,'data/assets/external-asset-index.json')).files);
  const plan={sourceRepository:'yuanyan3060/ArknightsGameResource',revision:sources.resourceRevision,files:assetPlan(updated.operators,outfits.skins,cn,en,published,calendars.media)};
  const inventory=buildInventory(cn.characters,cn.skins,{repository:cn.repository,revision:cn.revision,files:Object.fromEntries(['characters','skins'].map(k=>[tableFiles[k],createHash('sha256').update(JSON.stringify(cn[k])).digest('hex')]))});
  inventory.events=calendars.events.filter(e=>e.activityId).map(e=>({id:e.activityId,name:e.name}));
  inventory.banners=calendars.banners.filter(b=>b.cnPoolId).map(b=>({id:b.cnPoolId,name:b.name}));
  // Records a bad input left out, kept at their previous version or published partly.
  const catalogueStage=beginStage(root,'catalogue',now);
  // An operator held back by both reconcileOperators passes is one entry: add() keeps the first report of a key.
  for (const entry of [...initial.quarantine,...updated.quarantine,...calendars.quarantine,...outfits.quarantine,...baseProblems]) catalogueStage.add(entry);
  const report={operatorsAdded:updated.operators.length-operators.length,outfitsAdded:outfits.skins.length-skins.length,eventsAdded:calendars.events.length-events.length,bannersAdded:calendars.banners.length-banners.length,poolIdsLinked:calendars.linked,renames:[...renames],assetsRequired:plan.files.length,quarantined:catalogueStage.entries.map(e=>e.key),sources:{cn:cn.revision,global:en.revision,resource:sources.resourceRevision}};
  write(path.join(cache,'asset-plan.json'),plan); write(path.join(cache,'report.json'),report);
  if (!options.dryRun) {
    write(path.join(root, 'data/base-group-rosters.json'), baseRosters);
    write(path.join(root, 'data/base-workshop-recipes.json'), workshopRecipes);
    for (const op of updated.operators) {
      const prior=operatorFiles.find((_,i)=>operators[i].internalName===op.internalName);
      write(prior || path.join(root,`data/operators-${op.rarity}star/${safeName(op.name)}.json`),op);
    }
    write(path.join(root,'data/skins.json'),replace(outfits.skins)); write(path.join(root,'data/headhunting_banners.json'),replace(calendars.banners));
    for (const file of eventFiles) write(file,replace(calendars.events.filter(e=>Number(e.year)===Number(/events_(\d+)/.exec(file)[1]))));
    for (const year of new Set(calendars.events.map(e=>e.year))) {
      const file=path.join(root,`data/events/events_${year}.json`); if (!eventFiles.includes(file)) write(file,replace(calendars.events.filter(e=>e.year===year)));
    }
    for (const file of ['skin-availability-windows.json','skin-shop-rotations.json']) {
      const at=path.join(root,'data',file); write(at,replace(read(at)));
    }
    const inventoryAt=path.join(root,'data/content-inventory.json');
    write(inventoryAt,withStableSource(fs.existsSync(inventoryAt) ? read(inventoryAt) : null,inventory));
    write(path.join(root,'data/catalogue-sync.json'),report);
    catalogueStage.commit();
    // Given sources mean no page was read, so the stage did not run.
    if (!options.sources) wikiStage.commit();
  }
  return report;
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) syncCatalogue(process.cwd(),{dryRun:process.argv.includes('--dry-run')}).then(console.log).catch(error=>{console.error(error);process.exitCode=1;});
