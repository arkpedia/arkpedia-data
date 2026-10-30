# Data catalogue

What `source/data/` holds. Game records live only in this repository; the Arkpedia application keeps code and fetches them (its `npm run data:pull`). Existing dataset names remain stable because importers, dynamic file lookups, and refresh pipelines depend on them.

| Area | Files/folders |
| --- | --- |
| Operators | `operators-*star/`, `operator-forms.json`, `operator-voice-lines.json`, `skill-ranges.json`, `skill-timings.json` |
| Stages | `stages/`, `stage-geometry/`, `stage-conditional/`, `stages-content.json`, `supply-stages.json` (derived from `stages/`), stage indexes and legends |
| Enemies | `enemies/`, `enemy_appearances.json`, `enemy-stage-appearances.json` |
| Events and banners | `events/`, `headhunting_banners.json`, content windows and rotations |
| Skins and music | `skins.json`, `albums.json` |
| Base and game modes | `gamemodes/`, `base-formulas.json`, `is-nodes.json`, `ra-*.json`, `stronghold_enemies.json`, `mode-rotations.json`, `sss-cycle.json` (the SSS cycle the home ticker counts down to, kept by hand) |
| Planner and materials | `material-catalogue.json` (derived by `scripts/build/build-material-catalogue.mjs`), `material-names.json` (English names of CN-only materials, kept by hand), `operatorLevelExpLmd.json`, `battle-records.json`, `item-sort-ids.json`, `item-icons.json`, `import-aliases.json` |
| Games and curation | `stage-guesser.json`, `music-guesser-review.json`, `color-palette*.json`, `techniques_definitions.json` |
| Editorial pages | `event-announcements.json`, `event-pack-art.json`, `mode-details.json`, `community-{web,offline}-events.json`, `selector-{ratings,tickets,super-meta}.json`, `music-guesser-{event-music,event-expansion,main-story}.json`, `stronghold-{opening,playbook}.json`, `youtube-creators.json`, `community-projects.json`, `patreon-supporters.json` |
| Profile icons | `profile-avatars.json`: the nightly import derives the icon paths and base-skill facility groups from the published asset index and operator records; the app serves it as release JSON. |
| Asset manifests | `assets/`: external file inventory, public availability index, and the asset repositories' pinned commits (`revisions.json`) |
| Stage simulator | `simulator/raw/enemy_database.json` and `simulator/raw/enemy_handbook_table.json`, byte-exact from the pinned EN game data, and `simulator/upstream.json`, their receipt (repository, commit, bytes, SHA256). Read by arkpedia-stage-simulator, not by the site. |
| Polls and statistics | `polls/index.json` (every poll, open or closed), `polls/<id>.json` (a closed poll's frozen result, e.g. `power-scale-v1.0.json`), and later `statistics/` (dated aggregates). Totals only: votes and per-person data stay in Arkpedia's database, and raw responses are archived privately. |

Keep publication explicit and preserve source provenance. Never add raw survey responses, account ids or per-person records here.
