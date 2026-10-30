/**
 * raw.githubusercontent.com's false 404s, and the one rule for asking again. Plain JavaScript,
 * so the site (lib/assets/assetRetry.ts), its inline <head> script and the CI and release
 * scripts (scripts/audits, scripts/sync, scripts/build, scripts/deploy) all run this same file.
 *
 * Measured on 2026-10-15, from Korea and from Germany: raw.githubusercontent.com sometimes
 * answers "404: Not Found" (text/plain) for a file that exists at the pinned commit -- about 1
 * or 2 in 250 requests made one at a time, 6 to 14 in 250 at a browser's 20 to 40 in parallel,
 * a different random set each time -- and its CDN keeps that 404 for about five minutes per
 * path and per edge. A query string is not part of the CDN's cache key (`?v=2` gets the same
 * cached 404), but a different percent-encoding of the path is, and GitHub decodes it to the
 * same file: `%4Bal'tsit` is Kal'tsit, fetched afresh.
 *
 * So a 404 is only an answer once it is confirmed: the file is asked for again with one more
 * letter of its name percent-encoded (nextAssetUrl), up to ASSET_RETRY_ATTEMPTS more times, and
 * one 200 wins. fetchAsset does that for a fetch().
 */

/** How many more times a 404 is asked again before it counts. */
export const ASSET_RETRY_ATTEMPTS = 3;

/*
 * The raw rule, as the browser source the inline script runs. ES5, since it runs as written in
 * every reader's browser before any of the site's compiled code.
 *
 * nextAssetUrl below is the same rule written out as a function, not compiled from this text:
 * a Workers isolate refuses `new Function` ("Code generation from strings disallowed"), and it
 * refused it for every route, since this module loads with the content server. The two cannot
 * silently differ, because scripts/tests/test-asset-retry.ts compiles this text and compares it
 * with nextAssetUrl over its corpus -- the guarantee moved from the runtime to the suite, which
 * is where a difference can be reported rather than thrown at a reader.
 *
 * Only a file in an arkpedia repository on raw.githubusercontent.com qualifies: the host, the
 * repository and the commit are never touched, and nor is the query. In the last path segment
 * it encodes the first ASCII letter not already encoded, in uppercase hex. Existing %XX
 * escapes stay as they are (their hex digits are not letters to encode), and a letter already
 * encoded counts as an attempt made, so the URL itself says how many tries it has had: the
 * site's own addresses never encode a letter (encodeAssetPath uses encodeURIComponent). Null
 * when the URL does not qualify, when it has had its attempts, or when no letter is left.
 */
export const NEXT_ASSET_URL_SOURCE = String.raw`function (url) {
  var parts = /^(https:\/\/raw\.githubusercontent\.com\/arkpedia\/[^\/?#]+\/[^\/?#]+\/(?:[^?#]*\/)?)([^\/?#]+)([?#][\s\S]*)?$/.exec(url);
  if (!parts) return null;
  var tokens = parts[2].match(/%[0-9A-Fa-f]{2}|[\s\S]/g);
  var encoded = 0, next = -1;
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i].length === 3) {
      var code = parseInt(tokens[i].slice(1), 16);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) encoded++;
    } else if (next < 0 && /[A-Za-z]/.test(tokens[i])) next = i;
  }
  if (encoded >= ${ASSET_RETRY_ATTEMPTS} || next < 0) return null;
  tokens[next] = '%' + tokens[next].charCodeAt(0).toString(16).toUpperCase();
  return parts[1] + tokens.join('') + (parts[3] || '');
}`;

/**
 * The next encoding to try for a raw file (see NEXT_ASSET_URL_SOURCE), or null when there is
 * none. Written out rather than compiled from the text above, for the Workers isolate that
 * refuses `new Function`; the test named in that comment holds the two together.
 */
const ASSET_URL_PARTS = /^(https:\/\/raw\.githubusercontent\.com\/arkpedia\/[^/?#]+\/[^/?#]+\/(?:[^?#]*\/)?)([^/?#]+)([?#][\s\S]*)?$/;

export function nextAssetUrl(url) {
  const parts = ASSET_URL_PARTS.exec(url);
  if (!parts) return null;
  const tokens = parts[2].match(/%[0-9A-Fa-f]{2}|[\s\S]/g);
  if (!tokens) return null;
  let encoded = 0;
  let next = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 3) {
      const code = parseInt(token.slice(1), 16);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) encoded++;
    } else if (next < 0 && /[A-Za-z]/.test(token)) next = i;
  }
  if (encoded >= ASSET_RETRY_ATTEMPTS || next < 0) return null;
  tokens[next] = `%${tokens[next].charCodeAt(0).toString(16).toUpperCase()}`;
  return parts[1] + tokens.join('') + (parts[3] || '');
}

/**
 * `url` with its first `attempt` plain letters encoded: attempt 1, 2 and 3 are three different
 * addresses (three CDN cache entries) of the one file. Null for an attempt out of 1 to
 * ASSET_RETRY_ATTEMPTS, a URL outside the arkpedia repositories, or a name with too few letters.
 */
export function alternateAssetUrl(url, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > ASSET_RETRY_ATTEMPTS) return null;
  let current = url;
  for (let i = 0; i < attempt && current; i++) current = nextAssetUrl(current);
  return current;
}

function aborted(signal, error) {
  if (signal?.aborted) return true;
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * fetch() for a published file, where a 404 counts only once it is confirmed: a file that
 * answers 404, or whose request fails outright (in a browser the text/plain 404 can surface as
 * a blocked response, not a status), is asked for at the next encoding, up to
 * ASSET_RETRY_ATTEMPTS more times, and the first answer that is not a 404 is returned (a 404
 * followed only by failed requests is that 404, not an error). An abort
 * or a timeout is not retried, and one `init.signal` bounds every try. Returns the last
 * response, so a caller's own `!response.ok` or `status === 404` handling sees a file that is
 * really missing exactly as before. Any address but an arkpedia repository's file on
 * raw.githubusercontent.com is fetched once, as fetch() would.
 *
 * `fetcher` is for scripts that inject their own fetch (and for tests).
 */
export async function fetchAsset(url, init, { fetcher = (...args) => globalThis.fetch(...args) } = {}) {
  let current = url;
  // The last 404 an earlier encoding answered: a try that then fails outright has not said the
  // file is there, so the answer stays that 404 -- a channel with no pointer still falls back
  // to live's (lib/content/pointer.mjs), which a network error would not.
  let notFound = null;
  for (;;) {
    let response;
    try {
      response = await fetcher(current, init);
    } catch (error) {
      const next = nextAssetUrl(current);
      if (aborted(init?.signal, error)) throw error;
      if (!next) {
        if (notFound) return notFound;
        throw error;
      }
      current = next;
      continue;
    }
    const next = response.status === 404 ? nextAssetUrl(current) : null;
    if (!next) return response;
    // Kept as a bodiless copy, and the connection released; its body is "404: Not Found".
    notFound = new Response(null, { status: 404, statusText: response.statusText, headers: response.headers });
    try { await response.body?.cancel(); } catch { /* already read or closed */ }
    current = next;
  }
}
