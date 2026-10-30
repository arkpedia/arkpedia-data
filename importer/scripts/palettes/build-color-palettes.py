#!/usr/bin/env python3
"""The palette game's five swatches for every Base and Elite 2 artwork: data/color-palettes.json.

    python3 scripts/palettes/build-color-palettes.py --revisions data/assets/revisions.json
    python3 scripts/palettes/build-color-palettes.py --source-dir <checkout of arkpedia-skin-assets>

The release job runs it as the `palettes` stage, against arkpedia-skin-assets at the commit
data/assets/revisions.json pins (the one the release publishes). data/color-palettes.json is
the one palette file: the site reads it (lib/minigames/data.ts), the release publishes it, and
community corrections (arkpedia-color-palette's community-overrides.json) apply on top of it.

Why it is a stage: until 2026-09 it ran by hand and globbed public/*-star-skins, which has been
empty since the art moved to arkpedia-skin-assets, so nothing made a palette for any operator
released since, and lib/minigames/data.ts leaves an operator without one out of the game
without a word (Gallus², Rhodes Island Recon, Aegis, Yukari Takeba, Makoto Yuki, Koromaru).

Each artwork's palette, in order of preference:
  1. a review (data/color-palette-reviews.json): an accepted suggestion or approved samples,
     valid only for the exact bytes reviewed;
  2. a feature recipe (data/color-palette-features.json): five named reference colours, each
     matched to the nearest colour the artwork has;
  3. an automatic palette, for new art nobody has reviewed or given a recipe yet, marked
     "automatic" and held published-partial in data/quarantine.json until someone does: the
     game plays it meanwhile, instead of leaving the operator out.
Every palette records the artwork's sha256, so a run downloads only art that is new or has
changed: the skin repository's asset-manifest.json lists each file's sha256, and a cached entry
for the same bytes (and the same recipe, or automatic version) is kept as it is. An accepted
review needs no download; approved samples (one artwork today) are checked against their
pixels on every run.

One artwork's problem is that artwork's, never the run's: art that changed since its review
keeps its previous palette (kept-previous), unreadable art keeps its previous one or goes
without (omitted-new), each as a quarantine entry of stage `palettes`. Only a manifest that
cannot be read or lists no artwork at all fails the run, which leaves the file as it was.

An entry's reason names the kind of failure and nothing else (UNUSABLE below): never the
error's own text, which the log gets, nor the skin commit. data/quarantine.json is a release
input, and both change by themselves: PIL names the buffer's address ("cannot identify image
file <_io.BytesIO object at 0x108905580>", another address the next run), a download error
carries its URL at the pin, which moves whenever arkpedia-skin-assets commits, and an outage
answers 502 one day and times out the next. With either in the reason, one corrupt upload or
one flaky download made a new release every night.
"""
import argparse
import hashlib
import json
import os
import re
import ssl
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path

import certifi
from PIL import Image, UnidentifiedImageError
sys.dont_write_bytecode = True
from palette_review import load_reviews, approved_palette, atomic_json, review_digest
from github_retry import next_asset_url

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data' / 'color-palettes.json'
FEATURES = ROOT / 'data' / 'color-palette-features.json'
QUARANTINE = ROOT / 'scripts' / 'lib' / 'quarantine.mjs'
STAGE = 'palettes'
VERSION = 2
SKIN_REPOSITORY = 'arkpedia-skin-assets'
RAW = 'https://raw.githubusercontent.com/arkpedia/{repository}/{revision}/{path}'
ARTWORK = re.compile(r'^(?:one|two|three|four|five|six)-star-skins/[^/]+ - (?:Base|Elite 2)\.webp$')
SHA = re.compile(r'^[0-9a-f]{40}$')
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
# Bumped whenever automatic_targets changes, so every automatic palette is made again.
AUTOMATIC = 'regions-v2'
# The one thing a quarantine reason says about an artwork that failed: the kind of failure,
# as a clause about the artwork ("it"), the same words every run.
UNUSABLE = {
    'download': 'it could not be downloaded from the pinned skin repository',
    'sha256': 'it does not match the sha256 its manifest lists',
    'decode': 'it does not decode as an image',
    'review-bytes': 'its review was made for other bytes; review it again (npm run palettes:review)',
    'review': 'its review in data/color-palette-reviews.json does not validate against the artwork',
    'recipe': 'its recipe in data/color-palette-features.json does not name five known feature colours',
    'pixels': 'it has too few opaque pixels to take a palette from',
    'other': 'it could not be given a palette (the palettes stage log has the error)',
}


