#!/usr/bin/env python3
"""Finds the icons the event pages ask for under material-icons/ and stages each one the image
repository has not published in .cache/reward-icons/, so no event's rewards render as blank
squares for longer than the next release takes -- a CN-only event's included.

WHAT THE PAGES ASK FOR (`wanted` below), the same files rewardIconPath in
lib/events/rewardIcons.ts builds for /events/[slug], row by row, less the rows no source below
has an icon for -- the same files scripts/content/check-completeness.mjs holds an event back for
(eventRewardIcons), which a test runs this against (--wanted), so a file the release holds is
always one this fetches or reports, and a row no source has an icon for is held by neither:

  - data/event-rewards.json's groups the page lists as rewards (LISTED_REWARD_KINDS: sign-ins,
    gifts, free rolls, missions, milestones, first clears) and the packs' contents. A piece of
    furniture the tables name by id under its id (material-icons/<furni id>.webp: two events'
    "Duel Trophy" are two pieces with two pictures); a daily free roll under the Headhunting
    Permit; a row of a kind the item table sorts (a material, a permit, a voucher ...) under its
    name, by the item's id where the tables give one. Not an operator (its portrait), an outfit
    (its icon in a rarity folder), an event token (not listed), a player icon (profile-avatars/
    <id>, which the image repository publishes from the client), nor a row of kind 'other'
    (UNSOURCED): one build-event-rewards found under no item type it sorts and no piece of
    furniture -- a charm coin, an Ideal City cart part, a profile theme, a pack's cosmetics, a
    pack line the parser misread ("Home Screen UI [Dahuang"). The few the item table holds under
    a type the site does not sort (an elite or skill training voucher) go with them until
    build-event-rewards sorts that type.
  - data/event-stores.json: each event's store as the wiki lists it. A piece of furniture the
    event's rewards name is asked for by that id; any other row -- items, furniture -- under its
    name; not the upware a mode's store sells, its own pieces (UNSOURCED too). Walked on its own,
    so an event with a store and no table rewards is not skipped.
  - an event record's own `rewards` (the old one-off wiki import), only for an event the wiki
    lists no store for -- the page shows the wiki's store where there is one -- under the name
    the page shows: its iconName, else its English name from event-rewards.json's storeNames; a
    piece of furniture the event's rewards name by that id, as in the wiki's store.

CN FIRST, GLOBAL TAKES OVER BY ITSELF. Global runs six-odd months behind CN, so the events data
regularly names items the EN client has not shipped -- some under hand-translated names, some
still under their CN names. The art is the same on both servers, so an icon fetched from a CN
source IS the final icon; what changes at global launch is the item's display NAME. A reward asked
for by name is asked for again the moment its name flips from CN to its official EN spelling, and
resolved again -- by then the EN item table carries it. The CN-named file it replaces goes stale
and harmless; it is reported, not deleted, because nothing breaks by keeping it and an importer
should not delete what it cannot reproduce.

WHERE ICONS LIVE, tried in order:

  1. A piece of furniture asked for by id: its building_data (EN, then CN) iconId, art from
     prts.wiki's asset CDN -- furniture art is in NO gamedata mirror at all (established by
     searching both repos' full file trees).
  2. item_table (EN, then CN): the item's id where the tables give one, else its name -> iconId,
     art from the CN resource repo's item/ tree. Covers materials, tickets, packs, and operator
     tokens.
  3. building_data (EN, then CN) furniture name -> iconId, art from prts.wiki's asset CDN, for a
     store's piece the event's rewards do not name.
  4. The EN wiki's File:<name>.png uploads, for items the wiki has translated ahead of the
     client (CC store machines and the like).

Entries typed "skin" are NOT items: they resolve through the skins dataset (findSkinIconPath)
and appear when the skin itself lands there. A placeholder name ("Furniture not found", the EN
wiki's own missing-item placeholder scraped into the CC store data, or a "?" or "TBD") is
check-completeness's PLACEHOLDER: never asked for, printed so the scrape gets fixed, and held by
the release as a placeholder.

None of these sources can fail the refresh. A name no source resolves, or whose
download fails, renders without an icon and goes on the quarantine list under
'reward-icons'; the next run tries it again. The reason says which step failed and
never the day's error text, which goes to the log: data/quarantine.json is a release
input, and an outage that answers 502 one day and refuses the connection the next must
not publish a release each day. For the same reason every request is paced, the wiki's
most, and an answer that means "not now" -- a 429, a 5xx, the API's own ratelimited or
maxlag -- is asked again after a backoff rather than read as the wiki being down: a
rate-limited night would otherwise report a name as "could not be reached" between two
nights of "not found", and publish a release for it. Once the wiki stays unreachable
through its retries, the rest of the run asks it nothing more, and every name it would
have asked about says so in the same words.

NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets,
and a file in this repository's public/ is refused by check:assets, which the
daily release runs: writing the icon there turned every SUCCESSFUL fetch into a
blocked release. A fetched icon is therefore staged in .cache/reward-icons/, as its
source serves it (staged_art.py): the game's own circled art, which the publisher keeps
at its native 183px, never shrunk. The release's staged-art stage publishes it as
material-icons/<name or furniture id>.webp and runs this again; until a run does, it is reported under
'reward-icons' too, with its source.

Run:  python3 scripts/imports/import-reward-icons.py
      python3 scripts/imports/import-reward-icons.py --wanted   (prints the files the pages ask for and stops)
"""
from published_assets import published_assets
from quarantine import WIKI_API as WIKI_API_URL, report
from staged_art import Staging
from download_budget import BudgetExpired, DownloadBudget
import glob
import http.client
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO

