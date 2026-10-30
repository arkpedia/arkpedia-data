# The stage dataset, built from public gamedata

`build.mjs` writes every stage file the site serves. It replaces a private
pipeline this repo used to depend on, and it is verified against that pipeline's
output rather than by inspection: `verify.mjs` compares field by field against the
committed `data/stages/`.

```bash
node scripts/stage-pipeline/verify.mjs           # every field, all 3,315 table-backed stages
node scripts/stage-pipeline/verify.mjs zone act  # narrow it to named fields
```

As of the port, every field matches. The geometry (2,804 maps, 1,233 conditional
files, the 77-key tile legend) reproduces with zero semantic differences.

The one field that used not to match was `drops[].measured`, the Penguin Statistics
per-run rate, which drifted on 16 stages because Penguin had recorded more runs since
the oracle was built. That field is gone: it was the only non-gamedata input and the
only one that changed without the game changing, so it made the daily refresh open a
pull request most days for numbers nobody read.

## What each module owns

| module | what it answers |
| --- | --- |
| `gamedata.mjs` | where the EN tables and level files are, the CN level fallback (`levelFile`), and the strict `levelKey` join |
| `text.mjs` | the record markup stripper, and `list()` for fields that are sometimes `{}` |
| `names.mjs` | `slug`, `stageSlug`, variant kinds, and the `SlugSet` that breaks code collisions |
| `records.mjs` | identity: code, name, variant, zone, order, costs |
| `story.mjs` | the Act above the Episode, and which event a zone belongs to |
| `contents.mjs` | the 165 content entries and which one each stage is filed under |
| `dates.mjs` | Global release date per content entry, one rule per kind |
| `drops.mjs` | declared rewards, whether they repeat, and the game's rarity wording |
| `level.mjs` | the fight: battle parameters, enemy tallies, the fragment clock |
| `geometry.mjs` | the map: grid, routes, waves, enemy configurations |
| `encode.mjs` | re-encoding geometry to the shape the pages read, losslessly |
| `keyorder.mjs` | published key order, so two runs produce the same bytes |
| `preview.mjs` | which committed render belongs to which stage |
| `synthetic.mjs` | the 815 stages that exist only as a level file |

## Level files from two mirrors

The EN mirror drops a level file once Global has no way to play the stage: 300 of
them in 2026-09, among them every stage of Trials for Navigator #1-#4, Children of
Ursus and Vigilo. The CN mirror still carries them, and the release already pins one
CN source (`scripts/content/cn-tables.mjs`, composed under
`.cache/upstream/cn-resource/gamedata`), so `levelFile()` falls back to it: EN wins
wherever both have the file, the lookup is case-insensitive, and a map read from CN is
written with `source: "cn"` (only then, so every EN map keeps its bytes). The stage page
says so under the map. A CN level names its stage-local enemies in Chinese; those names
are replaced with the EN handbook name of the enemy each one varies, or dropped.

Only a stage the EN tables already name reads a CN level. `levelIds()` lists the EN
folder alone, because a level file there becomes a stage record even without a
stage_table row (`synthetic.mjs`), and CN-only stages never arrive by design.

Rehearsed on the 2026-09-25 pins: 186 more maps, 321 stage records gaining a map, and
mapless contents down from 15 to 1 (Operational Intelligence, which no mirror carries).
Once a release carries them, losing them is a 6% drop in `stageMaps`, which the
completeness gate refuses (`scripts/content/check-completeness.mjs`, 2% at most).

## Four traps, all of them load-bearing

**The markup stripper has to stay narrow.** 24 stage names really are
angle-bracketed — `<Collected Anecdotes>` — so a blanket `<[^>]*>` empties them.
There are four different strippers upstream and they are not interchangeable; each
module carries the one that belongs to its output.

**Gamedata's list-shaped fields are sometimes an empty dict.** 426 stage rows carry
`unlockCondition: {}`. That is falsy in the Python this replaces and truthy in JS,
so every such field goes through `list()`.

**Python sorts strings by code point.** `'Zealot'` precedes `'archer'`.
`localeCompare` would silently reorder every mixed-case tie in every enemy list.

**Row 0 is the bottom row.** Upstream stores the tile grid top row first and route
positions bottom row first. Getting the flip wrong mirrors every map vertically and
still looks like a map.

## What is deliberately not reproduced

Two content entries upstream carries — `event/act17d1` and `event/act42d0` — are
minted by its ENEMY collectors from mode tables that name enemies without any
stage or level file. No stage references either, so a stages pipeline has nothing
to file under them.

Python writes `0.0` where `JSON.stringify` writes `0`. Float-ness is a property of
the source literal and is lost at `JSON.parse`, so the committed files differ from
a fresh build in that spelling alone. The first refresh normalises them.

New renders for a new event still need the upstream image repos: this pipeline
decides which stage points at which render, and resolves it against
`public/stages-images/` in this repo, but it does not fetch new artwork.

## Coverage and publication guarantees

The build refuses to swap output if any Global stage-table ID is missing or any
ID/slug is duplicated. The `stage-coverage` invariant runs after index enrichment:
every retained record must be indexed, only declared content/type exclusions may
be absent, every geometry reference must exist, and the source checkout must match
the run pin. Its deterministic `data/stage-coverage.json` records the source commit,
table hash and counts. A failed or rolled-back dataset/index step fails this invariant
and the release, so yesterday's stages cannot count as a fresh import.

Episodes 9 onward take dates from their Global story-review rows without an episode
allowlist. Episodes 0–8 retain the documented corrections; missing dates remain null.
CN maps only restore Global-known stages; CN schedules are never Global release dates.

After publication and the existing cache wait, `check-served-stages.mjs` checks each
live deployment of the current channel: `/stages/browse` must name the compiled release,
its immutable stage index must match the manifest byte count/hash, and the newest dated
Global story/event content pages must serve that release and source date. Bounded
retries accommodate ISR. Stale pages, bundled fallback, 404s and corrupt indices fail
the workflow explicitly. This check does not redeploy or trigger another refresh.
