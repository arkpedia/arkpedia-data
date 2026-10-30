import { publicFiles } from '@/lib/assets/publicAssets';

// Skin icons live alongside operator base icons in the same rarity-
// tiered folders, named "<Operator Name> - <Skin Name>.webp" -- e.g.
// "Kestrel - Charm of The Tiles.webp" sits in five-star-icons/, since
// Kestrel is a 5-star operator. A reward listing only ever gives us
// the skin's own name (e.g. "Charm of the Tiles"), not which operator
// it belongs to or their rarity, so there's no way to construct the
// exact path directly -- this indexes every rarity folder once by each
// file's skin-name suffix instead, so any skin resolves regardless of
// which tier it's actually in.
//
// The folders are read from the asset index, not from public/: the art
// lives in arkpedia-image-assets, and a directory scan of public/ found
// nothing once it moved, so every outfit reward lost its icon (and one
// whose name differs from its record by case lost it altogether).
// scripts/content/check-completeness.mjs applies the same rule to decide
// which outfit rewards to hold back as missing their icon.
const RARITY_ICON_FOLDERS = [
  'one-star-icons',
  'two-star-icons',
  'three-star-icons',
  'four-star-icons',
  'five-star-icons',
  'six-star-icons',
];

let cachedIndex: Map<string, string> | null = null; // lowercased skin name -> web path, built once and reused for the rest of the build

/** The index findSkinIconPath reads, from the file names each rarity folder holds. */
export function buildSkinIconIndex(filesIn: (folder: string) => string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const folder of RARITY_ICON_FOLDERS) {
    for (const file of filesIn(folder)) {
      if (!file.toLowerCase().endsWith('.webp')) continue;
      const base = file.slice(0, -'.webp'.length);
      const sepIndex = base.indexOf(' - ');
      if (sepIndex === -1) continue; // no "Operator - Skin" pattern -- e.g. a plain base icon like "Kestrel.webp", not a skin icon
      const skinName = base.slice(sepIndex + 3).trim();
      // Later (higher-rarity) folders overwrite earlier ones on a name
      // collision -- extremely unlikely for skin names specifically,
      // but consistent with "last one wins" being the least surprising
      // default if it ever happens.
      index.set(skinName.toLowerCase(), `/${folder}/${file}`);
    }
  }
  return index;
}

/** Finds a skin's small icon by name, searching every rarity folder
 * (one-star-icons through six-star-icons) rather than requiring the
 * caller to already know the operator or rarity. Case-insensitive,
 * since scraped data isn't always consistent about capitalization
 * (e.g. "the Tiles" vs "The Tiles"). Returns null if no file matches
 * in any folder. */
export function findSkinIconPath(skinName: string): string | null {
  if (!cachedIndex) cachedIndex = buildSkinIconIndex(publicFiles);
  return cachedIndex.get(skinName.trim().toLowerCase()) || null;
}
