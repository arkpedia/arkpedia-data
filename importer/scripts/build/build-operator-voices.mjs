#!/usr/bin/env node

import { englishVoiceTitles, englishVoiceTitle } from '../lib/voice-line-titles.mjs';
import { actorAliases, mergeVoicePacks, normalizeVoicePack, voiceType } from '../lib/voice-pack-metadata.mjs';
import { listFolderClips, listLegacyClips, restrictToRecordedClips, unlistedRecordings } from '../lib/voice-clip-availability.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cnTableUrl, pinnedRef } from '../content/pin-upstream.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUTPUT = process.env.ARKPEDIA_VOICE_OUTPUT || join(ROOT, 'data/operator-voice-lines.json');
const ASSET_REVISIONS = JSON.parse(readFileSync(join(ROOT, 'data/assets/revisions.json'), 'utf8'));
const VOICE_REPOSITORIES = {
  voice: 'arkpedia-voice-japanese',
  voice_cn: 'arkpedia-voice-mandarin',
  voice_custom: 'arkpedia-voice-regional',
  voice_en: 'arkpedia-voice-english',
  voice_kr: 'arkpedia-voice-korean',
};
const AUDIO_ROOTS = Object.fromEntries(Object.entries(VOICE_REPOSITORIES).map(([directory, repository]) => [
  directory,
  `https://raw.githubusercontent.com/arkpedia/${repository}/main/current`,
]));
const AUDIO_DIRECTORY_APIS = Object.fromEntries(Object.entries(VOICE_REPOSITORIES).map(([directory, repository]) => [
  directory,
  `https://api.github.com/repos/arkpedia/${repository}/contents/current`,
]));
// The legacy folders' and outfit voice sets' file lists, from the contents API unless a local
// index stands in ({ "<repository>/<folder>": [names] }; see scripts/lib/voice-clip-availability.mjs).
const LEGACY_CLIP_INDEX = process.env.ARKPEDIA_VOICE_LEGACY_INDEX ? JSON.parse(readFileSync(process.env.ARKPEDIA_VOICE_LEGACY_INDEX, 'utf8')) : null;
const LEGACY_AUDIO_ROOTS = {
  voice: 'https://raw.githubusercontent.com/arkpedia/arkpedia-voice-japanese/main/legacy',
  voice_old: 'https://raw.githubusercontent.com/arkpedia/arkpedia-voice-japanese/main/legacy',
  voice_cn: 'https://raw.githubusercontent.com/arkpedia/arkpedia-voice-mandarin/main/legacy',
  voice_en: 'https://raw.githubusercontent.com/arkpedia/arkpedia-voice-english/main/legacy',
};
/* The game-data mirrors at a ref: the commit this run pinned (run-stage.mjs) when fetching,
   the branch in the output's meta, which is rewritten every run and so would otherwise
   change whenever a mirror moves; data/upstream.lock.json records the commits. The CN table
   comes from the mirror the run settled on for every CN table (cnTableUrl), which the meta,
   read with no run's environment, names as the primary one's branch whichever it was. */
const MIRROR_FILES = {
  en: ['ArknightsAssets/ArknightsGamedata', 'en/gamedata/excel/charword_table.json'],
  enSupplemental: ['PuppiizSunniiz/ArknightsGameData_YoStar', 'en_US/gamedata/excel/charword_table.json'],
  enSkins: ['ArknightsAssets/ArknightsGamedata', 'en/gamedata/excel/skin_table.json'],
};
const mirrorUrls = env => ({
  ...Object.fromEntries(Object.entries(MIRROR_FILES).map(([key, [repository, file]]) =>
    [key, `https://raw.githubusercontent.com/${repository}/${pinnedRef(repository, env)}/${file}`])),
  cn: cnTableUrl('excel/charword_table.json', env),
  cnSkins: cnTableUrl('excel/skin_table.json', env),
});
const TRANSCRIPTS = mirrorUrls({});
const URLS = {
  ...mirrorUrls(process.env),
  archive: 'https://codeload.github.com/PseudoMon/tlvr-source/zip/refs/heads/master',
  audioIndex: 'https://raw.githubusercontent.com/isHarryh/Ark-Voice/master/voice_data.json',
};

