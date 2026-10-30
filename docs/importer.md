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

The steps that read site code: the pull planner's sources, official videos, the game account map
and guide videos, plus the checks of what pages send (pull-odds rules, payload budgets). Also
story-chapters and story-covers, whose source (arknights.timo.beer) refuses GitHub's runners. They run
in the application's compile job, on the records this leaves.

## Rollout

1. **Shadow:** started by hand only, with no art-repository keys, so the art steps plan and
   publish nothing. The application still runs its own refresh. Runs are compared with what the
   application's nightly publishes.
2. **Scheduled (now):** nightly at 16:17 UTC, hours ahead of the application's 19:57, still in
   shadow mode. A failed step opens one **Import failing** issue (`scripts/alert-issue.mjs`), and
   the next clean run closes it. The two art steps count only once the keys are here.
3. **Cutover:** the application compiles from `imports` and stops running these steps; the art keys
   move here.
4. **Clean-up:** the application deletes its copies.

**Until step 4, `importer/` is a copy:** a change to one of its files lands in the application too
(arkpedia/arkpedia), or waits.