import certifi
from PIL import Image

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
UA = 'Arkpedia-import/1.0 (+https://arkpedia.net) python-urllib'
download_budget = None


def pause_for(seconds):
    if download_budget:
        download_budget.sleep(seconds)
    else:
        time.sleep(seconds)

root = os.getcwd()
EN = os.path.join(os.environ.get('ARKPEDIA_EN', '.cache/upstream/en-gamedata/en'), 'gamedata', 'excel')
CN = os.path.join(os.environ.get('ARKPEDIA_CN', '.cache/upstream/cn-resource'), 'gamedata', 'excel')


def pinned(variable, branch):
    """The commit this run pinned for a mirror (scripts/content/pin-upstream.mjs; the
    stage runner passes it in), else its branch, as before pinning."""
    commit = os.environ.get(variable) or ''
    return commit if re.fullmatch(r'[0-9a-f]{40}', commit) else branch


PIN_UPSTREAM = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'content', 'pin-upstream.mjs')


def cn_tables():
    """The CN tables' raw folder: the mirror and commit this run settled on for every CN table
    (scripts/content/cn-tables.mjs; the stage runner passes them in as ARKPEDIA_CN_TABLES),
    else -- run by hand -- the primary mirror at its pin, else its branch. pin-upstream.mjs
    works it out (cnTableUrl()), so this script names no CN mirror and reads no mirror's pin
    for a table: at one mirror's pin it would read another mirror, or another commit, than
    the rest of the run on a day upstream-cn fell back."""
    result = subprocess.run(['node', PIN_UPSTREAM, 'cn-table-url', 'excel'], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'Could not tell which CN tables this run reads:\n{result.stderr.strip()}')
    return result.stdout.strip()


EN_REF = pinned('ARKPEDIA_PIN_ARKNIGHTSASSETS_ARKNIGHTSGAMEDATA', 'master')
CN_REF = pinned('ARKPEDIA_PIN_YUANYAN3060_ARKNIGHTSGAMERESOURCE', 'main')
RAW_EN = f'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/{EN_REF}/en/gamedata/excel'
RAW_CN = cn_tables()
ITEM_ART = f'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/{CN_REF}/item'
FURNI_ART = 'https://torappu.prts.wiki/assets/furniture'
WIKI_API = WIKI_API_URL

