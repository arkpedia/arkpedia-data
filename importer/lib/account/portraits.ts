import { assetFileName } from '@/lib/assets/assetUrl';
/**
 * An outfit's portrait: the game's own crop of an operator in that outfit, which its profile
 * card shows support units in. arkpedia-image-assets publishes them to profile-portraits/
 * under the skin id's own spelling (scripts/sync_profile_art.py, portrait_name): "@" and "#"
 * are "_", and Amiya's "1+" is "1p". Change one and the other with it; both repositories'
 * tests pin the same three examples.
 *
 * In lower case, as every profile-art file is: the client's asset paths are lower case
 * ("..._ambiencesynesthesia#7") where its ids are not ("...@ambienceSynesthesia#7"), and the
 * asset host's paths are case-sensitive.
 */
export function portraitPath(skinId: string): string {
  return `/profile-portraits/${skinId.replace(/[@#]/g, '_').replace(/\+/g, 'p').toLowerCase()}.webp`;
}

/** Any other profile art named by a game id (an avatar, a medal, a business card's
 *  "<id>-bg"), in lower case for the same reason. */
export function profileArtPath(folder: 'profile-avatars' | 'profile-medals' | 'profile-namecards' | 'profile-modules' | 'profile-skills', name: string): string {
  return `/${folder}/${name.toLowerCase()}.webp`;
}

