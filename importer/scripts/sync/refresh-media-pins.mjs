/** Adopt freshly validated media revisions for previously externalized catalogue art. */
import fs from 'node:fs';
import path from 'node:path';
const revisions=JSON.parse(fs.readFileSync('data/assets/revisions.json','utf8'));
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
let count=0;
for(const file of walk('data').filter(file=>file.endsWith('.json')&&!file.startsWith('data/assets/'))) {
  const before=fs.readFileSync(file,'utf8');
  const after=before.replace(/https:\/\/raw\.githubusercontent\.com\/arkpedia\/(arkpedia-(?:image|skin)-assets)\/(?:[a-f0-9]{40}|main)\//g,(_,repo)=>{
    if(!/^[a-f0-9]{40}$/.test(revisions[repo])) throw new Error(`Unpinned ${repo}`);
    return `https://raw.githubusercontent.com/arkpedia/${repo}/${revisions[repo]}/`;
  });
  if(after!==before) {fs.writeFileSync(file,after);count++;}
}
console.log(`Updated media pins in ${count} catalogue files`);