# A reward name that is a scrape's stand-in for a missing item, not the item -- the wiki's own
# "Furniture not found", a "?", a "TBD": check-completeness.mjs's PLACEHOLDER, character for
# character, so a name the release holds as a placeholder is one this never asks for (want_name).
# Skipped loudly rather than hunted.
PLACEHOLDER = re.compile(r'not found|^\?+$|^(?:tbd|tba|unknown|null|undefined|placeholder|n/a)$', re.IGNORECASE)

ITEM_MIRROR = 'yuanyan3060/ArknightsGameResource'


# A connection that dropped, in whichever form it surfaces: raised as itself while the body is
# read (r.read() raises the ssl.SSLError or the ConnectionResetError, or http.client's
# IncompleteRead, which is no OSError at all), or wrapped in a URLError while connecting.
DROPPED = (ssl.SSLError, ConnectionError, TimeoutError, http.client.IncompleteRead)


def dropped(error):
    return isinstance(error, DROPPED) or (isinstance(error, urllib.error.URLError) and isinstance(error.reason, DROPPED))


WIKI_HOST = urllib.parse.urlsplit(WIKI_API_URL).netloc
# A moment before every request, a retry's too: the wiki's API and its uploads half a second (the
# pace sync-event-stores.mjs keeps between its pages: a run asks the wiki about every name no table
# has, one request after another, and a client that does not pace itself is answered 429), any
# other host a fifth (prts.wiki's furniture CDN serves several hundred icons the first run after
# event-rewards.json lists a season's table rewards).
WIKI_PAUSE, PAUSE = 0.5, 0.2
# Answers that mean "not now" rather than "no": rate limited, or the server or its gateway failing.
RETRY_STATUSES = {429, 500, 502, 503, 504}


class Busy(Exception):
    """The wiki's API answering 200 with its own "not now" (ratelimited, maxlag)."""


def back_off(attempt, retry_after=None):
    # The server's Retry-After where it gives one in seconds (a date is read as none), else 5s then
    # 15s; never more than a minute, so a night of 429s still ends inside the stage's timeout.
    try:
        seconds = float(retry_after)
    except (TypeError, ValueError):
        seconds = 5 * 3 ** attempt
    pause_for(min(max(seconds, 0), 60))


def fetch(url, timeout=90, attempts=3):
    # A dropped connection is retried: a run fetching hundreds of icons meets the odd one (an SSL
    # EOF from prts.wiki's CDN on 2026-10-05, mid-body). The exception is classified as itself
    # first: an ssl.SSLError raised by read() carries its own `reason` -- a string such as
    # 'UNEXPECTED_EOF_WHILE_READING' -- so reading `.reason` first, as this once did, never
    # retried the very case it was written for. A "not now" answer (RETRY_STATUSES) is retried
    # after a backoff; any other HTTP answer is the answer. The last attempt's error goes up, and
    # the caller's reason names the step, never the error.
    pause = WIKI_PAUSE if urllib.parse.urlsplit(url).netloc == WIKI_HOST else PAUSE
    for attempt in range(attempts):
        pause_for(pause)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            request_timeout = download_budget.timeout(timeout) if download_budget else timeout
            with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=request_timeout) as r:
                return download_budget.read(r) if download_budget else r.read()
        except urllib.error.HTTPError as error:
            if error.code not in RETRY_STATUSES or attempt == attempts - 1:
                raise
            back_off(attempt, error.headers.get('Retry-After') if error.headers else None)
        except (*DROPPED, urllib.error.URLError) as error:
            if not dropped(error) or attempt == attempts - 1:
                raise
            pause_for(2 * (attempt + 1))


def table(local_dir, raw_base, name):
    at = os.path.join(root, local_dir, name)
    if os.path.exists(at):
        with open(at, encoding='utf-8') as f:
            return json.load(f)
    return json.loads(fetch(f'{raw_base}/{name}'))


def safe(name):
    """The same character filter getMaterialIconPath applies, so the file this
    writes is the file the page asks for."""
    return re.sub(r'[\\/*?:"<>|]', '', name).strip()


# --- what the event pages want --------------------------------------------------

