/**
 * A second try for published files that GitHub falsely reports missing.
 *
 * Normal public media and generated JSON now load from R2 at a pinned commit
 * (config/asset-delivery.json). These helpers remain for upstream reads and legacy tabs.
 * Measured on 2026-10-15,
 * from Korea and from Germany: GitHub's raw origin sometimes answers "404: Not Found"
 * (text/plain) for a file that exists at that commit -- about 1 or 2 in 250 requests made one
 * at a time, 6 to 14 in 250 at a browser's 20 to 40 in parallel, a different random set each
 * time. Its CDN then keeps that 404 for about five minutes per path and per edge, so every
 * reader behind that edge saw the broken-image "?" in place of an operator icon until it
 * expired. A query string is not part of the CDN's cache key (`?v=2` gets the same cached
 * 404), but a different percent-encoding of the same path is, and GitHub decodes it to the
 * same file: `%4Bal'tsit` is Kal'tsit, fetched afresh.
 *
 * So a request that fails is tried again with one more letter of the file name
 * percent-encoded, up to ASSET_RETRY_ATTEMPTS times, and only the last failure reaches the
 * caller. One rule, in one place: lib/assets/githubRetry.mjs (plain JavaScript, so the CI and
 * release scripts run it too). The inline script pages/_document.tsx puts in <head> runs it
 * for every <img> (assetRetryScript), and the helpers here run it for fetch() (fetchAsset),
 * detached images and audio. scripts/tests/test-asset-retry.ts fails when a new fetch() of a
 * published file goes around them.
 */

import { useEffect, useState, type RefObject } from 'react';
import { ASSET_RETRY_ATTEMPTS, NEXT_ASSET_URL_SOURCE, alternateAssetUrl, fetchAsset, nextAssetUrl } from './githubRetry.mjs';

export { ASSET_RETRY_ATTEMPTS, NEXT_ASSET_URL_SOURCE, alternateAssetUrl, fetchAsset, nextAssetUrl };

/*
 * The <img> half, run inline from <head> (pages/_document.tsx) so that it listens before the
 * body's first image starts loading: operator icons fail during the HTML parse, long before
 * React hydrates, and a listener added from React would miss them.
 *
 * `error` does not bubble, so it listens in the capture phase on the document. An image that
 * failed is pointed at the next encoding of what it tried (currentSrc, which inside a
 * <picture> is one of the <source>s' candidates): its src, its srcset and its <picture>'s
 * <source> srcsets are all rewritten, so whichever candidate the browser picks next is a new
 * address. While that retry is pending the event goes no further (stopImmediatePropagation):
 * a component's own onError fallback, and lib/ui/imageArrival.ts's listener, must not act on
 * a failure that is about to be undone. The last failure is let through to both.
 *
 * Every rewrite encodes one more letter in each candidate, so the tries end: after
 * ASSET_RETRY_ATTEMPTS the failed address has no next one. React does not reset the
 * attribute unless the src prop itself changes, and a new src is a new file with tries of
 * its own.
 *
 * On install, at DOMContentLoaded and whenever an image is put in the page, it also retries
 * one already broken (complete, with nothing to draw) whose failure it may not have heard.
 * SVGs are left alone there: one without an intrinsic size has a naturalWidth of 0 when it
 * loaded fine.
 */
const INSTALL_SOURCE = String.raw`function (next) {
  if (window.__assetRetry) return;
  window.__assetRetry = true;
  var retried = typeof WeakSet === 'function' ? new WeakSet() : null;
  function bump(list) {
    return list.split(',').map(function (candidate) {
      var parts = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
      var url = parts && next(parts[2]);
      return url ? parts[1] + url + parts[3] : candidate;
    }).join(',');
  }
  function rewrite(element, name) {
    var value = element.getAttribute(name);
    if (!value) return false;
    var bumped = name === 'src' ? next(value) : bump(value);
    if (!bumped || bumped === value) return false;
    element.setAttribute(name, bumped);
    return true;
  }
  function retry(img) {
    var failed = img.currentSrc || img.src;
    if (!failed || !next(failed)) return false;
    var changed = false;
    var picture = img.parentNode;
    if (picture && picture.nodeName === 'PICTURE') {
      for (var i = 0; i < picture.children.length; i++) {
        if (picture.children[i].nodeName === 'SOURCE' && rewrite(picture.children[i], 'srcset')) changed = true;
      }
    }
    if (rewrite(img, 'srcset')) changed = true;
    if (rewrite(img, 'src')) changed = true;
    if (changed && retried) retried.add(img);
    return changed;
  }
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!img || img.nodeName !== 'IMG') return;
    // An earlier address's failure, arriving while the retry already loads: not the last.
    if (retried && retried.has(img) && !img.complete) { event.stopImmediatePropagation(); return; }
    if (retry(img)) event.stopImmediatePropagation();
  }, true);
  function broken(img) {
    if (img.complete && img.naturalWidth === 0 && !/\.svg(?:[?#]|$)/i.test(img.currentSrc || img.src)) retry(img);
  }
  function sweep() {
    for (var i = 0; i < document.images.length; i++) broken(document.images[i]);
  }
  sweep();
  document.addEventListener('DOMContentLoaded', sweep);
  // An image React made and started loading before it was in the document fails where no
  // document listener hears it: retried when it is put in.
  if (typeof MutationObserver === 'function') new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      for (var j = 0; j < records[i].addedNodes.length; j++) {
        var node = records[i].addedNodes[j];
        if (node.nodeType !== 1) continue;
        var found = node.nodeName === 'IMG' ? [node] : node.getElementsByTagName('img');
        for (var k = 0; k < found.length; k++) broken(found[k]);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}`;

