// Portraits for the characters Monster Siren's albums credit who are not playable operators
// (lib/music/albumsDataServer.ts finds an operator's art by name). Discover's "Browse by
// character" drew an empty square for every one of them: the Doctor, Theresis, Kristen
// Wright, the "Rat King", Touch, Misery, Sharp and the rest. Plain JavaScript so the
// completeness check (scripts/content/check-completeness.mjs) can read the same table the
// pages do; characterPortraits.d.mts types it for the app.
//
// Each name, written exactly as data/albums.json writes it, lists the game's own art for that
// character, best first. A path is used only once the image repository publishes it and the
// site serves its folder (the caller's `served`), so a portrait still on its way is skipped
// rather than drawn as a broken image:
//   npc-icons/       the game's avatars of non-playable characters (ArknightsGameResource's
//                    avatar/npc_*, avatar/char_5xx_*), and the four Alive Until Sunset band
//                    members' faces from their story art. Published by arkpedia-image-assets,
//                    whose sources/npc-icons.json records where each came from; served once
//                    config/asset-folders.json maps the folder.
//   enemies-icons/   the character's boss portrait, already published: Theresis, Theresa,
//                    Kristen, 'Rat King', 'Misery', 'Playwright', Faust, Mephisto, FrostNova,
//                    Patriot are each fought somewhere in the game.
//   *-star-icons/    the same person as a playable operator under another name.
// Deliberate choices: "Theresa" is the Sarkaz king of the story (her NPC avatar, then her boss
// portrait), not the operator Civilight Eterna, who has her own entry in the list; "Frost
// (Alive Until Sunset)" is the band's guitarist, never the operator Frost; "Emperor" is the
// penguin (npc_105_emperor), not the sunglasses prop the game also files under that name.
//
// A name with no published art shows its initials instead (characterInitials), never an empty
// box, and the completeness check holds it as published-partial so it gets noticed.
export const CHARACTER_PORTRAITS = Object.freeze({
  Doctor: ['npc-icons/Doctor.webp'],
  Theresis: ['npc-icons/Theresis.webp', 'enemies-icons/Theresis.webp'],
  Theresa: ['npc-icons/Theresa.webp', 'enemies-icons/Theresa.webp'],
  'Kristen Wright': ['enemies-icons/Kristen.webp'],
  '"Rat King"': ['npc-icons/Rat King.webp', "enemies-icons/'Rat King'.webp"],
  Touch: ['npc-icons/Touch.webp'],
  Sharp: ['npc-icons/Sharp.webp'],
  Misery: ['npc-icons/Misery.webp', "enemies-icons/'Misery', Blade of Silence.webp"],
  '"Playwright"': ["enemies-icons/'Playwright'.webp"],
  '"Justice Knight"': ['one-star-icons/Justice Knight - Base.webp'],
  Emperor: ['npc-icons/Emperor.webp'],
  Faust: ['enemies-icons/Faust.webp'],
  Mephisto: ['enemies-icons/Mephisto.webp'],
  FrostNova: ['enemies-icons/FrostNova.webp'],
  Patriot: ['npc-icons/Patriot.webp', 'enemies-icons/Patriot.webp'],
  Alty: ['npc-icons/Alty.webp'],
  Aya: ['npc-icons/Aya.webp'],
  Dan: ['npc-icons/Dan.webp'],
  'Frost (Alive Until Sunset)': ['npc-icons/Frost (Alive Until Sunset).webp'],
});

/**
 * The root-relative path of the first portrait of `name` that `served` says the site can
 * load, or null. `served` is required: a lookup that skipped it would hand out paths the
 * image repository has not published yet.
 */
export function characterPortrait(name, served) {
  if (typeof served !== 'function') throw new Error('characterPortrait needs a served(file) predicate');
  const candidates = Object.hasOwn(CHARACTER_PORTRAITS, name) ? CHARACTER_PORTRAITS[name] : [];
  const file = candidates.find((candidate) => served(candidate));
  return file ? `/${file}` : null;
}

/**
 * What a portrait tile shows when there is no art: up to two letters, from the first two words
 * of the name with its quotes and any parenthesised note left out ("Kristen Wright" KW,
 * '"Rat King"' RK, "Frost (Alive Until Sunset)" F). A name with no letters at all gets "?".
 */
export function characterInitials(name) {
  const words = String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/["'“”‘’]/g, '')
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0]).join('');
  return letters ? letters.toLocaleUpperCase('en') : '?';
}