# Each icon a page asks for, by the file it asks for:
# {target: (name, event, furniture id or None, item id or None)}.
# A reward is asked for under its name (material-icons/<name>.webp); a piece of furniture the game
# names by id under its id (material-icons/<id>.webp, rewardIconPath in lib/events/rewardIcons.ts),
# because two events' "Duel Trophy" are different pieces with different art.
wanted = {}
# The placeholder names met on the way, never asked for: printed at the end so the scrape gets fixed.
placeholders = set()


def is_placeholder(name):
    text = name.strip() if isinstance(name, str) else ''
    return not text or bool(PLACEHOLDER.search(text))


def want_name(name, event, item_id=None):
    # check-completeness holds a placeholder as a placeholder, not as a file (eventRewardIcons'
    # byName), so the two sets of files stay equal.
    if is_placeholder(name):
        placeholders.add(name.strip() if isinstance(name, str) else '')
        return
    wanted.setdefault(f'material-icons/{safe(name)}.webp', (name, event, None, item_id))


def want_furniture(furniture_id, name, event):
    wanted.setdefault(f'material-icons/{safe(furniture_id)}.webp', (name, event, furniture_id, None))


def read_data(name):
    path = os.path.join(root, 'data', name)
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# The rewards the game tables list for each event (data/event-rewards.json: sign-ins, missions,
# milestones, first clears, gifts, the packs' contents) and its store as the wiki lists it
# (data/event-stores.json). This stage runs after the event-rewards stage writes the first, so a
# new event's rewards get their icons in the run that lists them.
event_rewards = read_data('event-rewards.json')
reward_events = event_rewards.get('events', {})
event_stores = read_data('event-stores.json').get('events', {})
store_names = event_rewards.get('storeNames', {})

# The kinds of group an event page lists as rewards, each row with an icon: check-completeness.mjs's
# LISTED_REWARD_KINDS, the tabs TABLE_REWARD_LABEL (lib/events/tableRewards.ts) gives. A notice is
# prose, a furniture set a checklist; the packs are walked on their own.
LISTED_REWARD_KINDS = {'login', 'banner-gift', 'free-rolls', 'missions', 'milestones', 'first-clear'}
# Rows with art of their own, or none: an operator's portrait, an outfit's icon in a rarity folder
# (the skins dataset), and an event token, which the page leaves out (tableRewards.ts LEFT_OUT).
OWN_ART = {'operator', 'outfit', 'event-item'}
# Rows no source here is asked about, and the release does not hold (check-completeness's
# eventRewardIcons skips the same): a table reward or a pack's line of kind 'other' -- under no item
# type build-event-rewards sorts and no piece of furniture (a charm coin, an Ideal City cart part, a
# profile theme, a pack's cosmetics, a pack line the parser misread) -- and a store's upware, a
# mode's own pieces. A table reward with a furni_ or avatar_ id is drawn by
# that id whatever its kind (every player icon is typed 'other'), so the ids are read first. Held
# by the release while no one could fetch them, they stood on the daily issue for good.
UNSOURCED_KIND, UNSOURCED_STORE_TYPE = 'other', 'upware'


def is_piece(item):
    return item.get('kind') == 'furniture' and str(item.get('id', '')).startswith('furni_')


_WRAPPED = re.compile(r"^(['\"\u2018\u201c])(.*)(['\"\u2019\u201d])$", re.S)
_PAIRS = {"'": "'", '"': '"', '\u2018': '\u2019', '\u201c': '\u201d'}


def furniture_key(name):
    """lib/events/furnitureName.mjs's furnitureKey: one pair of wrapping quotes left out, so
    building_data's 'Contemplation' and the wiki store's "Contemplation" are one piece."""
    text = str(name if name is not None else '').strip()
    m = _WRAPPED.match(text)
    return m.group(2).strip() if m and _PAIRS[m.group(1)] == m.group(3) else text


