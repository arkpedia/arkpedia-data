import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { musicRows, reconcileMusic, sync } from '../sync/sync-event-music.mjs';
const row = (file='sys_act52side', cid='306864', use='[[昨日海|SideStory「昨日海」]]主界面BGM') => `{{音乐一览|${file}|/act52side/m_${file}|22\n|date=2026-10-09\n|[[昨日海OST]] - Mirari<br>{{exlink2|url=https://monster-siren.hypergryph.com/music/${cid}}}\n|title=Mirari\n|oth=${use}}}`;
const input = () => ({text:row(), minimumRows:1, events:[{name:'[Side Story] Yet Another Wave',activityId:'act52side',aliases:['[Side Story] 昨日海']}],albums:[{songs:[{songId:'306864'},{songId:'123456'}]}],curated:{events:[]},expansion:{version:1,events:[]}});
test('reviewed video fallback covers only its exact unreleased reference and later yields to MSR', () => {
 const x=input(); x.text=row().replace('https://monster-siren.hypergryph.com/music/306864','');
 x.expansion.recordings=[{names:['昨日海'],videoId:'Osqs5Lb9lL8',source:'https://www.youtube.com/watch?v=Osqs5Lb9lL8',reference:{file:'sys_act52side',title:'Mirari'}}];
 const result=reconcileMusic(x);assert.deepEqual(result.holds,[]);assert.equal(result.next.events.length,0);
 x.text=x.text.replace('title=Mirari','title=Different');assert.equal(reconcileMusic(x).holds.length,1);
 x.text=row();assert.deepEqual(reconcileMusic(x).next.events[0].tracks,[{id:'306864',role:'lobby'}]);
 assert.deepEqual(reconcileMusic(x).next.recordings,x.expansion.recordings);
});
test('nested templates and piped links preserve the explicit lobby usage and MSR id',()=>{
 const rows=musicRows(row());assert.equal(rows.length,1);assert.equal(rows[0].fields.oth,'[[昨日海|SideStory「昨日海」]]主界面BGM');
 const r=reconcileMusic(input());assert.deepEqual(r.next.events[0].tracks,[{id:'306864',role:'lobby'}]);assert.equal(r.next.events[0].activityId,'act52side');assert.deepEqual(r.holds,[]);
});
test('no prefix, album-title, PV or battle inference; require an explicit main interface',()=>{
 for(const use of ['[[昨日海]]活动宣传PV','[[昨日海]]商店BGM','[[昨日海]]','无']) {const x=input();x.text=row('sys_act52side','306864',use);assert.equal(reconcileMusic(x).next.events.length,0);}
});
test('missing songs, ambiguous versions and unknown events leave records alone',()=>{
 for(const change of [x=>x.albums=[],x=>x.events=[],x=>x.text=row()+row('sys2_act52side','123456')]) {const x=input();change(x);const r=reconcileMusic(x);assert.equal(r.next.events.length,0);assert.ok(r.holds.length);}
 const x=input();x.text=row().replace('|title=', '{{exlink2|url=https://monster-siren.hypergryph.com/music/123456}}\n|title=');assert.equal(reconcileMusic(x).next.events.length,0);
});
test('reviewed choices and deliberately edited automatic choices win over the source',()=>{
 const x=input();x.curated.events=[{names:['昨日海'],tracks:[{id:'123456',role:'lobby'}]}];const r=reconcileMusic(x);assert.equal(r.next.events.length,0);assert.equal(r.holds.length,1);assert.equal(x.curated.events[0].tracks[0].id,'123456');
 const y=input();y.expansion=reconcileMusic(y).next;y.expansion.events[0].tracks[0].id='123456';assert.equal(reconcileMusic(y).next.events[0].tracks[0].id,'123456');
});
test('idempotent repeated imports, duplicate calendar records and Global renaming keep aliases',()=>{
 const x=input();x.events.push({...x.events[0]});let r=reconcileMusic(x);assert.equal(r.next.events.length,1);x.expansion=r.next;assert.deepEqual(reconcileMusic(x).next,r.next);
 x.events=[{...x.events[0],name:'[Side Story] Official Global Name',aliases:[]}];r=reconcileMusic(x);assert.ok(r.next.events[0].names.includes('Official Global Name'));assert.ok(r.next.events[0].names.includes('Yet Another Wave'));
});
test('reference truncation or broken templates fail before writing any source data',async()=>{
 assert.throws(()=>musicRows(row().slice(0,-2)),/Incomplete/);assert.throws(()=>reconcileMusic({...input(),minimumRows:100}),/truncated/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'event-music-'));
 try {fs.mkdirSync(path.join(root,'data/events'),{recursive:true});const x=input();for(const [name,value] of Object.entries({'albums':x.albums,'music-guesser-event-music':x.curated,'music-guesser-event-expansion':x.curated,'event-page-music':x.expansion,'events/events_2026':x.events}))fs.writeFileSync(path.join(root,`data/${name}.json`),JSON.stringify(value));
 const file=path.join(root,'data/event-page-music.json'),before=fs.readFileSync(file,'utf8');await assert.rejects(sync({root,text:'<html>Error</html>'}),/truncated/);assert.equal(fs.readFileSync(file,'utf8'),before);
 } finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('the nightly stage runs after albums and before completeness, without coupling unrelated failures',()=>{
 const script=fs.readFileSync(new URL('../content/run-imports.sh',import.meta.url),'utf8');assert.ok(script.indexOf('stage event-music --')>script.indexOf('stage albums --'));assert.ok(script.indexOf('stage event-music --')<script.indexOf('stage completeness --'));assert.ok(!script.includes('stage event-music --needs'));
});

test('minigame activity ids and explicit venue music resolve without choosing exploration tracks',()=>{
 for(const [activityId,file,use] of [
  ['act1dp','sys_act1dp','[[逐影集趣]]主界面BGM'],
  ['act1arkhub','sys_act1arkhub_entry','[[奇象巡展]]会场BGM'],
  ['act99arcade','sys_act99arcade','[[新游戏]]主界面BGM'],
 ]) {
  const x=input();x.events=[{name:'A minigame',activityId}];x.text=row(file,'306864',use);
  const r=reconcileMusic(x);assert.equal(r.next.events[0].activityId,activityId);assert.equal(r.next.events[0].tracks[0].id,'306864');
 }
 const x=input();x.events=[{name:'Interactive Exhibition',activityId:'act1arkhub'}];
 x.text=row('sys_act1arkhub_exp','306864','[[奇象巡展]]奇象寻迹BGM');
 assert.equal(reconcileMusic(x).next.events.length,0);
});

test('mode-wide references cover named seasons without activity ids and retain future aliases',()=>{
 const x=input();x.events=['Duel Channel: Green Grassville','Duel Channel: Honeydew','Duel Channel: Ivy Vine'].map(name=>({name}));
 x.text=row('sys_act1enemyduel','306864','[[争锋频道]]主界面BGM');
 const r=reconcileMusic(x);assert.equal(r.next.events.length,1);
 for(const e of x.events)assert.ok(r.next.events[0].names.includes(e.name));
 x.expansion=r.next;assert.deepEqual(reconcileMusic(x).next,r.next);
 x.events.push({name:'Duel Channel: Future Season'});
 assert.ok(reconcileMusic(x).next.events[0].names.includes('Duel Channel: Future Season'));
 const y=input();y.events=[{name:'Poly Vision Museum'},{name:'Poly Vision Museum: Evolution'}];y.text=row('sys_act1arcade','306864','[[视相博物馆]]主界面BGM');
 assert.equal(reconcileMusic(y).next.events[0].names.length,3);
});

test('season-specific conflicts and ambiguous non-mode matches still require review',()=>{
 const x=input();x.events=[{name:'Duel Channel: Honeydew',aliases:['争锋频道：蜜露城']}];
 x.text=row('sys_act1enemyduel','306864','[[争锋频道]]主界面BGM')+row('sys_act2enemyduel','123456','[[争锋频道：蜜露城]]主界面BGM');
 assert.equal(reconcileMusic(x).next.events.length,0);
 // Existing reviewed season music must never be replaced by the generic mode.
 x.curated.events=[{names:['Duel Channel: Honeydew'],tracks:[{id:'123456',role:'lobby'}]}];
 const r=reconcileMusic(x);assert.equal(r.next.events.length,0);assert.ok(r.holds.length);
 const y=input();y.events.push({name:'Duplicate translation',aliases:['昨日海']});
 assert.equal(reconcileMusic(y).next.events.length,0);
});

test('already-reviewed alternate lobby variants do not raise false conflicts',()=>{
 const x=input();x.curated.events=[{names:['昨日海'],tracks:[{id:'306864',role:'lobby'},{id:'123456',role:'lobby'}]}];
 assert.equal(reconcileMusic(x).holds.length,0);
 x.text+=row('sys2_act52side','123456');assert.equal(reconcileMusic(x).holds.length,0);
 x.curated.events[0].tracks.pop();assert.equal(reconcileMusic(x).holds.length,1);
});
test('reviewed source discrepancies are bounded to the incoming id, title and retained choice',()=>{
 const x=input();x.curated.events=[{names:['昨日海'],tracks:[{id:'123456',role:'lobby'}]}];
 x.expansion.referenceReviews=[{file:'sys_act52side',title:'Mirari',sourceId:'306864',keepId:'123456'}];
 assert.equal(reconcileMusic(x).holds.length,0);
 x.text=x.text.replace('|title=Mirari','|title=Changed title');assert.equal(reconcileMusic(x).holds.length,1);
});
test('a reviewed missing-link repair requires the exact title and a released catalogue recording',()=>{
 const x=input();x.text=row().replace(/https:\/\/monster-siren.hypergryph.com\/music\/306864/,'missing');
 x.expansion.referenceRecordings=[{file:'sys_act52side',title:'Mirari',id:'306864'}];
 assert.equal(reconcileMusic(x).next.events[0].tracks[0].id,'306864');
 x.text=x.text.replace('|title=Mirari','|title=Changed title');assert.equal(reconcileMusic(x).next.events.length,0);
});