const RARITY_WORDS: Record<number, string> = { 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two', 1: 'one' };
type Chars = Record<string, { name: string; rarity?: number }>;
const fileName = (name: string) => assetFileName(name);

/** One outfit of the catalogue as pages/account.tsx's props carry it to the card. Every
 *  published release's /account page holds this shape, so it stays. */
export interface CardOutfit { id: string; image: string | null; name: string }

/** The catalogue's outfits the card can know an assistant's by: each with a skin id, by it,
 *  with its illustration and name. What the account page's getStaticProps gives the page. */
export function cardOutfits(skins: readonly { skinId?: string | null; image?: string | null; name: string }[]): CardOutfit[] {
  return skins.flatMap((skin) => (skin.skinId ? [{ id: skin.skinId, image: skin.image ?? null, name: skin.name }] : []));
}

/**
 * What the card draws the assistant from: the account map's operators (`chars`), and from the
 * page's outfits each one's illustration (`outfitArt`, for assistantArtPath) and name
 * (`outfitNames`, for assistantIconPath and avatarSources), both by skin id. pages/account.tsx
 * gives the card these, and scripts/audits/check-icon-coverage.ts holds to a published file
 * the icons they name, so the audit checks the icons the card asks for, not a copy of them.
 * The two maps are not interchangeable: an outfit's illustration is mostly filed by its brand
 * ("/skin-images/EPOQUE - Glorious Path.webp"), its icon by operator and outfit name.
 */
export function assistantCatalogue<C extends Chars>(map: { chars: C }, outfits: readonly CardOutfit[]): { chars: C; outfitArt: Map<string, string>; outfitNames: Map<string, string> } {
  return {
    chars: map.chars,
    outfitArt: new Map(outfits.flatMap((outfit) => (outfit.image ? [[outfit.id, outfit.image] as const] : []))),
    outfitNames: new Map(outfits.map((outfit) => [outfit.id, outfit.name] as const)),
  };
}

/** What the art folders call a default art by its form, the part of a skin id after "#": "1"
 *  the Base art, Amiya's "1+" her Elite 1 art, "2" the Elite 2 art. */
const formArt = (form: string) => (form.startsWith('2') ? 'Elite 2' : form === '1+' ? 'Elite 1' : 'Base');

/** The operator a skin id is of: "char_1019_siege2" for "char_1019_siege2@epoque#50". */
const charOf = (skinId: string) => skinId.split(/[@#]/)[0];

/**
 * The assistant's illustration in the outfit it wears (status.secretarySkinId), from the skin
 * art the site already has: an outfit ("char_2014_nian@spring#1") by the catalogue's own
 * image for it (`outfitArt`, skin id to path), the default art ("char_2014_nian#1",
 * "...#2" once promoted, Amiya's "#1+" at Elite 1) by the operator's name as the art folders
 * file it. Null when the id names neither.
 */
export function assistantArtPath(skinId: string, chars: Chars, outfitArt: ReadonlyMap<string, string>): string | null {
  if (skinId.includes('@')) return outfitArt.get(skinId) ?? null;
  const [charId, form = ''] = skinId.split('#');
  const char = chars[charId];
  if (!char?.rarity || !RARITY_WORDS[char.rarity]) return null;
  return `/${RARITY_WORDS[char.rarity]}-star-skins/${fileName(char.name)} - ${formArt(form)}.webp`;
}

/** A module's type mark (arkpedia-image-assets' profile-modules), by its equipment id. */
export function moduleMarkPath(equipId: string, moduleTypes: Record<string, string> | undefined): string | null {
  const type = moduleTypes?.[equipId];
  return type ? profileArtPath('profile-modules', type) : null;
}

/** A skill's icon (profile-skills): its own id, or the shared icon it uses, a bracketed index
 *  written as a suffix ("skcom_enchant[1]" -> "skcom_enchant_1"), as the sync publishes it. */
export function skillIconPath(skillId: string, skillIcons: Record<string, string> | undefined): string {
  return profileArtPath('profile-skills', (skillIcons?.[skillId] ?? skillId).replace(/\[(\d+)\]/g, '_$1'));
}

/** The square icon of an operator in the outfit it wears. The rarity icons folder files every
 *  icon as "<operator> - <outfit>": an outfit ("char_1019_siege2@epoque#50") by its name in the
 *  catalogue (`outfitNames`, skin id to name: "Vina Victoria - Glorious Path"), the default art
 *  as "Base", Amiya's "#1+" as "Elite 1" and, once promoted ("#2"), "Elite 2". Not from the
 *  outfit's illustration path: most of those are filed by the brand ("/skin-images/EPOQUE -
 *  Glorious Path.webp"). Null when the id names neither. scripts/audits/check-icon-coverage.ts
 *  holds every outfit in the catalogue and every default art to a published file. */
export function assistantIconPath(skinId: string, chars: Chars, outfitNames: ReadonlyMap<string, string>): string | null {
  const outfitAt = skinId.indexOf('@');
  const char = chars[charOf(skinId)];
  if (!char?.rarity || !RARITY_WORDS[char.rarity]) return null;
  const outfit = outfitAt >= 0 ? outfitNames.get(skinId) : formArt(skinId.split('#')[1] ?? '');
  if (!outfit) return null;
  return `/${RARITY_WORDS[char.rarity]}-star-icons/${fileName(char.name)} - ${fileName(outfit)}.webp`;
}

/** The operator's own icon in its Base art, whatever outfit the skin id is: what the card falls
 *  back to when the outfit's icon is not there. Null for an operator the map does not have. */
function baseIconPath(char: { name: string; rarity?: number } | undefined): string | null {
  if (!char?.rarity || !RARITY_WORDS[char.rarity]) return null;
  return `/${RARITY_WORDS[char.rarity]}-star-icons/${fileName(char.name)} - Base.webp`;
}

/** The game's "Assistant Operator" avatar in display_meta_table, the menu's entry for it. The
 *  game stores the choice as type ASSISTANT with the assistant's skin id, never this id; only a
 *  record written by the site's first build of the card can hold it. */
export const ASSISTANT_AVATAR = 'avatar_ass_01';
/** What the game shows for an account that never picked an avatar (display_meta_table's
 *  defaultAvatarId, the same on Global, Japan and Korea). */
export const DEFAULT_AVATAR = 'avatar_def_01';

/** A skin id ("char_421_crow#1", "char_1019_siege2@epoque#50"), not a profile-avatars id. */
const isSkinId = (id: string) => /^char_\w+(@\w+)?#[\w+]+$/.test(id);

/**
 * The card's avatar, as the pictures to try in order: when one fails to load the card tries
 * the next, and with none left draws nothing, never a broken image.
 *
 *   ASSISTANT  the assistant's icon in the outfit it wears, then in its Base art. By the skin
 *              id the avatar holds, else the assistant's (status.secretarySkinId), else the
 *              assistant's Base art by name.
 *   ICON       the account's own avatar (profile-avatars), by its id.
 *   DEFAULT, NONE, or none sent (a new account's "avatar": {})
 *              the default avatar, as the game shows.
 *
 * A record from before the type was kept says it by the id: a skin id, or the
 * avatar_ass_01 the first build of the card took for the assistant's, is the assistant;
 * any other id an icon; none the default.
 */
export function avatarSources(profile: { avatar?: string | null; avatarType?: string | null; secretarySkin?: string | null; secretary?: string | null }, chars: Chars, outfitNames: ReadonlyMap<string, string>): string[] {
  const id = profile.avatar || null;
  const assistant = profile.avatarType === 'ASSISTANT' || (id !== null && (id === ASSISTANT_AVATAR || isSkinId(id)));
  if (!assistant) {
    return [profileArtPath('profile-avatars', id && profile.avatarType !== 'DEFAULT' && profile.avatarType !== 'NONE' ? id : DEFAULT_AVATAR)];
  }
  const skins = [...new Set([id && isSkinId(id) ? id : null, profile.secretarySkin ?? null].filter((skin): skin is string => !!skin))];
  const byName = profile.secretary ? Object.values(chars).find((char) => char.name === profile.secretary) : undefined;
  return [...new Set([
    ...skins.map((skin) => assistantIconPath(skin, chars, outfitNames)),
    ...skins.map((skin) => baseIconPath(chars[charOf(skin)])),
    baseIconPath(byName),
  ].filter((path): path is string => !!path))];
}
