import { publicFileExists } from '@/lib/assets/publicAssets';

/*
 * Banner key art and event posters, as records name them and pages draw them.
 *
 * The English art replaces the CN client's art under the same filename: arkpedia-image-
 * assets' sync-images.yml does that (sync_global_banner_art.py, sync_recurring_banner_art.py).
 * A reader still never gets the old bytes from a cache, because every address a page draws
 * is pinned to one commit of that repository (lib/content/urls.ts, the release's asset
 * pin), so new art arrives with a new URL. That is why nothing here versions a path: the
 * '?v=<sha1>' this module used to append came from the app's own art swap
 * (scripts/sync/sync-banner-art.py, retired), which overwrote files behind an unpinned URL.
 */

/**
 * The file in the image repository that a record's art names: a site path, or a raw
 * URL pinned to one commit of arkpedia-image-assets. null for any other address (a
 * wiki URL), which the site cannot check and renders as it always has. The same
 * reading as artPath() in scripts/content/check-completeness.mjs, which holds the
 * record back as 'published-partial' while that file is missing.
 */
export function artFile(src: string): string | null {
  if (src.startsWith('/') && !src.startsWith('//')) return src.slice(1);
  try {
    const pinned = new URL(src).pathname.match(/^\/arkpedia\/arkpedia-image-assets\/[a-f0-9]{40}\/(.+)$/);
    return pinned ? decodeURIComponent(pinned[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The <Image src> for a banner's key art or an event's poster: null until the image
 * repository has published the file, and the record's path once it has.
 *
 * A record can be published before its art. The catalogue creates a banner from the
 * game client with banner_image null, and a new Global banner names the file its art
 * will have before the art sync has uploaded it. That record goes out as
 * 'published-partial', and rendering the path anyway would draw a broken image on
 * the front page the day the banner opens. With null, every caller shows the empty
 * box it already shows for a banner with no art, at the same size. The art appears
 * when a release brings an asset index that lists it, with no rebuild.
 *
 * Apply it where a path becomes an <Image src>, never in the data files: the scrapers
 * own the per-year event records and headhunting_banners.json and would clobber an edit
 * there.
 */
export function publishedArt(src: string | null | undefined): string | null {
  if (!src) return null;
  const file = artFile(src);
  if (file !== null && !publicFileExists(file)) return null;
  return src;
}