def event_furniture(groups):
    """The furniture an event's rewards name, {name: furniture id}: its rewards' pieces and its
    set's. A store row names a piece and gives no id; two events' "Duel Trophy" are two pieces,
    so the name is looked up in its own event alone."""
    ids = {}
    for group in groups:
        for item in group.get('items', []):
            if is_piece(item):
                ids[furniture_key(item['name'])] = item['id']
        for piece in group.get('pieces', []) or []:
            ids[furniture_key(piece['name'])] = piece['id']
    return ids


def want_store_row(name, kind, event, furniture_ids, icon_name=None):
    """A store row as the page draws it: a piece of furniture the event's rewards name by its id,
    an outfit not from here, a mode's upware from nowhere (UNSOURCED_STORE_TYPE), anything else
    under its name (its iconName first, as rewardIconPath: `iconName ?? name`) -- items, furniture
    the rewards do not name (129 store rows once were neither fetched nor reported).
    building_data finds a piece by its name, else the wiki, else it is reported. A placeholder
    is told by the name the page shows, as check-completeness tells it."""
    if is_placeholder(name):
        placeholders.add(name.strip() if isinstance(name, str) else '')
    elif kind == UNSOURCED_STORE_TYPE:
        pass
    elif kind == 'furniture' and furniture_key(name) in furniture_ids:
        want_furniture(furniture_ids[furniture_key(name)], name, event)
    elif kind != 'skin':
        want_name(name if icon_name is None else icon_name, event)


for path in sorted(glob.glob(os.path.join(root, 'data', 'events', 'events_*.json'))):
    with open(path, encoding='utf-8') as f:
        rows = json.load(f)
    for ev in rows:
        # The page shows the wiki's store where there is one, and this import only where not.
        if event_stores.get(ev['name'], {}).get('stores'):
            continue
        furniture_ids = event_furniture(reward_events.get(ev['name'], {}).get('groups', []))
        rw = ev.get('rewards')
        for block in rw if isinstance(rw, list) else ([rw] if rw else []):
            for item in (block or {}).get('items', []):
                # A reward renamed to its Global name keeps showing the published
                # CN-named file until an EN-named one exists (sync-reward-names.mjs),
                # so that is the file it needs, not one under the EN name; a Chinese name
                # the Global tables have in English shows that (storeNames), and finds its piece
                # of furniture by that name.
                want_store_row(store_names.get(item.get('name')) or item.get('name'), item.get('type'), ev['name'], furniture_ids, item.get('iconName'))

for event, entry in reward_events.items():
    for group in entry.get('groups', []):
        if group.get('kind') in LISTED_REWARD_KINDS:
            for item in group.get('items', []):
                item_id = str(item.get('id') or '')
                if item.get('kind') in OWN_ART or item_id.startswith('avatar_'):
                    continue
                if item.get('kind') == 'free-roll':
                    # A daily free roll is a headhunting roll: the page draws the permit.
                    want_name('Headhunting Permit', event)
                elif item_id.startswith('furni_'):
                    want_furniture(item_id, item['name'], event)
                elif item.get('kind') != UNSOURCED_KIND or item.get('iconName'):
                    # By the item's id where the tables give one: a name the site words its own way
                    # ("... Headhunting Permit (ten-roll)") is not the item table's.
                    want_name(item.get('iconName') or item.get('name'), event, item_id or None)
        if group.get('kind') == 'packs':
            for pack in group.get('packs', []) or []:
                for item in pack.get('contents', []):
                    if item.get('kind') != UNSOURCED_KIND:
                        want_name(item.get('name'), event)

# Every event's store, in a loop of its own: nested under the events event-rewards.json lists, an
# event with a store and no table rewards (none the tables name yet) was never visited.
for event, entry in event_stores.items():
    furniture_ids = event_furniture(reward_events.get(event, {}).get('groups', []))
    for store in entry.get('stores', []):
        for item in store.get('items', []):
            # The page draws a wiki row by its name alone: these rows carry no iconName.
            want_store_row(item.get('name'), item.get('type'), event, furniture_ids)

