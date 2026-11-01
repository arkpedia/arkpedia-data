import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { musicRows, reconcileMusic, sync } from '../sync/sync-event-music.mjs';
const row = (file='sys_act52side', cid='306864', use='[[昨日海|SideStory「昨日海」]]主界面BGM') => `{{音乐一览|${file}|/act52side/m_${file}|22\n|date=2026-10-09\n|[[昨日海OST]] - Mirari<br>{{exlink2|url=https://monster-siren.hypergryph.com/music/${cid}}}\n|title=Mirari\n|oth=${use}}}`;
const input = () => ({text:row(), minimumRows:1, events:[{name:'[Side Story] Yet Another Wave',activityId:'act52side',aliases:['[Side Story] 昨日海']}],albums:[{songs:[{songId:'306864'},{songId:'123456'}]}],curated:{events:[]},expansion:{version:1,events:[]}});
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
