"""raw.githubusercontent.com's false 404s, for the Python scripts: the rule of
lib/assets/githubRetry.mjs (nextAssetUrl), written again in Python. scripts/tests/test-asset-retry.ts
runs both on the same addresses and fails when they differ.

GitHub's raw origin sometimes answers 404 for a file that exists at the pinned commit, and its CDN
keeps that answer for about five minutes per path, whatever the query string. A different
percent-encoding of the path is another cache entry and the same file, so a 404 counts only once
the file's own address and ASSET_RETRY_ATTEMPTS other encodings have all said it.
"""
import re

ASSET_RETRY_ATTEMPTS = 3
_FILE = re.compile(r'^(https://raw\.githubusercontent\.com/arkpedia/[^/?#]+/[^/?#]+/(?:[^?#]*/)?)([^/?#]+)([?#][\s\S]*)?$')
_TOKEN = re.compile(r'%[0-9A-Fa-f]{2}|[\s\S]')
_LETTER = re.compile(r'[A-Za-z]')


def next_asset_url(url):
    """The next encoding to try for a raw arkpedia file: the first ASCII letter of its name not
    already encoded, in uppercase hex. None when the URL does not qualify, when it has had its
    attempts (the URL itself says how many: one per encoded letter), or when no letter is left."""
    parts = _FILE.match(url)
    if not parts:
        return None
    tokens = _TOKEN.findall(parts.group(2))
    encoded, at = 0, -1
    for i, token in enumerate(tokens):
        if len(token) == 3:
            code = int(token[1:], 16)
            if 65 <= code <= 90 or 97 <= code <= 122:
                encoded += 1
        elif at < 0 and _LETTER.fullmatch(token):
            at = i
    if encoded >= ASSET_RETRY_ATTEMPTS or at < 0:
        return None
    tokens[at] = '%%%02X' % ord(tokens[at])
    return parts.group(1) + ''.join(tokens) + (parts.group(3) or '')
