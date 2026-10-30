// Whether a voice line has a recording in a pack, and which file that is. One rule for the
// three places that must agree: the operator page's player (components/operators/
// OperatorVoiceLines.tsx), the voice builder that narrows availablePacks to the clips a
// repository really holds (scripts/build/build-operator-voices.mjs), and the check that
// fetches every clip the page offers (scripts/audits/check-published-assets.mjs). Plain
// JavaScript so the Node scripts can import it; voiceRecording.d.mts types it for the app.

/** A line without availablePacks is recorded in every pack. With it, only in the packs it
 * names -- 'custom' standing for every current regional pack (Italian, Russian, ...). */
export function hasRecording(line, pack) {
  if (!line || !pack || !pack.audioTemplate) return false;
  if (!line.availablePacks) return true;
  if (line.availablePacks.includes(pack.id)) return true;
  return pack.status === 'current'
    && line.availablePacks.includes('custom')
    && !['en', 'jp', 'cn', 'kr'].includes(pack.id);
}

/** The address of a line's clip in a pack: the template with the voice id filled in. */
export function clipUrl(template, lineId) {
  return template
    ?.replace('{voiceId}', encodeURIComponent(lineId))
    .replace('{voiceIdLower}', encodeURIComponent(lineId.toLowerCase())) ?? null;
}

/** Prefer an available recording while still offering credits whose audio has not arrived. */
export function preferredRecordingPack(packs) {
  const recorded = packs.filter(pack => pack.audioTemplate);
  const available = recorded.length ? recorded : packs;
  return available.find(pack => pack.id === 'en' && pack.status === 'current')
    ?? available.find(pack => pack.id === 'jp' && pack.status === 'current')
    ?? available.find(pack => pack.id === 'cn' && pack.status === 'current')
    ?? available[0];
}
