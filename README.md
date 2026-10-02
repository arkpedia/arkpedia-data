# Arkpedia game data

Public game content for [Arkpedia](https://github.com/arkpedia). The website's implementation remains in its private application repository. Images and voice recordings remain in their dedicated public asset repositories.

## Repository layout

- `source/data/` — readable operator records, skills, banners, schedules, skins, stages, enemies, and supporting game tables.
- `source/public/` — source catalogues used by the data compiler.
- `release/pages/` — prepared page data named after its route: `recruitment.json`, `operators/Deepcolor.json`, and `index.json` for the homepage.
- `release/public/` — records fetched on demand by the stage browser, enemy handbook, planner, and games. Stage Guesser uses `stage-guesser/catalogue.json` and `stage-guesser/layouts/1-7.json`.
- `release/manifest.json` — source/output checksums, schema version, and matching asset revisions.
- `scripts/` — validation only; the private compiler is not published here.

The `heartbeat` branch holds one small commit per successful run of the application's release job, including runs with nothing new to publish (see [Heartbeat](#heartbeat)).

The `live` branch contains a small `current.json` pointer to an approved immutable commit on `main`. Readers keep that data and media version together for the duration of a page visit. Publishing a data release does **not** rebuild the website.

## Updating content

The application's nightly **Prepare content release** workflow (in its private repository) does the following:
- loads this repository's `source/` records;
- refreshes them from the game's tables and the public mirrors;
- compiles every page into `release/`;
- pushes the result straight to `main`, as a fast-forward with a deploy key scoped to this repository.

No pull request is opened, so its checks are the gate. Here, **Content release** (`.github/workflows/content.yml`) validates every push to `main` with `scripts/validate-release.mjs` and only then moves `live/current.json` to it. A push that fails validation is never served; readers keep the previous release.

**Manual corrections** go in `source/`, on a branch that contains `main`. A maintainer runs **Prepare content release** with that branch as `data_ref` and the upstream refresh off. It compiles the correction and pushes the release to `main`. Editing generated `release/` files, or merging mismatched source and output, is not a valid release.

**Review first:** a push to the `refresh/content` branch still opens a reviewed pull request here, with a summary of what changed. The nightly release does not use it.

The upstream importers refresh operators' game data, stages, game-mode records, event and banner windows, outfits, voices and supporting tables. They do not invent missing editorial descriptions or guides: those still need a supported importer or a reviewed source addition.

## Validation and rollback

Run `node scripts/validate-release.mjs`. It checks all source and generated JSON, complete inventories, hashes, required catalogues, path safety, and the eight asset revisions. No packages or paid services are needed.

To roll back, run **Content release** manually on `main` and enter a previously approved main-branch commit SHA. Only the live pointer changes; the old snapshots remain addressable. The website adopts the pointer after its normal cache refresh. An already open page stays on its existing version.

Schema version 2 uses readable route-based page filenames. Schema 1 hash-named releases are not supported. Deploy the matching application loader before publishing a schema 2 release; later data-only updates do not rebuild the website. Public data/media traffic and GitHub hosting remain subject to GitHub's service limits; public standard Actions runners are free.

## Heartbeat

The application's release job reports its own failures in the application repository, but a run that never starts reports nothing: an offline runner, a disabled workflow, or GitHub refusing private jobs over the Actions budget (as on 2026-09-25). **Release heartbeat** (`.github/workflows/release-heartbeat.yml`) runs here every three hours on public runners, reads this repository's branches with GET requests only, and keeps one issue open per problem until it clears:

- **No content release for over a day**: neither the `live` branch nor the `heartbeat` branch has moved for 26 hours (the repository variable `RELEASE_HEARTBEAT_HOURS` changes that). The release job writes a heartbeat after every successful run, so a quiet day with nothing new to publish is not an outage.
- **Data main is not live**: `main` is not what `live/current.json` serves an hour after it was committed, so **Content release** refused it or never ran. During an intentional rollback this stays open until `main` is published again.

`node --test scripts/release-heartbeat.test.mjs` runs its tests; `node scripts/release-heartbeat.mjs --dry-run` prints what it would open or close without touching any issue. `scripts/alert-issue.mjs` is a copy of the application repository's issue helper; change both together.

## Provenance

This is an unofficial fan resource. Arknights names, artwork, audio, and game content belong to their respective rights holders. The prepared dataset originates from Arkpedia's curated records and its documented public game-data importers, including `Kengxxiao/ArknightsGameData_YoStar` and `yuanyan3060/ArknightsGameResource`. Operator records retain their existing source links and editorial content. No license to redistribute third-party game assets is granted by this repository.
