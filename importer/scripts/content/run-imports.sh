#!/usr/bin/env bash
# The nightly import, run from importer/ (whose data/ and public/ are ../source/'s): every refresh
# step of the application's Prepare content release that reads no site code. The application
# keeps the steps that do (pull sources, official videos, the game account map, guide videos)
# and the checks of what pages send (pull-odds rules, payload budgets), and compiles the release
# from what this leaves on the `imports` branch (docs/importer.md).
#
# Copied from arkpedia/arkpedia's .github/workflows/prepare-content.yml (refresh step) on
# 2026-10-30. Until the application drops its own copy, a change to a step lands in both.
set -euo pipefail
# What every collection held before any step: completeness fails the run if one shrinks by more
# than 2% from here, unless ARKPEDIA_ALLOW_SHRINK names it.
node scripts/content/check-completeness.mjs --record-baseline
set -euo pipefail
# Every command is a stage (scripts/content/run-stage.mjs). One that fails has what
# it changed under data/ and public/ put back, so its records stay as last published
# (one that finishes an earlier stage's output in place takes that stage back with
# it); the stages that --need it are skipped, the rest carry on, and
# data/stage-report.json and the 'Content quarantined' issue say what happened. Only
# an --invariant stage fails this step: the game tables no stage can do without (CN
# from any one of its mirrors, EN) and the completeness invariants. Its quarantine
# holds are kept even then, so the issue and the evidence show the day's, not
# yesterday's.
stage() { node scripts/content/run-stage.mjs run "$@"; }
node scripts/content/run-stage.mjs begin
trap 'node scripts/content/run-stage.mjs end' EXIT
# One commit per upstream mirror for the whole run, in data/upstream.lock.json.
stage pin-upstream -- node scripts/content/pin-upstream.mjs
# The CN tables, every one from the same mirror at one commit (Kengxxiao, else
# yuanyan3060), before anything reads them: the catalogue, voices and inventory here
# fetch theirs from the mirror this settles on, the stages of refresh-stage-data.sh
# read its checkout (scripts/content/cn-tables.mjs).
stage upstream-cn --invariant --timeout-minutes 30 -- node scripts/content/cn-tables.mjs
# Each region's live client version (data/client-versions.json), after the pins: whether
# the mirror the tables come from has caught up with the game is read at the pinned commit
# (scripts/sync/watch-client-versions.mjs). It reports a mirror behind; it blocks nothing.
stage client-versions -- node scripts/sync/watch-client-versions.mjs
supplemental_charwords="$RUNNER_TEMP/en-supplemental-charwords.json"
stage charwords --output "$supplemental_charwords" -- curl --fail --silent --show-error --location --retry 3 \
  "$(node scripts/content/pin-upstream.mjs raw-url PuppiizSunniiz/ArknightsGameData_YoStar en_US/gamedata/excel/charword_table.json)" \
  --output "$supplemental_charwords"
