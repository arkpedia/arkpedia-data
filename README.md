# Arkpedia game data

Public game content for [Arkpedia](https://github.com/arkpedia). The website's implementation remains in its private application repository. Images and voice recordings remain in their dedicated public asset repositories.

## Repository layout

- `source/data/` — readable operator records, skills, banners, schedules, skins, stages, enemies, and supporting game tables.
- `source/public/` — source catalogues used by the data compiler.
- `release/pages/` — prepared page data named after its route: `recruitment.json`, `operators/Deepcolor.json`, and `index.json` for the homepage.
- `release/public/` — records fetched on demand by the stage browser, enemy handbook, planner, and games. Stage Guesser uses `stage-guesser/catalogue.json` and `stage-guesser/layouts/1-7.json`.
- `release/manifest.json` — source/output checksums, schema version, and matching asset revisions.
- `scripts/` — validation only; the private compiler is not published here.

The `live` branch contains a small `current.json` pointer to an approved immutable commit on `main`. Readers keep that data and media version together for the duration of a page visit. Publishing a data release does **not** rebuild the website.

## Updating content

The private application's **Prepare content release** workflow loads this repository's source records, runs the existing upstream refresh when requested, and prepares one `refresh/content` PR here. Review the readable `source/` changes; the generated `release/` changes accompany them. Merging a valid PR publishes its commit automatically.

For manual corrections, edit `source/` on a branch. A maintainer runs **Prepare content release** in the application repository with that branch as `data_ref` and upstream refresh disabled. It compiles the correction into the release PR. Merely editing generated files or merging mismatched source/output records is not a valid release.

The existing upstream importers refresh stages, game-mode records, event/banner windows, and supporting tables. This does not invent missing editorial descriptions, guides, or complete new operator records: those still need a supported importer or a reviewed source addition.

## Validation and rollback

Run `node scripts/validate-release.mjs`. It checks all source and generated JSON, complete inventories, hashes, required catalogues, path safety, and the eight asset revisions. No packages or paid services are needed.

To roll back, run **Content release** manually on `main` and enter a previously approved main-branch commit SHA. Only the live pointer changes; the old snapshots remain addressable. The website adopts the pointer after its normal cache refresh. An already open page stays on its existing version.

Schema version 1 must remain compatible with deployed pages. New mechanics or incompatible schema changes require an application update before their content is published. Public data/media traffic and GitHub hosting remain subject to GitHub's service limits; public standard Actions runners are free.

## Provenance

This is an unofficial fan resource. Arknights names, artwork, audio, and game content belong to their respective rights holders. The prepared dataset originates from Arkpedia's curated records and its documented public game-data importers, including `Kengxxiao/ArknightsGameData_YoStar` and `yuanyan3060/ArknightsGameResource`. Operator records retain their existing source links and editorial content. No license to redistribute third-party game assets is granted by this repository.