async function jsonInput(envName, url) {
  const local = process.env[envName];
  if (local) return JSON.parse(readFileSync(local, 'utf8'));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${envName}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function tlvrDirectory() {
  if (process.env.ARKPEDIA_TLVR_DIR) return process.env.ARKPEDIA_TLVR_DIR;
  const work = mkdtempSync(join(tmpdir(), 'arkpedia-voices-'));
  const zip = join(work, 'tlvr.zip');
  const response = await fetch(URLS.archive);
  if (!response.ok) throw new Error(`TLVR: ${response.status} ${response.statusText}`);
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  execFileSync('unzip', ['-q', zip, '-d', work]);
  return join(work, 'tlvr-source-master', 'datascript', 'chardata');
}

async function audioDirectoryIndex() {
  const local = process.env.ARKPEDIA_VOICE_ASSET_INDEX;
  if (local) {
    const data = JSON.parse(readFileSync(local, 'utf8'));
    return Object.fromEntries(Object.entries(data).map(([directory, names]) => [directory, new Set(names)]));
  }

  const directories = ['voice', 'voice_cn', 'voice_custom', 'voice_en', 'voice_kr'];
  const entries = await Promise.all(directories.map(async directory => {
    const revision = ASSET_REVISIONS[VOICE_REPOSITORIES[directory]];
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Missing adopted voice revision: ${directory}`);
    const response = await fetch(`${AUDIO_DIRECTORY_APIS[directory]}?ref=${revision}`, {
      headers: process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
    });
    if (!response.ok) throw new Error(`Arkpedia voice assets ${directory}: ${response.status} ${response.statusText}`);
    const listing = await response.json();
    return [directory, new Set(listing.filter(item => item.type === 'dir').map(item => item.name))];
  }));
  return Object.fromEntries(entries);
}

function operatorIds() {
  const ids = new Set();
  for (const dir of readdirSync(join(ROOT, 'data'), { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^operators-\dstar$/.test(dir.name)) continue;
    for (const file of readdirSync(join(ROOT, 'data', dir.name))) {
      if (!file.endsWith('.json')) continue;
      const operator = JSON.parse(readFileSync(join(ROOT, 'data', dir.name, file), 'utf8'));
      if (operator.internalName) ids.add(operator.internalName);
    }
  }
  return ids;
}

const PACK_LABELS = {
  EN: 'English', JP: 'Japanese', KR: 'Korean', CN_MANDARIN: 'Mandarin',
  CN_TOPOLECT: 'Regional Chinese', ITA: 'Italian', GER: 'German', RUS: 'Russian',
  FRE: 'French', SPA: 'Spanish', LINKAGE: 'Collaboration',
};

function packId(type) {
  return ({ CN_MANDARIN: 'cn', CN_TOPOLECT: 'cn_topolect', LINKAGE: 'linkage' }[type] || String(type).toLowerCase());
}

function audioLocations(charId, type, voicePath) {
  const id = packId(type);
  if (type === 'EN') return [{ directory: 'voice_en', folder: charId }];
  if (type === 'JP') return [{ directory: 'voice', folder: charId }];
  if (type === 'KR') return [{ directory: 'voice_kr', folder: charId }];
  if (type === 'CN_MANDARIN') return [{ directory: 'voice_cn', folder: charId }];
  if (type === 'ITA' || type === 'CN_TOPOLECT') return [{ directory: 'voice_custom', folder: `${charId}_${id}` }];
  if (['GER', 'RUS', 'FRE', 'SPA'].includes(String(type))) return [{ directory: 'voice_custom', folder: charId }];
  if (type === 'LINKAGE') {
    if (String(voicePath || '').toLowerCase().includes('cn')) {
      return [{ directory: 'voice_cn', folder: charId }];
    }
    return [
      { directory: 'voice_en', folder: charId },
      { directory: 'voice', folder: charId },
      { directory: 'voice_cn', folder: charId },
    ];
  }
  return [];
}

function audioTemplate(charId, type, voicePath, directoryIndex) {
  const location = audioLocations(charId, type, voicePath)
    .find(candidate => directoryIndex[candidate.directory]?.has(candidate.folder));
  if (!location) return null;
  // An outfit's folder is its word key, which has a '#' in it (char_311_mudrok#1): written
  // raw, everything after it would be a URL fragment and the clip would 404.
  return `${AUDIO_ROOTS[location.directory]}/${encodeURIComponent(location.folder)}/{voiceIdLower}.mp3`;
}

function lineCategory(voiceId) {
  const match = /^CN_(\d+)/.exec(voiceId);
  if (!match) return 'special';
  const number = Number(match[1]);
  if (number >= 17 && number <= 32) return 'combat';
  if (number >= 38) return 'special';
  return 'profile';
}

function wordsFor(table, charId) {
  const byVoice = new Map();
  for (const word of Object.values(table.charWords || {})) {
    if (word.charId !== charId) continue;
    const previous = byVoice.get(word.voiceId);
    if (!previous || (word.wordKey === charId && previous.wordKey !== charId)) byVoice.set(word.voiceId, word);
  }
  for (const word of Object.values(table.charExtraWords || {})) {
    if (word.charId !== charId || byVoice.has(word.voiceId)) continue;
    byVoice.set(word.voiceId, { ...word, voiceTitle: 'Additional voice line', voiceIndex: 1000 });
  }
  return [...byVoice.values()].sort((a, b) => (a.voiceIndex ?? 1000) - (b.voiceIndex ?? 1000) || a.voiceId.localeCompare(b.voiceId));
}

/** The recording packs of one voice set: an operator's own (wordKey = its charId) or an
 * outfit's (wordKey = the skin's voiceId), each read from the folder named after it. */
function currentPacks(table, wordKey, directoryIndex) {
  const config = table.voiceLangDict?.[wordKey];
  if (!config) return [];
  const order = ['EN', 'JP', 'CN_MANDARIN', 'KR', 'SPA', 'ITA', 'GER', 'RUS', 'FRE', 'CN_TOPOLECT', 'LINKAGE'];
  const rank = new Map(order.map((type, index) => [packId(type), index]));
  return Object.entries(config.dict || {}).map(([key, value]) => {
    const type = voiceType(key, value);
    return {
      id: packId(type),
      label: PACK_LABELS[type] || table.voiceLangTypeDict?.[type]?.name || type,
      actors: (Array.isArray(value.cvName) ? value.cvName : []).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()),
      status: 'current',
      audioTemplate: audioTemplate(wordKey, type, value.voicePath, directoryIndex),
    };
  }).sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

function readTlvr(directory) {
  const map = new Map();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (data.charid) map.set(data.charid, data);
  }
  return map;
}

function tlvrFallback(data) {
  if (!data) return [];
  return (data.voices || []).map((voice, index) => ({
    id: voice.asset?.split('/').pop() || voice.id.replace(/^.*_(CN_\d+.*)$/, '$1'),
    title: voice.title?.en || voice.title?.cn || 'Voice line',
    text: voice.text?.en || voice.text?.cn || null,
    category: lineCategory(voice.asset?.split('/').pop() || voice.id.replace(/^.*_(CN_\d+.*)$/, '$1')),
    status: 'current',
    unlock: null,
    order: index,
  }));
}

function legacyPacks(data) {
  if (!data) return [];
  return (data.availability || []).filter(id => id.startsWith('old_')).map(id => ({
    id,
    label: `Legacy ${(id.slice(4).toUpperCase())}`,
    actors: data.actors?.[id] ? [data.actors[id].global || data.actors[id].native] : [],
    status: 'legacy',
    audioTemplate: legacyAudioTemplate(data.audio_path_override?.[id], data.charid),
  }));
}

function legacyAudioTemplate(source, charId) {
  const match = String(source || '').match(/^https:\/\/raw\.githubusercontent\.com\/PseudoMon\/arknights-audio\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const sourceDirectory = match[2].split('/')[0];
  const root = LEGACY_AUDIO_ROOTS[sourceDirectory];
  return root ? `${root}/${match[1]}/${charId}/{voiceId}.mp3` : null;
}

function unusedLines(audioIndex, charId, currentIds) {
  const entry = audioIndex.data?.[charId];
  if (!entry) return [];
  const clips = new Map();
  const variationPack = { JP: 'jp', CN: 'cn', KR: 'kr', EN: 'en', CUSTOM: 'custom' };
  for (const [variationId, variation] of Object.entries(entry.variations || {})) {
    for (const clip of variation.clips || []) {
      const packs = clips.get(clip.name) || new Set();
      packs.add(variationPack[variationId] || String(variationId).toLowerCase());
      clips.set(clip.name, packs);
    }
  }
  const titles = audioIndex.localizations?.['en-US'] || {};
  return [...clips.entries()].filter(([id]) => !currentIds.has(id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, packs], index) => {
    const numeric = /^CN_(\d+)/.exec(id)?.[1];
    return {
      id,
      title: (numeric && titles[numeric]) || `Unused recording ${id}`,
      text: null,
      category: 'unused',
      status: 'unused',
      unlock: null,
      order: 2000 + index,
      availablePacks: [...packs].sort(),
    };
  });
}

/** The site's own names for outfits, by skin id (data/skins.json), which the catalogue
 * writes in English for CN-only outfits too. */
function siteSkinNames() {
  try {
    const skins = JSON.parse(readFileSync(join(ROOT, 'data/skins.json'), 'utf8'));
    return new Map(skins.filter(skin => skin.skinId && skin.name).map(skin => [skin.skinId, skin.name]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

/** An outfit's name: the site's, else "Elite 2" for the promotion art (char_311_mudrok#2,
 * which the game files as a "Default Outfit" with no name), else the game's. */
function outfitLabel(skinId, skin, names) {
  if (names.has(skinId)) return names.get(skinId);
  if (!skinId.includes('@') && skinId.endsWith('#2') && !skin.displaySkin?.skinName) return 'Elite 2';
  return skin.displaySkin?.skinName || skinId;
}

/**
 * The voice sets an operator's outfits bring with them, from the skin tables: a skin whose
 * voiceId names a set of lines filed under the operator's own charId (charWords), other than
 * the operator's own. Outfits that share a set (Mudrock's Elite 2 art, Silent Night DN06,
 * Rubble and Obsidian all use char_311_mudrok#1) are one set naming every one of them. A skin
 * of another record that borrows a set -- the retired Shalem's (char_512_aprot#1), which plays
 * the current Shalem's own lines -- is not this operator's outfit and is left out.
 * Global's table first, then CN's, which adds the outfits Global has not released yet.
 */
function outfitVoiceSets(charId, skins, setOwners, names) {
  const sets = new Map();
  for (const [skinId, skin] of Object.entries(skins)) {
    const wordKey = skin.voiceId;
    if (skin.charId !== charId || !wordKey || wordKey === charId || setOwners.get(wordKey) !== charId) continue;
    const set = sets.get(wordKey) ?? { id: wordKey, labels: [], skinIds: [] };
    set.skinIds.push(skinId);
    const label = outfitLabel(skinId, skin, names);
    if (!set.labels.includes(label)) set.labels.push(label);
    sets.set(wordKey, set);
  }
  return [...sets.values()].map(({ labels, ...set }) => ({ ...set, label: labels.join(', ') }));
}

/** One voice set's own lines, in the game's order. */
function setWords(table, wordKey) {
  return Object.values(table.charWords || {})
    .filter(word => word.wordKey === wordKey)
    .sort((a, b) => (a.voiceIndex ?? 1000) - (b.voiceIndex ?? 1000) || a.voiceId.localeCompare(b.voiceId));
}

function lineRows(words) {
  return words.map((word, index) => ({
    id: word.voiceId,
    title: word.voiceTitle || 'Additional voice line',
    text: word.voiceText || null,
    category: lineCategory(word.voiceId),
    status: 'current',
    unlock: word.lockDescription || null,
    order: word.voiceIndex ?? index,
  }));
}

const [en, enSupplemental, cn, enSkins, cnSkins, audioIndex, directory, audioDirectories] = await Promise.all([
  jsonInput('ARKPEDIA_EN_CHARWORDS', URLS.en),
  jsonInput('ARKPEDIA_EN_SUPPLEMENTAL_CHARWORDS', URLS.enSupplemental),
  jsonInput('ARKPEDIA_CN_CHARWORDS', URLS.cn),
  jsonInput('ARKPEDIA_EN_SKINS', URLS.enSkins),
  jsonInput('ARKPEDIA_CN_SKINS', URLS.cnSkins),
  jsonInput('ARKPEDIA_VOICE_INDEX', URLS.audioIndex),
  tlvrDirectory(),
  audioDirectoryIndex(),
]);
const aliases = actorAliases(cn, [en, enSupplemental]);
const titles = englishVoiceTitles([en, enSupplemental]);
const tlvr = readTlvr(directory);
// Global's record of an outfit wins over CN's; CN's adds the ones Global lacks.
const skins = { ...cnSkins.charSkins, ...enSkins.charSkins };
// Which operator each voice set's lines are filed under.
const setOwners = new Map();
for (const table of [cn, enSupplemental, en]) for (const word of Object.values(table.charWords || {})) setOwners.set(word.wordKey, word.charId);
const skinNames = siteSkinNames();
const operators = {};
let outfitSetCount = 0;

/** A set's current packs: Global's table first, the supplement and CN filling what it lacks. */
function mergedCurrentPacks(wordKey) {
  // Credits are published by the game before our recording folders necessarily arrive.
  return mergeVoicePacks(...[en, enSupplemental, cn].map(table => currentPacks(table, wordKey, audioDirectories)));
}

/**
 * An outfit's voice set, shaped like the operator's own: its lines (English text first, with
 * the base set's fallbacks), its packs from the folders named after it, and each line offered
 * only in the packs whose folder holds its clip. Those folders are listed file by file (a set
 * is a handful of folders), which also finds the recordings its table has no line for: those
 * are its Unused rows (unlistedRecordings).
 */
async function outfitVoiceSet({ id, label, skinIds }, operatorLines) {
  const enWords = setWords(en, id);
  const supplementalEnWords = setWords(enSupplemental, id);
  const source = enWords.length ? enWords : supplementalEnWords.length ? supplementalEnWords : setWords(cn, id);
  const lines = lineRows(source);
  const packs = mergedCurrentPacks(id);
  if (!lines.length || !packs.length) {
    console.warn(`Outfit voice set ${id} (${label}) has ${lines.length} lines and ${packs.length} recorded packs: left out.`);
    return null;
  }
  const listings = await listFolderClips(packs, { revisions: ASSET_REVISIONS, localIndex: LEGACY_CLIP_INDEX });
  const recorded = restrictToRecordedClips(lines, packs, listings)
    // Titled as the operator's own line of that id is, so the two lists agree, else as the
    // operator's own unused rows are (the recording index).
    .concat(unlistedRecordings(lines, packs, listings, voiceId => operatorLines.find(line => line.id === voiceId)?.title
      || audioIndex.localizations?.['en-US']?.[/^CN_(\d+)/.exec(voiceId)?.[1]]));
  return {
    id,
    label,
    skinIds,
    textLocale: enWords.length || supplementalEnWords.length ? 'en' : 'zh-CN',
    lines: recorded.map(line => ({ ...line, title: englishVoiceTitle(line.id, line.title, titles) })),
    packs: packs.map(pack => normalizeVoicePack(pack, aliases)),
  };
}

for (const charId of [...operatorIds()].sort()) {
  const enWords = wordsFor(en, charId);
  const supplementalEnWords = wordsFor(enSupplemental, charId);
  const cnWords = wordsFor(cn, charId);
  const archive = tlvr.get(charId);
  const source = enWords.length ? enWords : supplementalEnWords.length ? supplementalEnWords : cnWords;
  const fallback = source.length ? [] : tlvrFallback(archive);
  const lines = lineRows(source).concat(fallback);
  const currentIds = new Set(lines.map(line => line.id));
  lines.push(...unusedLines(audioIndex, charId, currentIds));

  const packs = mergedCurrentPacks(charId).concat(legacyPacks(archive));
  if (!packs.length && archive) {
    const audioCharId = archive.voices?.[0]?.asset?.split('/')?.[0] || charId;
    for (const id of archive.availability || []) {
      const type = ({ en: 'EN', jp: 'JP', kr: 'KR', cn: 'CN_MANDARIN' })[id];
      if (!type) continue;
      const template = audioTemplate(audioCharId, type, null, audioDirectories);
      if (template) packs.push({ id, label: PACK_LABELS[type], actors: archive.actors?.[id] ? [archive.actors[id].global || archive.actors[id].native] : [], status: 'current', audioTemplate: template });
    }
  }
  // A legacy pack recorded before the actor changed may lack some lines: offer only the
  // clips its folder holds, so the page says "No recording" rather than playing a 404.
  const recorded = restrictToRecordedClips(lines, packs, await listLegacyClips(packs, { revisions: ASSET_REVISIONS, localIndex: LEGACY_CLIP_INDEX }));
  if (!lines.length) continue;
  const ownLines = recorded.map(line => ({ ...line, title: englishVoiceTitle(line.id, line.title, titles) }));
  const skinVoices = [];
  for (const set of outfitVoiceSets(charId, skins, setOwners, skinNames)) {
    const voiceSet = await outfitVoiceSet(set, ownLines);
    if (voiceSet) skinVoices.push(voiceSet);
  }
  outfitSetCount += skinVoices.length;
  operators[charId] = {
    textLocale: enWords.length || supplementalEnWords.length || fallback.length ? 'en' : 'zh-CN',
    lines: ownLines,
    packs: packs.map(pack => normalizeVoicePack(pack, aliases)),
    // Only where an outfit has a voice of its own, so every other operator reads as before.
    ...(skinVoices.length ? { skinVoices } : {}),
  };
}

writeFileSync(OUTPUT, `${JSON.stringify({
  meta: {
    transcripts: [TRANSCRIPTS.en, TRANSCRIPTS.enSupplemental, TRANSCRIPTS.cn],
    outfits: [TRANSCRIPTS.enSkins, TRANSCRIPTS.cnSkins],
    audio: AUDIO_ROOTS,
    legacyAudio: LEGACY_AUDIO_ROOTS,
    archive: 'https://github.com/PseudoMon/tlvr-source',
    unusedIndex: URLS.audioIndex,
  },
  operators,
}, null, 2)}\n`);

if (!process.env.ARKPEDIA_TLVR_DIR) rmSync(directory.replace(/\/tlvr-source-master\/datascript\/chardata$/, ''), { recursive: true, force: true });
console.log(`Wrote ${Object.keys(operators).length} operators and ${outfitSetCount} outfit voice sets to ${basename(OUTPUT)}`);