# Adopts each asset repository's head, even past a folder this code does not map yet
# (check-published-assets.mjs --adopting); Validate holds that folder below.
stage asset-revisions -- npm run assets:update
# Before the catalogue: a skill or base skill the game spells differently gets its icon in
# this run's media plan, not the next night's (sync-operator-english.mjs main()).
# The supplement only adds voice credits here, so without it the English refresh
# still runs, reading an empty table and keeping each record's current credits.
supplement="$supplemental_charwords"
if [ ! -s "$supplement" ]; then supplement="$RUNNER_TEMP/no-supplemental-charwords.json"; echo '{}' > "$supplement"; fi
stage operator-english -- env ARKPEDIA_EN_SUPPLEMENTAL_CHARWORDS="$supplement" node scripts/sync/sync-operator-english.mjs
# The official CN announcements (data/official-news/cn), before the catalogue: an event or
# banner announced on CN is published that day, a week before the client carries it.
stage cn-news -- node scripts/sync/sync-cn-news.mjs
# The in-game notice boards of every region (data/official-bulletins.json): banners by pool
# id with their official art's hash, events and notices, as derived facts only
# (scripts/sync/sync-official-bulletins.mjs).
stage official-bulletins -- node scripts/sync/sync-official-bulletins.mjs
stage catalogue -- node scripts/sync/sync-catalogue.mjs
# Publishes the media plan the catalogue stage wrote in this run, never an older one.
stage catalogue-assets --needs catalogue -- bash scripts/sync/publish-catalogue-assets.sh
stage media-pins -- node scripts/sync/refresh-media-pins.mjs
bash scripts/sync/refresh-stage-data.sh
# Shadow mode, publishing nothing: the CN, Global, JP and KR game tables decoded from the
# official servers ourselves (arkprts + flatc), compared by content with the mirror copies
# this run read (scripts/imports/shadow-official-tables.py). After the stage refresh, which
# checks out the CN and EN tables; the stage checks out the JP and KR ones itself.
stage official-tables --timeout-minutes 30 -- python3 scripts/imports/shadow-official-tables.py
# Every operator's costs -- promotions, skill levels, masteries, module stages -- written
# over whatever the record had, from the Global tables or, for a CN-only operator, the CN
# ones (scripts/sync/sync-operator-costs.mjs). Then it reads every record back and fails
# on a cost that still disagrees with the tables. After the English refresh and the
# catalogue, which write some of them, and the stage refresh, which checks out the EN
# tables; before the material catalogue, which reads the records' costs.
stage operator-costs -- node scripts/sync/sync-operator-costs.mjs
# The planner's material catalogue, from the operator records as they now stand (after
# the English refresh renames their costs), the recipes, the depot order and the item
# tables the stage refresh synced. Then the other planners' item ids for it: a
# catalogue with a material the aliases lack fails /planner's export, so if the
# aliases cannot be rebuilt the catalogue goes back to yesterday's with them (--output).
stage material-catalogue -- node scripts/build/build-material-catalogue.mjs
stage import-aliases --needs material-catalogue --output data/material-catalogue.json -- npx tsx scripts/build/build-import-aliases.ts
# The game's character and module ids, for importing an account into the planner: from
# the operator records as they now stand and the EN client's tables. A record that no
# longer lines up with the client fails it, and yesterday's map stays.
# Each profile card theme's colours, from the client's own theme bundles on Yostar's
# CDN (no table carries them); only a changed bundle is fetched. Before the id map,
# which carries them to the account page.
stage namecard-styles -- python3 scripts/imports/import-namecard-styles.py
stage medal-layouts -- python3 scripts/imports/import-medal-layouts.py
# Shadow mode, publishing nothing: the CN client's own avatar and skill-icon sprites compared
# with the mirror files arkpedia-image-assets publishes (scripts/imports/shadow-client-art.py),
# and any operator whose avatar the client ships while the site has no icon for them yet.
stage client-art -- python3 scripts/imports/shadow-client-art.py
stage medal-catalogue -- node scripts/build/build-medal-catalogue.mjs
# Each event's all-stages medal out of that catalogue, for the Pull Planner's rerun ticks.
stage rerun-clear-medals --needs medal-catalogue -- node scripts/build/build-rerun-clear-medals.mjs
stage reward-names -- node scripts/sync/sync-reward-names.mjs
# The voice lines take newly released operators' English text from the supplement:
# without it they keep yesterday's lines rather than fall back to Chinese. The skin
# table says which outfits bring a voice set of their own (CN's is fetched by URL).
stage voices --needs charwords -- env ARKPEDIA_EN_CHARWORDS=.cache/upstream/en-gamedata/en/gamedata/excel/charword_table.json \
  ARKPEDIA_EN_SKINS=.cache/upstream/en-gamedata/en/gamedata/excel/skin_table.json \
  ARKPEDIA_EN_SUPPLEMENTAL_CHARWORDS="$supplemental_charwords" npm run voices:refresh
# Monster Siren's new albums and songs, before the lyrics that key on them.
stage albums -- npm run albums:refresh
# Arknights: Endfield's albums and songs, from its label's YouTube channel
# (data/endfield-albums.json, scripts/sync/sync-endfield-albums.mjs).
stage endfield-albums -- npm run endfield-albums:refresh
# Each event's PVs and official videos (data/event-videos.json), from the official YouTube
# channels' uploads (data/official-videos.json): after the albums, whose operator EPs it
# reads. Feeds on main's run only (scripts/sync/sync-official-videos.mjs).
stage lyrics -- npm run lyrics:refresh
# The art the importers above staged under .cache/ instead of publishing -- a new
# event's stage renders, drop and reward icons, crests, CC/IS/RA renders, album
# covers (config/staged-art.json) -- published to arkpedia-image-assets with the same
# deploy key and publisher as the catalogue's media; then those importers run again,
# so their records point at the files and their quarantine entries clear today.
# After the last importer that stages art, before anything that reads the records.
stage staged-art -- bash scripts/sync/publish-catalogue-assets.sh --staged
# The palette game's five swatches for every Base and Elite 2 artwork, read from
# arkpedia-skin-assets at the commit data/assets/revisions.json pins once staged-art,
# the last stage that moves the pins (its assets:update re-pins every asset repository),
# has run: the commit the release publishes. Only new or changed art is downloaded.
# Art without a review or recipe gets an automatic palette and a hold; the completeness
# stage holds any released operator still without one (test-stage-runner.ts keeps
# every --revisions reader after every stage that moves the pins).
stage palettes -- python3 scripts/palettes/build-color-palettes.py --revisions data/assets/revisions.json
stage content-inventory -- node scripts/sync/sync-content-inventory.mjs
stage event-farming -- node scripts/sync/sync-event-farming.mjs
# A scheduled limited, crossover or Orienteering banner whose announcement nobody has
# read shows no odds in the pull planner. Each is listed in the daily issue until its
# rules are in data/pull-odds-rules.json (scripts/content/check-pull-odds.ts). It reads
# the day's banners, so it runs after every stage that adds them.
# What the guessers send to readers, measured once every stage that adds records has
# run. It writes nothing: over budget fails only this stage, so the daily issue names
# it until the payload is trimmed or the budget raised, and the release still goes
# out (scripts/audits/check-payload-budgets.ts).
stage completeness --invariant --keep data/quarantine.json -- node scripts/content/check-completeness.mjs
