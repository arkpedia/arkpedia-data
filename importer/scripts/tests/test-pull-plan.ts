import assert from 'node:assert/strict';
import { test } from 'node:test';

/* The banner windows the Pull Planner plans against: the application holds the planning
   (arkpedia-app scripts/tests/test-pull-plan.ts), this holds the sync that writes them. */

test('client sync confirms an estimated banner even when its dates were already correct', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'arkpedia-banner-sync-'));
  try {
    for (const dir of ['data/events','en/gamedata/excel','cn/gamedata/excel']) mkdirSync(join(root,dir),{recursive:true});
    const start=new Date();start.setUTCDate(start.getUTCDate()+7);start.setUTCHours(12,0,0,0);
    const end=new Date(start.getTime()+14*86400000);
    const ymd=(d:Date)=>d.toISOString().slice(0,10).replace(/-/g,'/');
    const range=`${ymd(start)}–${ymd(end)}`;
    writeFileSync(join(root,'data/events/events_2026.json'),'[]');
    // The dev integration also reconciles operator releases after calendar sync.
    writeFileSync(join(root,'data/operator-release-links.json'),'[]');
    writeFileSync(join(root,'data/operator-independent-releases.json'),'{}');
    writeFileSync(join(root,'data/headhunting_banners.json'),JSON.stringify([
      {name:'Confirmed',global_date:range,cn_date:null,schedule_anchor:'Event'},
      {name:'Unannounced',global_date:range,cn_date:null,schedule_anchor:'Event'},
    ]));
    for (const region of ['en','cn']) {
      writeFileSync(join(root,region,'gamedata/excel/activity_table.json'),'{"basicInfo":{}}');
      writeFileSync(join(root,region,'gamedata/excel/gacha_table.json'),JSON.stringify({gachaPoolClient:region==='en'?[{gachaPoolName:'Confirmed',openTime:start.getTime()/1000,endTime:end.getTime()/1000}]:[]}));
    }
    execFileSync(process.execPath,[resolve('scripts/sync/sync-event-windows.mjs')],{cwd:root,env:{...process.env,ARKPEDIA_EN:'en',ARKPEDIA_CN:'cn'},stdio:'pipe'});
    const [confirmed,unannounced]=JSON.parse(readFileSync(join(root,'data/headhunting_banners.json'),'utf8'));
    assert.equal(confirmed.global_date,range);
    assert.match(confirmed.global_window.timingSource, /gacha_table\.json$/);
    assert.equal(unannounced.global_window, undefined);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