/** The inline <head> script that retries every <img> (pages/_document.tsx). */
export function assetRetryScript(): string {
  // Indentation off (every page carries it); the line breaks stay, as the comments end there.
  return `(function(){try{(${INSTALL_SOURCE})(${NEXT_ASSET_URL_SOURCE});}catch(e){}})();`.replace(/^\s+/gm, '');
}

/**
 * A published picture loaded outside the page, for a canvas or WebGL (textures, posters):
 * decoded, and tried again at the next encoding when it fails. Rejects with the last failure,
 * or when `signal` aborts.
 */
export async function loadAssetImage(url: string, { crossOrigin, signal }: { crossOrigin?: string; signal?: AbortSignal } = {}): Promise<HTMLImageElement> {
  const image = new Image();
  if (crossOrigin !== undefined) image.crossOrigin = crossOrigin;
  image.decoding = 'async';
  signal?.addEventListener('abort', () => { image.src = ''; }, { once: true });
  let current = url;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    image.src = current;
    try {
      await image.decode();
      return image;
    } catch (error) {
      const next = nextAssetUrl(current);
      if (!next || signal?.aborted) throw error;
      current = next;
    }
  }
}

/**
 * Point a media element that failed to load at the next encoding of its file and load it
 * again. False when there is none: the failure is the last.
 */
export function retryAssetMedia(media: HTMLMediaElement): boolean {
  const next = nextAssetUrl(media.currentSrc || media.src);
  if (!next) return false;
  media.src = next;
  media.load();
  return true;
}

/*
 * A sound is not retried from an await. A phone plays <audio> only from inside the press that
 * asked for it, with the real file (iOS; lib/music/audioElement.ts), so a play() called once
 * the first try has failed is refused there. Instead the next press asks for the clip at the
 * next encoding, from inside that press: the reader is told to press play again, and the clip
 * plays. Each clip remembers where its next try is due for the rest of the page.
 */
const clipAddresses = new Map<string, string>();

/** The address to play `url` from on this press: its own, or the encoding its next try is due at. */
export function assetAudioUrl(url: string): string {
  return clipAddresses.get(url) ?? url;
}

/** After `url`, played from `tried`, failed to load: true when another encoding is left for the
 *  next press (assetAudioUrl then gives it), false when the failure is the last. */
export function retryAssetAudioOnNextPress(url: string, tried: string): boolean {
  const next = nextAssetUrl(tried);
  if (next) clipAddresses.set(url, next);
  else clipAddresses.delete(url);
  return next !== null;
}

/*
 * CSS art -- a mask, a background, a cursor -- has no error event: a false 404 leaves it blank
 * and says nothing. So once the element is on (or near) the screen, where its stylesheet has
 * asked for the picture too and the answer is in the browser's cache, the same address is
 * loaded as an image; if GitHub refused it, the next encodings are tried, and the one that
 * answers replaces the address in the style. Each address is looked at once per page, however
 * many elements show it, and one never shown is never asked for.
 */
const answers = new Map<string, Promise<string>>();

/** The address of a published picture that loads: its own, or the encoding GitHub answered when
 *  it refused its own (its own again when none did). */
export function workingAssetUrl(url: string): Promise<string> {
  let answer = answers.get(url);
  if (!answer) {
    answer = new Promise<string>((resolve) => {
      const image = new Image();
      let current = url;
      image.onload = () => resolve(current);
      image.onerror = () => {
        const next = nextAssetUrl(current);
        if (!next) { resolve(url); return; }
        current = next;
        image.src = next;
      };
      image.src = url;
    });
    answers.set(url, answer);
  }
  return answer;
}

let shown: IntersectionObserver | null = null;
const onShown = new WeakMap<Element, () => void>();
function whenShown(element: Element, run: () => void): () => void {
  if (typeof IntersectionObserver !== 'function') { run(); return () => {}; }
  shown ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const go = onShown.get(entry.target);
      onShown.delete(entry.target);
      shown!.unobserve(entry.target);
      go?.();
    }
  }, { rootMargin: '200px' });
  onShown.set(element, run);
  shown.observe(element);
  return () => { onShown.delete(element); shown?.unobserve(element); };
}

/**
 * The address to put in a style's url() for `url`: its own, until the element in `ref` is
 * shown and GitHub turns out to have refused it, then the encoding that answered. Any other
 * address is returned as it is.
 */
export function useAssetUrl(url: string, ref: RefObject<Element | null>): string {
  const [found, setFound] = useState<{ url: string; working: string } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !nextAssetUrl(url)) return;
    let live = true;
    const stop = whenShown(element, () => {
      void workingAssetUrl(url).then((working) => { if (live && working !== url) setFound({ url, working }); });
    });
    return () => { live = false; stop(); };
  }, [url, ref]);
  return found?.url === url ? found.working : url;
}
