#!/usr/bin/env bash
#
# Rebuilds everything under data/ and public/ that describes stages, in the order
# the steps depend on each other. Run it after a new event lands.
#
# A fresh clone of THIS repo is all it needs. Everything upstream is pulled into
# .cache/upstream/ as partial, shallow, sparse checkouts -- only the paths a step
# actually reads are downloaded -- and re-running fetches just what moved.
#
# Every step is idempotent, so running it twice is harmless. Point any step at a
# local checkout instead with ARKPEDIA_CN / ARKPEDIA_EN.
#
# Each step is a stage (scripts/content/run-stage.mjs). A step that fails has what it
# changed under data/ and public/ put back, the steps that --need it are skipped, and
# every other step still runs; data/stage-report.json says what happened. A step that
# finishes in place what the stage build wrote says so with --output: if it fails, the
# build is rolled back with every step that ran on it, so a half-made dataset (the raw
# index, CC# labels, RA records without their maps) is never what goes out. Only the
# two sets of game tables are --invariant: without them no step has a source, so their
# failure stops the refresh. Run on its own, the refresh first pins one commit per
# upstream mirror and settles where the CN tables come from, and exits non-zero at the
# end if any step failed. Inside the daily release (ARKPEDIA_STAGE_RUN=1) its stages
# join that run, which did both already and decides what fails the release.
set -euo pipefail
cd "$(dirname "$0")/../.."

stage() { node scripts/content/run-stage.mjs run "$@"; }
standalone=
if [ -z "${ARKPEDIA_STAGE_RUN:-}" ]; then
  standalone=1
  node scripts/content/run-stage.mjs begin
  stage pin-upstream -- node scripts/content/pin-upstream.mjs
  # The CN tables, every one from the same mirror at one commit, with a fallback mirror
  # (scripts/content/cn-tables.mjs). The daily release runs this before its catalogue.
  stage upstream-cn --invariant --timeout-minutes 30 -- node scripts/content/cn-tables.mjs
fi

# Upstream data. Every source is PUBLIC. Nothing here needs credentials or a sibling
# checkout, which is the point: this repo is what gets deployed, so it has to be able
# to rebuild its own data even if every other repo in the project goes away. Each
# checkout is at the commit pinned for its repository (scripts/lib/upstream.sh).
#
# CN art: the stage and CCB map renders and the item icons, which only yuanyan3060
# carries. Not an invariant: without it, item-icons is skipped, stage-renders tries Closure Wiki, and
# cc-stages publishes the renders the image repository has; the tables still come from
# the mirror upstream-cn chose.
#
# Every importer below that fetches art stages it under .cache/<kind>/ (config/staged-art.json);
# none publishes. Inside the daily release the staged-art stage publishes it to
# arkpedia-image-assets and runs the importer again; run on its own, this leaves it staged
# and reported.
stage upstream-cn-art --timeout-minutes 20 -- node scripts/content/cn-tables.mjs art
# EN gamedata: the whole stage dataset comes out of this one. excel/ for the
# tables, levels/ for the maps, the waves and the enemy configurations.
stage upstream-en --invariant --timeout-minutes 20 -- bash scripts/lib/upstream.sh \
  en-gamedata https://github.com/ArknightsAssets/ArknightsGamedata.git default \
  en/gamedata/excel en/gamedata/levels

# Verified Global recruitment pool.
stage recruitment -- node scripts/sync/sync-recruitment.mjs

# The stage dataset: records, geometry, contents, index.
stage stage-dataset -- node scripts/stage-pipeline/build.mjs

# --- everything below that --needs stage-dataset is DERIVED from what the build
# just wrote. If the build fails, those steps are skipped, so the dataset and all
# that is derived from it stay as they were, together. Three of them rewrite the
# build's own files in place (--output below): if one of those fails, the build and
# everything derived from it are rolled back to the same end.

# Limited-time game modes to exclude.
stage mode-exclusions --needs stage-dataset -- node scripts/build/build-mode-exclusions.mjs

