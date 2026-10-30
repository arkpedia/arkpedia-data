/** SPA replaced the decoder's numeric enum 11. The entry's enum survives numbered keys. */
export const voiceType = (key, entry) => String(entry?.voiceLangType ?? key) === '11' ? 'SPA' : String(entry?.voiceLangType ?? key);

/** Source order decides actor spelling; missing actors and recordings fill independently. */
export function mergeVoicePacks(...sources) {
  const packs = new Map();
  for (const source of sources) for (const pack of source) {
    const previous = packs.get(pack.id);
    packs.set(pack.id, previous ? {
      ...previous,
      actors: previous.actors.length ? previous.actors : pack.actors,
      audioTemplate: previous.audioTemplate || pack.audioTemplate,
    } : pack);
  }
  // A null template disables playback without erasing the game's credit.
  return [...packs.values()];
}

/** Learn actor spellings from the same operator and recording language across regions. */
export function actorAliases(cn, globalTables) {
  const aliases = new Map();
  for (const global of globalTables) for (const [id, config] of Object.entries(global.voiceLangDict ?? {})) {
    for (const [key, voice] of Object.entries(config.dict ?? {})) {
      const type = voiceType(key, voice);
      const nativeEntry = Object.entries(cn.voiceLangDict?.[id]?.dict ?? {}).find(([key, entry]) => voiceType(key, entry) === type)?.[1];
      const native = nativeEntry?.cvName?.map(name => name.trim()) ?? [];
      const translated = voice.cvName?.map(name => name.trim()) ?? [];
      if (native.length !== 1 || translated.length !== 1 || native[0] === translated[0]) continue;
      const aliasKey = `${type}:${native[0]}`;
      const previous = aliases.get(aliasKey);
      aliases.set(aliasKey, previous === undefined || previous === translated[0] ? translated[0] : null);
    }
  }
  return aliases;
}

export function normalizeVoicePack(pack, aliases) {
  const recording = pack.audioTemplate?.match(/arkpedia-voice-(japanese|english|mandarin|korean)\//)?.[1];
  const language = { japanese: ['JP', 'Japanese'], english: ['EN', 'English'], mandarin: ['CN_MANDARIN', 'Mandarin'], korean: ['KR', 'Korean'] }[recording];
  const type = { jp: 'JP', en: 'EN', cn: 'CN_MANDARIN', kr: 'KR', cn_topolect: 'CN_TOPOLECT', spa: 'SPA', ita: 'ITA', ger: 'GER', rus: 'RUS', fre: 'FRE' }[pack.id]
    ?? (pack.id === 'linkage' ? language?.[0] : null);
  return {
    ...pack,
    label: pack.id === 'linkage' && language ? language[1] : pack.label,
    actors: pack.actors.map(actor => aliases.get(`${type}:${actor.trim()}`) || actor.trim()),
  };
}
