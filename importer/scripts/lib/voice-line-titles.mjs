/** Standard voice slots share IDs across operators. Use the most common official
 * Global title; leave unknown or ambiguous special slots to their source text. */
export function englishVoiceTitles(tables) {
  const counts = new Map();
  for (const table of tables) for (const word of Object.values(table.charWords ?? {})) {
    const title = word.voiceTitle?.trim();
    if (!title || /\p{Script=Han}/u.test(title)) continue;
    const titles = counts.get(word.voiceId) ?? new Map();
    titles.set(title, (titles.get(title) ?? 0) + 1);
    counts.set(word.voiceId, titles);
  }
  return new Map([...counts].flatMap(([id, titles]) => {
    const ranked = [...titles].sort((a, b) => b[1] - a[1]);
    return ranked.length === 1 || ranked[0][1] > ranked[1][1] ? [[id, ranked[0][0]]] : [];
  }));
}

export function englishVoiceTitle(id, original, titles) {
  // Keep existing English and operator-specific Global titles as published.
  return original && !/\p{Script=Han}/u.test(original) ? original : titles.get(id) || original || 'Additional voice line';
}