# Map renders for the stages without one: a new event's, from the CN art's map/. Staged in
# .cache/stage-renders/ for the release's staged-art stage to publish, which then runs this
# again so the records point at them the same day. Before the index enrichment, which reads
# which contents have a map or a preview.
# After mode-exclusions: nothing is fetched for a content the site leaves out.
# Missing client renders fall back to Closure Wiki, even when upstream-cn-art failed.
stage stage-renders --needs stage-dataset -- node scripts/imports/import-stage-renders.mjs

# Integrated Strategies nodes: renders, Emergency Ops, borrowed names.
stage is-nodes --needs stage-dataset -- python3 scripts/imports/import_is_nodes.py

# Contingency Contract Battleplan: codes, names, renders, CCB labels.
# Relabels the build's data/stages-content.json in place (CC# -> CCB#).
stage cc-stages --needs stage-dataset --output data/stages-content.json -- python3 scripts/imports/import_cc_stages.py

# Reclamation Algorithm maps, which only the wiki has.
# Puts each map back on the RA stage records the build just rewrote without one.
stage ra-maps --needs stage-dataset --output data/stages -- python3 scripts/imports/import_ra_maps.py

# Pre-placed devices on each map.
stage stage-devices --needs stage-dataset -- python3 scripts/imports/import_stage_devices.py

# Supply stages: which permanent stage hands out which material (the planner's table).
# After the stage build, because it reads the stage records it writes (data/stages/).
stage supply-stages --needs stage-dataset -- node scripts/build/build-supply-stages.mjs

# The depot screen's own item order.
stage ingame-order -- node scripts/build/build-ingame-order.mjs

# Base formulas (Workshop + Factory), for the planner's crafting.
# Reads the EN tables synced above. Not a stage step, but it is the only place the
# EN gamedata is already on disk, and a formula table that ages silently is worse
# than one that costs a few seconds here.
stage base-formulas -- node scripts/imports/import-base-formulas.mjs

# Story groups: the acts and the 13 side-story lines.
stage story-groups --needs stage-dataset -- node scripts/build/build-story-groups.mjs

# Annihilation rotation and SSS seasons.
stage mode-rotations --needs stage-dataset -- node scripts/build/build-mode-rotations.mjs

# Nation crests for the Annihilation cards.
# After the build, because it reads the Annihilation contents to know which nations
# to ask the wiki for. The hand-fed importers (import-story-marks.py,
# import-act-marks.py, import-mode-marks.py) are NOT here on purpose: their input is
# screenshots and traced art, not anything this script can fetch.
stage nation-marks --needs stage-dataset -- python3 scripts/imports/import-nation-marks.py

# The Arknights Story Map, the community whiteboard the Story page draws (data/story-map.json),
# with each story a link into Timo's story reader. Reads no game data, so it needs no stage.
# A new picture is staged in .cache/story-map/ for the staged-art stage.
stage story-map -- python3 scripts/imports/import_story_map.py
# Each of the map's chapters, section by section, as Timo's story reader numbers them, for the Story
# page's complete library and chapter popups: read from the reader's catalogue as data,
# independently of the map, so a failed canvas import cannot block new stories.
# story-chapters stays in the application: its source (arknights.timo.beer) refuses GitHub's runners (HTTP 403).
# Reader cover images are staged separately, so an art-source outage cannot discard stories.
# story-covers stays in the application: its source (arknights.timo.beer) refuses GitHub's runners (HTTP 403).

# Run windows, for the Current group and the default chapter.
stage content-windows --needs stage-dataset -- node scripts/build/build-content-windows.mjs

# Item icons for the drops. A new token's icon is staged in .cache/item-icons/ and
# reported until the image repository publishes it; nothing is written under public/.
# Without the CN art it keeps its map and its reports as they were.
stage item-icons --needs stage-dataset,upstream-cn-art -- node scripts/imports/import-item-icons.mjs

