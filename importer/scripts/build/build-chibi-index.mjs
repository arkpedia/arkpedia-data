import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function assertSdChibiIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index) || !Object.keys(index).length) throw Error('Empty SD chibi catalogue');
  let revision;
  for (const [skin, facings] of Object.entries(index)) {
    if (!facings || (!facings.front && !facings.back)) throw Error(`${skin}: no battle chibi`);
    for (const [facing, model] of Object.entries(facings)) {
      if (!['front', 'back', 'walk'].includes(facing) || !model?.textures || !Object.keys(model.textures).length
        || typeof model.premultipliedAlpha !== 'boolean') throw Error(`${skin}: invalid ${facing} chibi`);
      for (const url of [model.skeleton, model.atlas, ...Object.values(model.textures)]) {
        const match = /^https:\/\/raw\.githubusercontent\.com\/arkpedia\/arkpedia-sd-assets\/([a-f0-9]{40})\/models\/[A-Za-z0-9_/-]+\/[A-Za-z0-9_.-]+$/.exec(url ?? '');
        if (!match || url.split('/').includes('..')) throw Error(`${skin}/${facing}: chibi must use pinned SD assets`);
        revision ??= match[1];
        if (match[1] !== revision) throw Error('Mixed SD chibi commits');
      }
    }
  }
}

/** Only complete, reviewed SD models enter website pages. Upstream URLs never reach readers. */
export function chibiIndex(sd, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('Expected a pinned SD commit');
  if (sd?.schemaVersion !== 1 || !sd.models || !sd.websiteSkins || !Object.keys(sd.websiteSkins).length) throw Error('SD manifest has no website chibi catalogue');
  const raw = `https://raw.githubusercontent.com/arkpedia/arkpedia-sd-assets/${revision}/`;
  const bySkin = {};
  const url = file => {
    if (!file || !/^models\/[A-Za-z0-9_/-]+\/[A-Za-z0-9_.-]+$/.test(file.path) || file.path.split('/').includes('..')
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw Error('Invalid SD file record');
    return raw + file.path;
  };
  for (const [skin, facings] of Object.entries(sd.websiteSkins)) {
    if (!facings || (!facings.front && !facings.back)) throw Error(`${skin}: no battle chibi`);
    const models = {};
    for (const [facing, key] of Object.entries(facings)) {
      const model = sd.models[key];
      if (!['front', 'back', 'walk'].includes(facing) || model?.kind !== 'operator'
        || !Array.isArray(model.textures) || !model.textures.length || typeof model.premultipliedAlpha !== 'boolean') throw Error(`${skin}: incomplete ${facing} SD model ${key}`);
      models[facing] = { skeleton: url(model.skeleton), atlas: url(model.atlas),
        textures: Object.fromEntries(model.textures.map(texture => [texture.path.split('/').pop(), url(texture)])),
        premultipliedAlpha: model.premultipliedAlpha };
    }
    bySkin[skin] = models;
  }
  // The page's Base label looks up #1. A native template may start at #2 instead;
  // only SD's source-backed default declaration can supply that display alias.
  if (sd.websiteDefaultSkins !== undefined) {
    if (!sd.websiteDefaultSkins || typeof sd.websiteDefaultSkins !== 'object' || Array.isArray(sd.websiteDefaultSkins)) throw Error('Invalid SD native default skins');
    for (const [id, skin] of Object.entries(sd.websiteDefaultSkins)) {
      if (!/^char_\w+$/.test(id) || typeof skin !== 'string' || !skin.startsWith(`${id}#`) || !bySkin[skin]) throw Error(`${id}: missing SD native default skin`);
      const facings = sd.websiteSkins[skin];
      for (const facing of ['front', 'back']) if (facings[facing] && sd.models[facings[facing]].id !== id) throw Error(`${id}: native default must use its own operator`);
      bySkin[`${id}#1`] ??= bySkin[skin];
    }
  }
  assertSdChibiIndex(bySkin);
  return bySkin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sdFile, revision] = process.argv.slice(2);
  const result = chibiIndex(JSON.parse(fs.readFileSync(sdFile)), revision);
  fs.writeFileSync('data/chibi-art.json', JSON.stringify(result) + '\n');
  console.log(Object.keys(result).length, 'skin IDs with SD chibis');
}
