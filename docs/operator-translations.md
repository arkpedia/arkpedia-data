# Unofficial operator translations and combat keywords

`source/data/operator-translations.json` contains CN → English replacements keyed by
immutable character ID and exact original text. Initial coverage is Homebound, Pedro,
de Toledo, Clementia, Mechanist and Jacinta: all remaining Chinese mechanics in their
traits, skills (every rank/mastery), talents (every promotion/potential), potentials,
base skills, modules and tags. Names are provisional. These translations were prepared
with AI assistance by Arkpedia; they are not Hypergryph/Yostar localizations or credited
to another community translator. Existing English fan text keeps its original wording.

The source sentences are retained verbatim beside each replacement. Changed CN text
must receive a new entry after review; the application never applies a replacement to
a different sentence. Official Global traits and skills bypass the overlay; exact CN-only module text can still be translated. The game overview is also included for all CN operators with a Chinese overview. Archive stories, voice actor names and editorial guides remain outside the supplement.
Skill and base-skill artwork retains its original filename when its display name changes.

`source/data/combat-keywords.json` contains English definitions from the game's
`termDescriptionDict` (combat `ba.*` entries). The initial snapshot was retrieved on
2026-11-15 from [ArknightsAssets/ArknightsGamedata](https://github.com/ArknightsAssets/ArknightsGamedata/blob/master/en/gamedata/excel/gamedata_const.json).
The application's combat-keyword generator can regenerate it from a reviewed pinned Global constants file. Elemental terms combine the
enemy-target and ally-target definitions with explicit labels; they must not describe
Nervous Impairment against enemies using the ally-only stun/True damage behavior.
Aliases cover existing inflections such as Stunned; text matching is by whole word.

Both supplements are game records: hydrate them into the application alongside existing
`data/` records and compile a content release with the companion application change.
Older application content snapshots remain readable without the supplements.

The supplement also covers CN-only module names, missions and every upgrade stage on
Blaze the Igniting Spark, Fiammetta, Gavial the Invincible, Kirin R Yato, Narantuya,
Qiubai, Reed the Flame Shadow, Shu, Ulpianus and Vulpisfoglia. Their module disclaimer
is separate from their official English skills and talents. Total initial coverage:
251 exact-source strings across 32 operators, including 21 game overview translations.

The companion application seeds missing supplements from this immutable source commit
with checksum verification. Its server backfills older published operator pages and
preview API payloads, allowing isolated Preview review before a production content release.
Newer compiled content carries the enriched payload and remains authoritative.