# Operators the map can deploy: ranges and DP per promotion.
# Independent of the stage dataset -- it reads character_table and range_table, plus
# our own operator records for the alter names -- but it belongs to the same refresh:
# a new operator has to reach the map's deploy bar too.
stage operator-deploy -- node scripts/build/build-operator-deploy.mjs
stage operator-summons -- node scripts/build/build-operator-summons.mjs
# Amiya class forms: the Guard and Medic operator records.
stage amiya-forms -- node scripts/build/build-amiya-forms.mjs
# Skills that change an operator attack range.
# After the Amiya forms, not before: that step WRITES two operator records into
# data/operators-5star, and this one reads every record in data/operators-* to decide
# whose skills it has to look up. Run the other way round it would simply not see the
# two forms and would leave their skill ranges out, silently -- it fails loudly on a
# record it cannot match in the gamedata, but not on a record that is not there yet.
# Not --needs amiya-forms: if that step fails, the records it would have written are
# yesterday's, which this one reads just as well.
stage skill-ranges -- node scripts/build/build-skill-ranges.mjs

# Module stat bonuses from the Global client.
stage module-stats -- node scripts/sync/sync-module-stats.mjs

# Guide videos: the trusted creators' new YouTube guides (data/guide-creators.json, kept in
# arkpedia-data), added to the operator records' guides when a title names exactly one operator
# and reads as a guide; the rest wait in data/guide-videos-state.json for the 'Guide suggestions'
# issue. A creator's whole upload history is read once, the night after they are trusted; then
# only their latest uploads (scripts/sync/sync-guide-videos.mjs). After the Amiya forms, which
# write two operator records, so their guides are read as written. Reads the release's event and
# mode names (data/stages-content.json, event-rewards.json, event-stores.json), no game tables; GET
# only, and yt-dlp for channel listings, each call within the stage's own 10 minutes. Main's run
# only: on dev's (ARKPEDIA_DATA_BRANCH dev) it logs that it skipped. Under tsx: the matcher reads
# the site's alter map.
# guide-videos stays in the application (it reads the site's operator aliases).

# Animated outfit art: which artwork has a Spine model in arkpedia-l2d-assets, as model.json
# URLs pinned to that repository's commit (data/dynamic-art.json), for the focused artwork view.
# Reads no game data, so it needs no earlier stage; GET only. Fails, and keeps yesterday's file, when the
# repository cannot be read; one with no manifest yet has no models.
stage dynamic-art -- node scripts/sync/sync-dynamic-art.mjs
stage chibi-art -- node scripts/sync/sync-chibi-art.mjs

# Index enrichment (last step that writes the index).
# Last of the steps that WRITE the index, and it has to be: it applies the exclusions
# to the index and copies in what the steps above resolved -- variant links, the
# names the source leaves blank, CCB codes and names, and the content labels. The
# enemy steps below only READ it.
# The build writes the index raw; this rewrites it in place.
stage stage-index --needs stage-dataset --output public/stages-index.json -- node scripts/build/enrich-stage-index.mjs

# A rolled-back import must not look like a successful fresh stage catalogue.
# Verify every Global source id and its navigation entry after filtering, at the
# run's pinned revision. Missing/skipped dependencies fail the release explicitly.
stage stage-coverage --needs stage-index --invariant -- node scripts/audits/check-stage-coverage.mjs

# After the enrichment, not before. The enemy steps take the index as the allowlist
# of stages that get a page, and until the exclusions are applied it still lists the
# limited-time modes that have none; the stage links also key on its variantOf and
# read its CCB labels. In this order because each reads what the one before wrote:
# the records and their appearance rows, then the stage links, then the grid's index.
# Enemy records: new enemies filed, every record refreshed from the handbook.
stage enemy-records --needs stage-index -- node scripts/build/build-enemy-records.mjs
# Which stages field each enemy.
stage enemy-appearances --needs enemy-records -- node scripts/build/build-enemy-stage-appearances.mjs
# Enemy index for the handbook grid.
stage enemy-index --needs enemy-records -- node scripts/build/build-enemies-index.mjs

# Enemies of the running Stronghold Protocol event.
# After the enemy index, since it reads the stat lines out of it, and after the stage
# records, since it reads which enemies each stage fields.
stage stronghold-enemies --needs enemy-index -- node scripts/build/build-stronghold-enemies.mjs

