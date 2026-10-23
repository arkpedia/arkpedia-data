# Simulator token and support-operator data

Generated from the public `ArknightsAssets/ArknightsGamedata` tables
(`character_table.json`, `skill_table.json`) at revision
`db6f9ef8046ad17dbebe3ff1d0dd88844a5bc78c`.

- `deployable-tokens.json` — stage deployable token stats and skills.
- `support-operators.json` — fixed-squad-only operators.

These are engine inputs for `arkpedia-stage-simulator`; the simulator keeps
copies under its own `data/` directory and imports them with
`tools/arkpedia/import-traps.mjs` and
`tools/arkpedia/import-support-operators.mjs`.