class Unusable(Exception):
    """One artwork's problem, as its quarantine entry names it: `kind` is a key of UNUSABLE.
    The exception it was raised from (__cause__) is the full problem, for the log."""

    def __init__(self, kind):
        super().__init__(UNUSABLE[kind])
        self.kind = kind


def lab(rgb):
    """sRGB to CIELAB, for comparing shades without mixing different hues."""
    r, g, b = [(v / 255 / 12.92 if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4) for v in rgb]
    xyz = ((.4124564*r + .3575761*g + .1804375*b) / .95047,
           .2126729*r + .7151522*g + .0721750*b,
           (.0193339*r + .1191920*g + .9503041*b) / 1.08883)
    x, y, z = [v ** (1/3) if v > .008856 else 7.787*v + 16/116 for v in xyz]
    return (116*y - 16, 500*(x-y), 200*(y-z))


def distance(a, b):
    return sum((x-y)**2 for x, y in zip(a, b))


def recipe_digest(roles, targets):
    return hashlib.sha256(json.dumps([roles, targets], separators=(',', ':')).encode()).hexdigest()


def palette(image, targets):
    """Suggest five reference-guided colors, independent of their pixel area.

    The recipes identify hair, three outfit colors and a standout detail. They
    are visual annotations, not an attempt to infer anatomy from pixel counts.
    Helmets/shells/fur take the first slot when hair is covered or absent.
    """
    image = image.convert('RGBA')
    bounds = image.getchannel('A').getbbox()
    if not bounds:
        raise ValueError('Artwork has no opaque pixels')
    image = image.crop(bounds)
    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
    # Bin only very similar RGB shades (8 levels per channel). Averaging these
    # cannot turn separate green/blue highlights and beige shadows into gray.
    bins = {}
    pixels = image.get_flattened_data() if hasattr(image, 'get_flattened_data') else image.getdata()
    for r, g, b, a in pixels:
        if a < 192:
            continue
        key = (r // 8, g // 8, b // 8)
        total = bins.setdefault(key, [0, 0, 0, 0])
        for k, value in enumerate((r, g, b, 1)):
            total[k] += value
    if sum(bucket[3] for bucket in bins.values()) < 5:
        raise ValueError('Artwork has too few opaque pixels')
    candidates = [tuple(round(v / bucket[3]) for v in bucket[:3]) for bucket in bins.values() if bucket[3] >= 2]
    if not candidates:
        candidates = [tuple(round(v / bucket[3]) for v in bucket[:3]) for bucket in bins.values()]
    candidates = sorted(set(candidates))
    indexed = [(color, lab(color)) for color in candidates]
    selected = []
    for target in targets:
        wanted = lab(tuple(int(target[i:i+2], 16) for i in (1, 3, 5)))
        # If hair and clothing share a color, prefer distinguishable nearby
        # shades; never invent a hue that does not occur in this artwork.
        nearby = sorted(indexed, key=lambda entry: distance(entry[1], wanted))
        best = nearby[0]
        distinct = next((entry for entry in nearby if all(distance(entry[1], prior[1]) >= 64 for prior in selected)), None)
        if distinct and distance(distinct[1], wanted) <= distance(best[1], wanted) + 144:
            best = distinct
        selected.append(best)
    # Keep semantic order: hair, outfit, outfit, outfit, standout.
    return ['#%02x%02x%02x' % color for color, _ in selected]


def automatic_targets(image):
    """Five target colours for art without a review or a recipe, in the game's slot order.

    The game tells readers the order (pages/games/color-palette.tsx): hair, clothing,
    clothing, skin or a third clothing colour, then an accent. Standing art puts the head at
    the top of the figure, so the first slot is the commonest colour of the figure's top
    sixth (hair, or the headgear, fur or shell over it); the next three are the commonest
    colours of its body (from a third of the way down), each clearly apart from those already
    taken; the last is the most saturated colour covering a visible part of the figure that
    differs from all four. A stand-in until someone reviews the art or writes its recipe.
    """
    image = image.convert('RGBA')
    bounds = image.getchannel('A').getbbox()
    if not bounds:
        raise ValueError('Artwork has no opaque pixels')
    image = image.crop(bounds)
    image.thumbnail((256, 256), Image.Resampling.LANCZOS)
    width, height = image.size
    regions = {'top': {}, 'body': {}, 'all': {}}
    pixels = image.get_flattened_data() if hasattr(image, 'get_flattened_data') else image.getdata()
    for index, (r, g, b, a) in enumerate(pixels):
        if a < 192:
            continue
        y = index // width
        key = (r // 8, g // 8, b // 8)
        for region in ('all', 'top' if y < height / 6 else None, 'body' if y >= height / 3 else None):
            if region:
                total = regions[region].setdefault(key, [0, 0, 0, 0])
                for k, value in enumerate((r, g, b, 1)):
                    total[k] += value
    opaque = sum(bucket[3] for bucket in regions['all'].values())
    if opaque < 5:
        raise ValueError('Artwork has too few opaque pixels')

    def colours(region):
        """The region's colours, commonest first. Shades within a CIELAB distance of 15 of a
        commoner one count towards it, so shaded hair or cloth, spread over many bins, is not
        outvoted by a flat patch; measured against 200 reviewed palettes, this brings the
        automatic swatches about 15% closer to them."""
        rows = [(bucket[3], tuple(round(v / bucket[3]) for v in bucket[:3])) for bucket in regions[region].values()]
        clusters = []
        for count, colour in sorted(rows, key=lambda row: (-row[0], row[1])):
            shade = lab(colour)
            near = next((cluster for cluster in clusters if distance(cluster[2], shade) < 225), None)
            if near:
                near[0] += count
            else:
                clusters.append([count, colour, shade])
        return [tuple(cluster) for cluster in sorted(clusters, key=lambda cluster: (-cluster[0], cluster[1]))]

    chosen = []

    def apart(entry, minimum=400):
        return all(distance(entry[2], prior[2]) >= minimum for prior in chosen)

    def take(pool, key=None):
        ordered = sorted(pool, key=key) if key else pool
        # Clearly apart (a CIELAB distance of 20), else as apart as the art allows.
        for minimum in (400, 100, 0):
            found = next((entry for entry in ordered if apart(entry, minimum)), None)
            if found:
                chosen.append(found)
                return
        chosen.append(ordered[0] if ordered else colours('all')[0])

    take(colours('top') or colours('all'))
    for _ in range(3):
        take(colours('body') or colours('all'))
    visible = [entry for entry in colours('all') if entry[0] >= opaque * .002] or colours('all')
    take(visible, key=lambda entry: -(entry[2][1] ** 2 + entry[2][2] ** 2))
    return ['#%02x%02x%02x' % colour for _, colour, _ in chosen]


class PinnedSkins:
    """arkpedia-skin-assets at one commit: its manifest and its files, each checked against the
    sha256 the manifest lists."""

    def __init__(self, revision):
        if not SHA.fullmatch(str(revision)):
            raise ValueError(f'{SKIN_REPOSITORY} needs a commit to read, not {revision!r}')
        self.revision = revision

    def fetch(self, path):
        url = RAW.format(repository=SKIN_REPOSITORY, revision=self.revision, path=urllib.parse.quote(path, safe='/'))
        address, last, failures = url, None, 0
        while True:
            try:
                with urllib.request.urlopen(urllib.request.Request(address, headers={'User-Agent': 'arkpedia-palettes'}), timeout=60, context=SSL_CONTEXT) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                last = error
                # GitHub's false 404, which its CDN keeps for minutes whatever the query: asked at
                # the next encoding of the address (github_retry.py); a 404 counts only at every one.
                if error.code == 404:
                    address = next_asset_url(address)
                    if address:
                        continue
                    break
                failures += 1
            except OSError as error:
                last = error
                failures += 1
            if failures >= 3:
                break
        raise OSError(f'{url}: {last}')

    def manifest(self):
        return json.loads(self.fetch('asset-manifest.json'))

    def describe(self):
        return f'{SKIN_REPOSITORY}@{self.revision[:12]}'


class LocalSkins:
    """A checkout of arkpedia-skin-assets (or any folder laid out like one)."""

    def __init__(self, directory):
        self.directory = Path(directory)

    def fetch(self, path):
        return (self.directory / path).read_bytes()

    def manifest(self):
        return json.loads((self.directory / 'asset-manifest.json').read_text())

    def describe(self):
        return str(self.directory)


def artworks(manifest):
    """[(key, path, sha256)] for every Base and Elite 2 artwork the manifest lists; the key is
    the site path the game names it by (NFC, as the records spell names)."""
    files = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(files, dict):
        raise ValueError('The skin manifest lists no files')
    found = []
    for path, row in files.items():
        if not ARTWORK.fullmatch(path):
            continue
        digest = row.get('sha256') if isinstance(row, dict) else None
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError(f'The skin manifest gives {path} no sha256')
        found.append((unicodedata.normalize('NFC', '/' + path), path, digest))
    if not found:
        raise ValueError('The skin manifest lists no Base or Elite 2 artwork; refusing to write an empty palette file')
    return sorted(found)


def build(source, reviews, features, previous):
    """(the palette file, the quarantine entries) for every artwork `source` has."""
    if len(features['roles']) != 5:
        raise ValueError('Exactly five feature roles are required')
    cache = previous.get('artworks', {}) if previous.get('version') == VERSION else {}
    result, unavailable, holds = {}, [], []
    for key, path, digest in artworks(source.manifest()):
        cached = cache.get(key, {})
        review = reviews.get(key)
        recipe = features['artworks'].get(key)
        image = None

        def load():
            try:
                data = source.fetch(path)
            except OSError as error:
                raise Unusable('download') from error
            actual = hashlib.sha256(data).hexdigest()
            if actual != digest:
                raise Unusable('sha256') from ValueError(f'{path} has sha256 {actual}; the manifest lists {digest}')
            try:
                opened = Image.open(BytesIO(data))
                opened.load()
            # PIL raises OSError, not UnidentifiedImageError, for data cut short.
            except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
                raise Unusable('decode') from error
            return opened

        def reviewed(image):
            if review.get('sourceSha256') != digest:
                raise Unusable('review-bytes') from ValueError(f"reviewed as sha256 {review.get('sourceSha256')}; the manifest lists {digest}")
            try:
                return approved_palette(review, image, digest)
            except ValueError as error:
                raise Unusable('review') from error

        def swatches(image, targets):
            try:
                return palette(image, targets)
            except ValueError as error:
                raise Unusable('pixels') from error

        try:
            if review and review.get('status') == 'accepted':
                result[key] = reviewed(None)
                continue
            if review and review.get('status') == 'approved':
                # Art changed since its review is not downloaded: reviewed() refuses it first.
                image = load() if review.get('sourceSha256') == digest else None
                result[key] = reviewed(image)
                continue
            if recipe:
                try:
                    if len(recipe) != 5:
                        raise ValueError(f'{FEATURES.name} gives {key} {len(recipe)} feature choices, not five')
                    targets = [features['references'][name] for name in recipe]
                except (ValueError, KeyError, TypeError) as error:
                    raise Unusable('recipe') from error
                recipe_sha = recipe_digest(features['roles'], targets)
                if cached.get('sha256') == digest and cached.get('recipeSha256') == recipe_sha:
                    result[key] = cached
                else:
                    image = load()
                    result[key] = {'colors': swatches(image, targets), 'sha256': digest, 'recipeSha256': recipe_sha}
                continue
            if cached.get('sha256') == digest and cached.get('automatic') == AUTOMATIC:
                result[key] = cached
            else:
                image = load()
                try:
                    targets = automatic_targets(image)
                except ValueError as error:
                    raise Unusable('pixels') from error
                result[key] = {'colors': swatches(image, targets), 'sha256': digest, 'automatic': AUTOMATIC}
            holds.append({'key': f'palette:{key}', 'action': 'published-partial',
                          'reason': f'{key}: an automatic palette, since it has no review in data/color-palette-reviews.json and no recipe in data/color-palette-features.json; review it (npm run palettes:review) or add its five feature choices'})
        except (Unusable, UnidentifiedImageError, OSError, ValueError, KeyError) as error:
            kind = error.kind if isinstance(error, Unusable) else 'other'
            cause = error.__cause__ if isinstance(error, Unusable) else error
            # The whole problem goes to the log; the reason names only its kind (see the header).
            if cause is not None:
                print(f'  {key}: {type(cause).__name__}: {cause}'.replace(str(ROOT) + os.sep, ''))
            if cached.get('colors'):
                result[key] = cached
                holds.append({'key': f'palette:{key}', 'action': 'kept-previous',
                              'reason': f'{key}: keeps its previous palette, since {UNUSABLE[kind]}'})
            else:
                unavailable.append(key)
                holds.append({'key': f'palette:{key}', 'action': 'omitted-new',
                              'reason': f'{key}: no palette, so the palette game leaves this artwork out, since {UNUSABLE[kind]}'})
        finally:
            if image is not None:
                image.close()
    return {'version': VERSION, 'artworks': result, 'unavailable': unavailable}, holds


def stale(previous, reviews, features):
    """The artworks whose palette was made from another review or recipe than the current one.

    No download: it reads only the palette file and the two input files. A content run that
    does not refresh upstream (an editorial edit, compiled with refresh_upstream=false) skips
    the palettes stage, so a recipe or review added there left its palette automatic and the
    release's palette test refused the whole compile (2026-10-13: a recipe for six artworks
    blocked every later editorial edit for nine hours). `--if-stale` rebuilds only when this
    finds one. Only artworks the palette file already has are checked: new art comes with a
    new skin pin, which only a refresh adopts."""
    cache = previous.get('artworks', {}) if previous.get('version') == VERSION else None
    if cache is None:
        return sorted(features['artworks'])
    found = []
    for key, entry in sorted(cache.items()):
        review = reviews.get(key)
        recipe = features['artworks'].get(key)
        if review and review.get('status') in ('accepted', 'approved'):
            try:
                current = review_digest(review)
            except (KeyError, TypeError):
                current = None
            if entry.get('reviewSha256') != current:
                found.append(key)
        elif recipe:
            try:
                targets = [features['references'][name] for name in recipe]
            except (KeyError, TypeError):
                found.append(key)
                continue
            if entry.get('automatic') or entry.get('recipeSha256') != recipe_digest(features['roles'], targets):
                found.append(key)
        elif not entry.get('automatic') and key not in (previous.get('unavailable') or []):
            # Its review or recipe was removed: it goes back to an automatic palette and a hold.
            found.append(key)
    return found


def report(entries):
    """Replace the stage's quarantine entries (scripts/lib/quarantine.mjs, the file's one writer)."""
    subprocess.run(['node', str(QUARANTINE), STAGE], input=json.dumps(entries), text=True, check=True, cwd=ROOT)


def source_from(args):
    if args.source_dir:
        return LocalSkins(args.source_dir)
    revisions = json.loads(Path(args.revisions).read_text())
    return PinnedSkins(revisions.get(SKIN_REPOSITORY))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build data/color-palettes.json from the Base and Elite 2 artwork.')
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument('--revisions', help=f'a revisions.json naming the {SKIN_REPOSITORY} commit to read (the release passes data/assets/revisions.json)')
    where.add_argument('--source-dir', help=f'a local checkout of {SKIN_REPOSITORY}')
    parser.add_argument('--if-stale', action='store_true',
                        help='do nothing unless a palette was made from another review or recipe than the current one (see stale())')
    args = parser.parse_args(argv)
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
    reviews, features = load_reviews()['artworks'], json.loads(FEATURES.read_text())
    if args.if_stale:
        changed = stale(previous, reviews, features)
        if not changed:
            print(f'Every palette in {OUTPUT.relative_to(ROOT)} follows its current review or recipe: nothing to rebuild')
            return
        print(f"{len(changed)} palette(s) made from another review or recipe than the current one: {', '.join(changed[:10])}"
              f"{' ...' if len(changed) > 10 else ''}")
    source = source_from(args)
    output, holds = build(source, reviews, features, previous)
    atomic_json(OUTPUT, output)
    report(holds)
    automatic = sum(1 for entry in output['artworks'].values() if entry.get('automatic'))
    print(f"{len(output['artworks'])} Base/Elite 2 palettes from {source.describe()} written to {OUTPUT.relative_to(ROOT)}"
          f" ({automatic} automatic, {len(output['unavailable'])} unavailable)")
    for entry in holds:
        print(f"  ! {entry['key']} ({entry['action']}): {entry['reason']}")


if __name__ == '__main__':
    main()
