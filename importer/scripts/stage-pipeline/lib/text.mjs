// The game prints angle brackets as themselves: <Stun Generator>, <Roadblock>,
// and 24 whole stage names such as <Collected Anecdotes>. A blanket <[^>]*>
// strip erases all 24, so only the tags the client actually uses come out.
const MARKUP = /<\/>|<\/?(?:@[^>]*|\$[^>]*|color(?:=[^>]*)?|[ib])>/g;

/** A display string with rich-text markup removed; null when nothing is left. */
export function text(s) {
  if (!s) return null;
  const out = String(s).replace(MARKUP, '').trim();
  return out || null;
}

/**
 * A gamedata field that is *sometimes* a list. 426 stage rows carry
 * `unlockCondition: {}` where the rest carry an array, and several other tables
 * do the same -- the upstream Python read these through `x or []`, where an
 * empty dict is falsy, so it never had to care. In JS `{}` is truthy, so every
 * list-shaped field from gamedata goes through here.
 */
export function list(value) {
  return Array.isArray(value) ? value : [];
}
