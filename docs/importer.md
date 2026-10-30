# The importer

`importer/` refreshes the game records in `source/` from the game's tables and public mirrors.
It is every refresh step of the Arkpedia application's nightly **Prepare content release** that
reads no site code, moved here so that data and the code that makes it live together, and run on
GitHub's runners (this repository is public, so they cost nothing).

## How it runs

`.github/workflows/import.yml` (**Import game records**):

1. checks out `main` and installs `importer/`'s dependencies (`package.json`, the two
   `requirements.txt`, flatc);
2. runs `importer/scripts/content/run-imports.sh` from `importer/`, whose `data/` and `public/`
   are links to `../source/data` and `../source/public`, so every step reads and writes the records
   in place, with the same paths it has in the application;
3. commits `source/` to the **`imports`** branch, rebuilt from `main` on each run, and pushes it.

It never pushes to `main`: `scripts/validate-release.mjs` refuses `source/` changed without its
compiled `release/`. The application compiles the release from `imports` (its `data_ref`) and
publishes source and release to `main` together, as it does for `editorial`.

**After a game patch** the import does not wait for the night:
`.github/workflows/client-version-dispatch.yml` checks every three hours whether a region's client
is past the published tables and its mirror already carries the new version, and if so starts
`import.yml` with `reason: patch`. That import's commit on `imports` says "patch", and the
application's content watcher compiles it as soon as it sees it.

Each step runs through the stage runner (`scripts/content/run-stage.mjs`): a step that fails has
its changes put back and costs only its own records. `run-imports.sh` and
`scripts/sync/refresh-stage-data.sh` list the steps.

## Guide videos

The `guide-videos` refresh stage (`scripts/sync/sync-guide-videos.mjs`, rules in `scripts/sync/guide-videos.mjs`) adds trusted creators' YouTube guides to the operator records' `guides`. It reads two files in `arkpedia-data`:

- `source/data/guide-creators.json`, kept by hand on the `editorial` branch: who is trusted.
- `source/data/guide-videos-state.json`, written only by the stage: for each channel, the day its whole history was read (`backfilledAt`) and the newest upload handled (`newest`); the `pending` suggestions; and `decided`, every video the stage has added or suggested, or seen in an operator's `guides`. The stage never adds or suggests a video it has decided on again.

The state file is what stops a channel being read from its first upload again. With a registry but no state file, the stage reads no channel and holds every creator in the daily `Content quarantined` issue. Restore the file from the repository's history. Only when no creator has ever been read does `npx tsx scripts/sync/sync-guide-videos.mjs --first-backfill` start from nothing.

A video is added only when its title names exactly one operator and reads as a guide. Names come from records, former names (`aliases`) and Chinese names. The longest name wins, so "Blaze the Igniting Spark" is the alter, not Blaze. "Texas alter" is the record its `alternate` names. A title also needs a guide word ("Operator Hindsight", "guide", "review", "how to use", "should you get/build...") or one of the creator's own patterns, and none of the words of another kind of video (stage codes, clears, tier lists, modules, outfits, events, pulls, "operators", a subscriber special, "part 2", other games, and the Chinese words for the game modes). The video is appended after the record's own guides. An operator gets at most one guide per creator: of several, the one in the creator's series format wins, otherwise the newest. Every other video that names an operator goes to the `Guide suggestions` issue with its candidate operators. Shorts and streams are ignored.

Event, Integrated Strategies and other mode names the release holds (`data/stages-content.json`, `event-rewards.json`, `event-stores.json`) are taken out of a title before it is matched, so "Maria Nearl", "Mizuki & Caerula Arbor" or "Dorothy's Vision" never names Nearl, Mizuki or Dorothy. Written short or misspelt ("Mizuki IS", "Mizuki Arbor", "Crimson Solitare", "Grani Rerun", "Gavial Returns"), they still read as another kind of video: IS on its own, roguelike, rerun, a capitalised "Returns", and the themes' own words (Arbor, Caerula, Solitaire, Fungimist). A title that still names an operator next to one ("Gavial The Great Chief Returns") goes to the issue. An operator name that is an ordinary word (May, April, Ray, 医生 for Doc) counts only when capitalised, and such a title always goes to the issue.

To add a trusted creator:

1. Pull the `editorial` branch of `arkpedia-data`.
2. Find the channel id. Ask `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<one of their videos>&format=json` for the channel's handle (`author_url`). That channel page's `<link rel="canonical">` is `https://www.youtube.com/channel/UC…`. Check it: `yt-dlp --flat-playlist --dump-single-json https://www.youtube.com/channel/<id>/videos` should list their known videos.
3. Add them to `creators` in `source/data/guide-creators.json`:

   ```json
   { "name": "DragonGJY", "channelId": "UC4kAu36j1X8qGXys4ZEc77Q", "handle": "@DragonGJY",
     "titlePatterns": ["^Operator Hindsight: § Analysis$"] }
   ```

   `name` is written into `guides[].creator` as given, so spell it as the existing guides do. `aliases` is optional: other spellings the existing guides credit the same channel by (`"aliases": ["whaleyyy337"]` for Whaleyyy), so a record with one of those already has a guide by the creator. `titlePatterns` is optional: case-insensitive regular expressions for the creator's own guide format, tested with the operator's name replaced by `§`. A title matching one counts as a guide, and wins over the creator's other videos of the same operator.
4. Push. The file is checked when the stage reads it (`checkGuideCreators`). An unknown field, a bad channel id, a name or alias used twice or a broken pattern fails the stage and changes nothing.