# Reward Tracker uses the same published item and furniture paths as event rewards.
# Operators/outfits/player-card cosmetics have their own asset pipelines; a choice
# or a free pack with no client icon remains a labelled claim, not fabricated art.
free_claims = read_data('free-rewards.json').get('rewards', [])
free_names = {}
for claim in free_claims:
    for item in claim.get('rewards', []):
        free_names.setdefault(item['name'], set()).add(item['id'])
for claim in free_claims:
    for item in claim.get('rewards', []):
        item_id = str(item.get('id') or '')
        if item_id.startswith(('furni_', 'furniM_')):
            want_furniture(item_id, item['name'], 'Reward Tracker')
        elif item_id.startswith(('char_', 'avatar_', 'bg_', 'nc_', 'GP_freeL_')) or ':choice' in item_id:
            continue
        else:
            want_name(item_id if len(free_names[item['name']]) > 1 else item['name'], 'Reward Tracker', item_id)

if sys.argv[1:] == ['--wanted']:
    # The files the pages ask for that a source here can answer, and nothing read beyond data/: what
    # scripts/tests/test-reward-icons.ts compares with the files check-completeness.mjs holds.
    print(json.dumps(sorted(wanted)))
    raise SystemExit(0)

missing = {target: want for target, want in wanted.items() if target not in published_assets()}
skipped_placeholders = sorted(placeholders)

# Only main's run publishes art (publish-catalogue-assets.sh): another channel's run would fetch
# these only to leave them in its .cache, and fetching every icon main has not published yet held
# each dev run at this stage's 15-minute limit. So it fetches nothing and leaves this stage's
# entries as the loaded data has them; main's run fetches, stages and publishes them.
channel = os.environ.get('ARKPEDIA_RELEASE_BRANCH') or 'main'
if missing and channel != 'main':
    print(f'The {channel} channel publishes no art: {len(missing)} reward icon(s) not published yet are left for main\'s run, and none is fetched.')
    raise SystemExit(0)

# This run's staged icons; the last run's list goes now, so a day with nothing to stage stages nothing.
staging = Staging('reward-icons', root)

if not missing:
    print('Every event reward already has its icon.')
    for n in skipped_placeholders:
        print(f'  (still in the data and still not a real item: "{n}")')
    report('reward-icons', [])
    raise SystemExit(0)

# --- resolve each name to a URL, cheapest source first ----------------------------

items_en = table(EN, RAW_EN, 'item_table.json')['items']
items_cn = table(CN, RAW_CN, 'item_table.json')['items']
# Each item's icon by its id and by its name, the EN table written second so it wins ties.
icon_by_id, by_name = {}, {}
for src in (items_cn, items_en):
    for item_id, it in src.items():
        if it.get('iconId'):
            icon_by_id[item_id] = it['iconId']
            if it.get('name'):
                by_name[it['name']] = it['iconId']

furniture_by_name = None  # loaded lazily: building_data is heavyweight


furniture_by_id = None


def load_furniture():
    global furniture_by_name, furniture_by_id
    if furniture_by_name is None:
        furniture_by_name, furniture_by_id = {}, {}
        for local_dir, raw in ((CN, RAW_CN), (EN, RAW_EN)):  # EN wins ties
            data = table(local_dir, raw, 'building_data.json')
            for furniture_id, f in data.get('customData', {}).get('furnitures', {}).items():
                if f.get('iconId'):
                    furniture_by_id[furniture_id] = f['iconId']
                    if f.get('name'):
                        furniture_by_name[furniture_key(f['name'])] = f['iconId']


def furniture_icon(name):
    load_furniture()
    return furniture_by_name.get(furniture_key(name))


def furniture_icon_by_id(furniture_id):
    load_furniture()
    return furniture_by_id.get(furniture_id)


