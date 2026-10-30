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

Each step runs through the stage runner (`scripts/content/run-stage.mjs`): a step that fails has
its changes put back and costs only its own records. `run-imports.sh` and
`scripts/sync/refresh-stage-data.sh` list the steps.

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
