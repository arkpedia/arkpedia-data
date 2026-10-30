import { artFile } from '@/lib/art/publishedArt';
import { profileArtPath } from '@/lib/account/portraits';
import { getMaterialIconPath } from '@/lib/operators/operatorIconPaths';
import type { RewardItem } from './loadEventsData';

/**
 * The icon an event page shows beside a store or reward item: null until the image
 * repository has published the file, the rule publishedArt applies to posters and
 * banner art.
 *
 * getMaterialIconPath builds a path out of a name and never looks, so a name with no
 * published icon -- a CN furniture whose art the image sync has not uploaded yet, or
 * "Furniture not found", the wiki's placeholder that sat in a Contingency Contract
 * store -- drew a broken image, hidden until a reader clicked the Rewards tab. With
 * null the row keeps its name, price and quantity badge in the same box, and
 * scripts/content/check-completeness.mjs holds the event back as 'published-partial'
 * with the missing file named. The icon appears when a release brings an asset index
 * that lists it, with no rebuild.
 *
 * `outfitIcon` and `isPublished` are required: the page passes the outfit lookup and
 * the release's asset index, a test passes fixtures.
 *
 * `id` is the game's id where the reward has one (data/event-rewards.json), null where it
 * has none (a wiki store row whose furniture the event does not name). It is required, so
 * no caller can forget it: by id, a player icon is the profile art the account pages
 * already publish (profile-avatars/<id>), and a piece of furniture is its own file
 * (material-icons/<furniture id>: its building_data icon, which
 * scripts/imports/import-reward-icons.py stages by id), since two events' "Duel Trophy" are
 * different pieces.
 */
export function rewardIconPath(
  item: Pick<RewardItem, 'name' | 'type' | 'iconName'> & { id: string | null },
  outfitIcon: (name: string) => string | null,
  isPublished: (file: string) => boolean,
): string | null {
  const src = item.id && /^avatar_/.test(item.id) ? profileArtPath('profile-avatars', item.id)
    : item.id && /^furni_/.test(item.id) ? getMaterialIconPath(item.id)
    : item.type === 'skin' ? outfitIcon(item.name) : getMaterialIconPath(item.iconName ?? item.name);
  if (!src) return null;
  // A path the image repository serves is checked against its index; any other
  // address (none today) cannot be, and renders as it always has.
  const file = artFile(src);
  return file === null || isPublished(file) ? src : null;
}