def wiki_file(name, attempts=3):
    q = urllib.parse.urlencode({
        'action': 'query', 'prop': 'imageinfo', 'iiprop': 'url',
        'format': 'json', 'titles': f'File:{name}.png',
    })
    for attempt in range(attempts):
        body = json.loads(fetch(f'{WIKI_API}?{q}'))
        # MediaWiki says "not now" in a 200 too: asked again like a 429, never read as no file.
        code = (body.get('error') or {}).get('code') if isinstance(body, dict) else None
        if code not in ('ratelimited', 'maxlag'):
            break
        if attempt == attempts - 1:
            raise Busy(f'the API answered {code}')
        back_off(attempt)
    for p in body['query']['pages'].values():
        if 'missing' not in p and p.get('imageinfo'):
            return p['imageinfo'][0]['url']
    return None


# Why a name has no icon yet, in words that stay the same while the problem does.
NOT_FOUND = 'has no icon from the item tables, the furniture art or the EN wiki'
WIKI_DOWN = 'has no icon from the item tables or the furniture art, and the EN wiki could not be reached to ask for one'
FAILED = 'has an icon at {host}, but downloading it failed'
UNREADABLE = 'has an icon at {host}, but it is not an image that decodes'


def cited(reason):
    """A reason as the quarantine file takes it: the wiki by name, never by its wiki.gg host. The
    file is a released record, where that address may only be a citation (sourceRef):
    test-data-records.ts failed the release of 2026-10-15 over a staged icon's reason that named
    it, and scripts/lib/quarantine.mjs refuses one now. Any other host keeps its own name."""
    return re.sub(r'\b(?:[\w-]+\.)*wiki\.gg\b', 'the EN wiki', reason)

fetched, unresolved = [], []
# Set once the wiki stays unreachable through its retries: the rest of the run does not ask it again
# (a night of 429s, each name waiting out its backoff, would outrun the stage's timeout), and every
# name it would have asked about gets the reason asking would have given it.
wiki_down = False
# The same for the art hosts: a host that fails that way (no answer, a dropped connection, or "not
# now" to the last retry) DOWN_AFTER times running is not asked again this run, so a night
# prts.wiki's CDN or GitHub is down ends inside the stage's timeout instead of every icon waiting
# out its backoffs; one file's 500 is still that file's, and a success resets the count. Each icon
# not asked gets the reason fetching gives on such a night. A 404 is that file's alone.
DOWN_AFTER = 3
host_failures, hosts_down = {}, set()


