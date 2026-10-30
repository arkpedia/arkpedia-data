/*
 * The name a piece of furniture is matched by. Each source quotes some names its own way:
 * building_data writes the pieces of Dorothy's Vision as 'Contemplation' and 'Tree of Life', the
 * wiki's store as "Contemplation" and "Tree of Life", and the rerun's store as Contemplation, so an
 * exact match found no piece and the store rows' icons were asked for, and held, under their
 * quoted names (issue #59, 2026-10-13). One pair of wrapping quotes, straight or curly, is left
 * out; quotes inside a name stay. Plain JavaScript with no imports, so the event page, the
 * release check (scripts/content/check-completeness.mjs) and the Node pipeline read the same rule;
 * scripts/imports/import-reward-icons.py keeps a copy (furniture_key), held to it by
 * test-reward-icons.ts. furnitureName.d.mts types it for the app.
 */
const WRAPPED = /^(['"‘“])(.*)(['"’”])$/s;
const PAIRS = { "'": "'", '"': '"', '‘': '’', '“': '”' };

export function furnitureKey(name) {
  const text = String(name ?? '').trim();
  const wrapped = text.match(WRAPPED);
  return wrapped && PAIRS[wrapped[1]] === wrapped[3] ? wrapped[2].trim() : text;
}