# Event and banner calendars: real windows over estimates.
# Read today's official Global announcements before banner reconciliation. The
# client may open before maintenance ends; named announcements supply playable times.
stage official-news -- node scripts/sync/sync-official-news.mjs
# The events files are written from announcements and carry ESTIMATED dates for
# the future; once the client ships an activity or gacha window, that window is
# the truth. This keeps the home page's countdowns agreeing with the Terminal,
# which reads the same client tables via build-content-windows.mjs.
# Recurring Standard and Kernel banners first, so their windows are reconciled too.
stage recurring-banners -- node scripts/sync/sync-recurring-banners.mjs
# The operators Global moves from Standard to Kernel Headhunting, as the yearly banner page
# states them, onto the records whose pool fields the gacha simulator and the pull planner read
# (scripts/sync/kernel-pool.mjs). One way only: a move is never taken back.
stage kernel-pool -- node scripts/sync/sync-kernel-pool.mjs
stage event-windows -- node scripts/sync/sync-event-windows.mjs
# Permanent RA themes are outside activity_table; import each launch by its stable topic ID.
stage ra-releases -- node scripts/sync/sync-ra-releases.mjs
# Regional IDs and first-party notice corrections, independently of English calendars.
stage regional-schedules -- node scripts/sync/sync-regional-schedules.mjs

# The event-reward stages, after event-windows: each one dates the events it reads, and an
# estimated date the client has since corrected misplaces a login, a post or a store's 30-day
# refetch window. None of them writes anything event-windows reads.
#
stage community-web-events -- node scripts/sync/sync-community-web-events.mjs

# Each event's store as arknights.wiki.gg lists it, a rerun's from its /Rerun page
# (data/event-stores.json): no table or announcement has a store's listings. A page parsed before
# is read again only while its event is running, ahead, or ended within 30 days.
stage event-stores -- node scripts/sync/sync-event-stores.mjs

# Each event's rewards beyond its store (data/event-rewards.json): from the Global tables synced
# above (the CN ones, upstream-cn's, for an event Global has not had yet), sign-in events, banner
# gifts, milestones, missions, stage first clears and furniture sets; from the announcements,
# packs, daily free rolls and announced gifts; and a rerun its original run's until its own
# appear. Stores are event-stores' above.
stage event-rewards -- node scripts/build/build-event-rewards.mjs

# Official shop artwork for the sets the rewards name, including inherited reruns.
# Keep CN originals; automatically prefer Global when its client thumbnail arrives.
stage furniture-art --needs event-rewards -- node scripts/imports/import-furniture-art.mjs

# Reward icons for every reward an event page lists: the stores (event-stores.json), the rewards
# the tables and announcements list (event-rewards.json, written just above, so a new event's
# icons come the run it is listed) and the events' own fallback stores. Furniture by its
# building_data id where the rewards give one, else by name; items by id where the tables give
# one; not a row no source has an icon for (a reward or pack line of kind 'other', a mode's
# upware), which the completeness stage does not hold either. CN-sourced art is the final art --
# identical on both servers -- so an event Global has not had yet gets its icons too. See the
# script's own header for the sources.
stage reward-icons -- python3 scripts/imports/import-reward-icons.py

# Banner and event key art is not a stage here: arkpedia-image-assets' sync-images.yml
# swaps in the English art (sync_global_banner_art.py, sync_recurring_banner_art.py), and
# a release takes it with that repository's commit (data/assets/revisions.json).

node -e '
const fs = require("fs");
const index = JSON.parse(fs.readFileSync("public/stages-index.json", "utf-8"));
const count = (p) => fs.existsSync(p) ? fs.readdirSync(p).length : 0;
console.log(`  ${index.length} stages in the index`);
console.log(`  ${count("data/stages")} stage records, ${count("data/stage-geometry")} geometries`);
console.log(`  ${Object.keys(JSON.parse(fs.readFileSync("data/item-icons.json", "utf-8"))).length} drop items mapped to a published icon`);
console.log("  next: npm run build");
'
if [ -n "$standalone" ]; then node scripts/content/run-stage.mjs end --strict; fi