def host_is_down(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code in RETRY_STATUSES
    return isinstance(error, (urllib.error.URLError, *DROPPED))


# Adoption updates availability and quarantine after publication. Fetching another batch
# here would leave its art unpublished and consume the publisher stage's own deadline.
download_budget = DownloadBudget(0 if os.environ.get('ARKPEDIA_ART_ADOPTION') == '1' else 600)
pending = sorted(missing.items())
DEFERRED = 'not fetched within this run\'s download budget; the next refresh retries it'


def defer_remaining(index):
    for _, (name, event, furniture_id, _) in pending[index:]:
        unresolved.append((furniture_id or name, name, event, DEFERRED))
    print(f'  Download budget reached: {len(fetched)} icon(s) staged; {len(pending) - index} left for the next refresh.')


for index, (target, (name, event, furniture_id, item_id)) in enumerate(pending):
    if download_budget.remaining() <= 0:
        defer_remaining(index)
        break
    url = mirror = also = None
    if furniture_id:
        # A piece the game names by id: its own icon, whatever other pieces share its name.
        icon = furniture_icon_by_id(furniture_id)
        if not icon:
            unresolved.append((furniture_id, name, event, NOT_FOUND))
            continue
        url = f'{FURNI_ART}/{urllib.parse.quote(icon)}.png'
        # The art host names a few pieces by their id, not the iconId building_data gives:
        # furni_fNearl_banner_01's iconId furni_fNearl_banner2_01 is a 404 there and its own id is
        # not (Maria Nearl, issue #59, 2026-10-13). Asked for only when the iconId's answer is a 404.
        if icon != furniture_id:
            also = f'{FURNI_ART}/{urllib.parse.quote(furniture_id)}.png'
    elif icon := icon_by_id.get(item_id) or by_name.get(name):
        url = f'{ITEM_ART}/{urllib.parse.quote(icon)}.png'
        # The mirror's own file at the pinned commit, which the image repository maps for its sync.
        if re.fullmatch(r'[0-9a-f]{40}', CN_REF):
            mirror = {'repository': ITEM_MIRROR, 'path': f'item/{icon}.png', 'commit': CN_REF}
    elif icon := furniture_icon(name):
        url = f'{FURNI_ART}/{urllib.parse.quote(icon)}.png'
    elif wiki_down:
        unresolved.append((name, name, event, WIKI_DOWN))
        continue
    else:
        try:
            url = wiki_file(name)
        except BudgetExpired:
            defer_remaining(index)
            break
        except Exception as e:  # noqa: BLE001 -- the wiki is enrichment, never a gate
            # No answer, or "not now" to the last retry: the wiki is down for this run. An answer
            # this cannot read (a maintenance page served as 200) is this name's alone.
            wiki_down = isinstance(e, (urllib.error.URLError, Busy, *DROPPED))
            print(f'  the wiki could not be asked about "{name}": {e}' + ('; it is not asked again this run' if wiki_down else ''))
            unresolved.append((name, name, event, WIKI_DOWN))
            continue
    if not url:
        unresolved.append((name, name, event, NOT_FOUND))
        continue
    host = url.split('/')[2]
    if host in hosts_down:
        unresolved.append((furniture_id or name, name, event, FAILED.format(host=host)))
        continue
    try:
        try:
            blob = fetch(url)
        except urllib.error.HTTPError as e:
            if e.code != 404 or not also:
                raise
            print(f'  "{name}": {url} is a 404; asking for {also}')
            url, blob = also, fetch(also)
        host_failures[host] = 0
    except BudgetExpired:
        defer_remaining(index)
        break
    except Exception as e:  # noqa: BLE001 -- a 404 here is data, not a crash
        if host_is_down(e):
            host_failures[host] = host_failures.get(host, 0) + 1
            if host_failures[host] >= DOWN_AFTER:
                hosts_down.add(host)
        print(f'  FAILED "{name}" from {url}: {e}' + ('; the host is not asked again this run' if host in hosts_down else ''))
        unresolved.append((furniture_id or name, name, event, FAILED.format(host=host)))
        continue
    try:
        im = Image.open(BytesIO(blob))
        im.load()
    except Exception as e:  # noqa: BLE001 -- e.g. an HTML page answered 200
        print(f'  UNREADABLE "{name}" from {url}: {e}')
        unresolved.append((furniture_id or name, name, event, UNREADABLE.format(host=host)))
        continue
    # As the source serves it: the publisher encodes it at the size material-icons/ keeps.
    staged = staging.stage(target, blob, source=url, mirror=mirror)
    # A later source or an external interruption must not discard art already fetched.
    staging.commit()
    fetched.append((furniture_id or name, name, event, url, staged.name, target))
    print(f'  + {staged.name}  ({im.size[0]}x{im.size[1]}, from {host})')
staging.commit()

print(f'{len(fetched)} fetched, {len(unresolved)} unresolved')
for key, name, event, why in unresolved:
    print(f'  ? "{name}" of {event} {why}')
# Keyed by the furniture id for a piece (two events' "Duel Trophy" are two reports), else the name.
report('reward-icons', [{'key': f'reward-icon:{key}', 'action': 'published-partial',
                         'reason': cited(f'The reward "{name}" of {event} {why}; it renders without one until a later run finds it.')}
                        for key, name, event, why in unresolved]
       + [{'key': f'reward-icon:{key}', 'action': 'published-partial', 'sourceRef': url,
           'reason': f'The reward "{name}" of {event} has an icon at {cited(url.split("/")[2])}, staged as '
                     f'.cache/reward-icons/{file}, but no run has published it to arkpedia-image-assets as '
                     f'{target} yet; it renders without one until one does.'}
          for key, name, event, url, file, target in fetched])
for n in skipped_placeholders:
    print(f'  ! "{n}" is a placeholder scraped into the data, not an item -- fix the scrape')