The first nightly run after that reads the creator's whole upload history once, with yt-dlp's flat listing of the channel's Videos tab (no API key, no Shorts or streams). It records `backfilledAt` and never reads the history again; at most three new creators get this per run. After that only the latest uploads are read: the Atom feed (`feeds/videos.xml?channel_id=…`, about 15 videos), or the first 30 of the flat listing when the feed fails, as the feeds did for hours from the NAS on 2026-10-15. If those no longer reach back to `newest` (the nightly was down for days), the stage reads the listing back to it, up to 300 uploads, never the whole channel. If `newest` is not among those either (deleted or made private), they are read as a whole history is: only guide-like titles are suggested. The feed also lists the channel's past streams, as ordinary videos with no live flag, and the Videos tab does not. So on a night the feed was read, the stage reads the listing's head (30) whenever a feed upload would be added: only an upload the head has too is added, and one only the feed lists goes to the issue as likely a stream. If the head cannot be read, no feed upload is added that night, and they are read again the next. `newest` is always an upload of the Videos tab too: when the marker has to move on a feed night, it moves to the listing's head. A listing with no usable upload (a yt-dlp that no longer understands YouTube's page) counts as a failed read: the channel is held and its state left as it was. A channel that cannot be read changes nothing and is held in `data/quarantine.json` (the daily `Content quarantined` issue) until a run reads it. A whole history, and every upload at or below `newest`, suggests only titles that read as a guide, not every old stage clear or outfit video that names an operator.

The stage has 10 minutes for YouTube, inside the 15 run-stage gives it, and each feed request and yt-dlp call gets at most the time left, so the stage always stops on its own. A channel the time does not reach is held and read the next night; each night starts from another creator. Only the main channel's run reads YouTube (`ARKPEDIA_DATA_BRANCH` main): dev's compiles data main's records, which already have main's guides.

To act on a suggestion, first merge data main into the editorial branch (`git fetch origin && git merge origin/main`): the nightly adds to the same `guides` lists on main, and an editorial branch behind it conflicts, which stops the editorial compile. Then add its video to the operator's `guides`, or, to turn it down, add its video id to `dismissed` in `guide-creators.json`. Either clears it from the issue on the next refresh. A suggestion nobody acts on drops off after 45 days and is not suggested again. To take back a guide the stage added wrongly, remove it from the record (on editorial, merged with main as above): it is decided, so the stage never adds it again. Run the stage locally with `npx tsx scripts/sync/sync-guide-videos.mjs` from `importer/` (it needs `yt-dlp` on `PATH`, or `ARKPEDIA_YT_DLP`). `--listings <dir>` reads recorded listings (`<dir>/<channelId>.json`) instead of YouTube.

yt-dlp is pinned in `scripts/content/requirements.txt`, with UnityPy and lz4, and Dependabot proposes a bump weekly. When YouTube changes its pages, an old yt-dlp lists nothing: the stage logs the version it ran with (`yt-dlp 2026.08.19`) and holds every channel whose feed failed too. Take the bump, or raise the pin by hand to the latest release on PyPI.

## What each stage-data script owns

Paths below are under `importer/scripts/` unless they say otherwise.

| script | writes | reads |
| --- | --- | --- |
| `scripts/stage-pipeline/build.mjs` | `data/stages/`, `data/stages-content.json`, `data/stage-geometry/`, `data/stage-conditional/`, `data/stage-tile-legend.json`, `public/stages-index.json` | EN gamedata; a CN level file where Global has dropped a stage's own (see `scripts/stage-pipeline/README.md`) |
| `build-supply-stages.mjs` | `data/supply-stages.json` (the planner's supply table) | the supply content's stage records and their guaranteed drops |
| `build-mode-exclusions.mjs` | `data/excluded-contents.json`; holds in `data/quarantine.json` | `activity_table` types, content kinds, `data/game-modes.json` |
| `import-stage-renders.mjs` | `preview` on stage records whose render is published; new renders staged in `.cache/stage-renders/` | EN `stage_table`, CN `map/` renders, the asset index |
| `import_is_nodes.py` | `data/is-nodes.json`; new IS renders staged in `.cache/is-nodes/` | `roguelike_topic_table`, fexli renders |
| `import_cc_stages.py` | `data/cc-stages.json`, CCB labels in `stages-content.json`; new CCB renders staged in `.cache/cc-stages/` | `medal_table`, `map/` renders |
| `import_stage_devices.py` | `data/stage-devices.json` | level files' `predefines`, `character_table` |
| `build-story-groups.mjs` | `data/story-groups.json` | `stage_table.storylines` |
| `build-content-windows.mjs` | `data/content-windows.json` | `activity_table`, `crisis_v2_table` |
| `import-item-icons.mjs` | `data/item-icons.json`; new token icons staged in `.cache/item-icons/` | stage drops, CN `item/` icons, the asset index |
| `enrich-stage-index.mjs` | `public/stages-index.json` (in place) | everything above |
| `build-enemy-records.mjs` | `data/enemies/`, `data/enemy_appearances.json` | `enemy_handbook_table`, `enemy_database`, stage records, the enriched index |
| `build-enemy-stage-appearances.mjs` | `data/enemy-stage-appearances.json` | stage records, the enriched index |
| `build-enemies-index.mjs` | `public/enemies-index.json` | `data/enemies/`, `data/enemy_appearances.json` |
| `build-stronghold-enemies.mjs` | `data/stronghold_enemies.json` | stage records, `data/enemies/`, `public/enemies-index.json` |

`enrich-stage-index.mjs` **runs last of the steps that write the index**: it applies
the exclusions and folds in the variant links, the names the source leaves blank, CCB
codes and names, and the content labels. Running it before the others leaves the index
missing all of that. The enemy steps run after it, because they take the enriched
index as the list of stages that get a page. `check-completeness.mjs` fails a release
in which a listed stage fields an enemy with no record or no `enemies-index.json` row.


## What stays in the application

- The **pull sources** and **first clears** (`pulls`): built with the pull planner's own code,
  which reaches the site's event calendar.
- **story-chapters** and **story-covers**: their source (arknights.timo.beer) refuses GitHub's
  runners.
- The checks of what pages send: **pull-odds rules** and **payload budgets**.
- When it compiles an editorial edit without a refresh, the application files the official videos
  into events again (`sync-official-videos.mjs --offline`) and rebuilds any palette whose review
  or recipe changed, so those overrides show within minutes rather than the next night.

They run in the application's compile job, on the records this leaves.

## Rollout

1. **Shadow:** started by hand, with no art-repository keys; runs were compared with what the
   application's nightly published.
2. **Scheduled:** nightly at 16:17 UTC, hours ahead of the application's 19:57. A failed step opens
   one **Import failing** issue (`scripts/alert-issue.mjs`), and the next clean run closes it.
3. **Cutover (2026-10-30):** the art keys are here and `IMPORT_PUBLISHES_ART` is `1`; the
   application compiles from `imports` and runs only the steps that stay.
4. **Phase 4 (2026-10-30):** the game account map, official videos, guide videos (with the
   **Guide suggestions** issue) and free rewards moved here too.
5. **Clean-up:** the application deletes its copies of every script only this job runs.

## Files both repositories keep

Some modules are read by the site and by a step here (`lib/`, a few `config/` files, the stage
runner). Each is a copy of the application's, and the application's Check compares every file the
two share, so a change lands in both or fails there.
