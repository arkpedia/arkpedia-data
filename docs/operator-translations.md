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

## Shared Base terminology

`source/data/base-skill-glossary.json` records four shared terms and the eleven game buffs that reference them. IDs come from the pinned CN building/constants tables; names and definitions prefer Global English when that term exists. CN-only group member names come from the canonical operator rosters. The record includes immutable source links. Monster Hunter Squad normalizes to the official Monster Hunter Party (`cc.tag.mh`); the Bubble Kingdom Hunting Squad (`cc.tag.mh2`) remains separate. The CN place name 泡影国 consistently uses Bubble Kingdom in the English supplement. Source descriptions and numeric effects are preserved.

Voice transcript audit (2026-11-15): the current Global and supplemental English charword tables contain no rows for the 23 CN-only operators with Chinese transcripts. Community dialogue pages checked for those operators contain Chinese text (four pages were absent); isolated untranslated battle exclamations are not treated as English translations. Retain the explicit Chinese game text label; no voice transcript translation is claimed.

## Completed mechanics audit — 2026-11-16

Added 332 exact-source replacements for all remaining displayed Chinese mechanics:
Herdbells, Olga, Caleido, Talulah, Territoriya and Toska, plus missing CN-only modules
on Matsukiri, Astgenne the Lightchaser, Horn, Muelsyse and SilverAsh the Reignfrost.
Coverage includes every skill rank/mastery and talent promotion/potential row.
The supplement now has 583 strings across 37 operators. Original game records remain
unchanged; official Global mechanics are excluded from the overlay.

Each new string has an optional `credits` override containing `name` and an optional citation `sourceRef`. Independent labels, Base skills,
traits and potentials retain Arkpedia's AI-assisted credit. Wiki-derived mechanics
credit Arkpedia's AI-assisted adaptations and Arknights Terra Wiki under CC BY-SA 4.0,
with revision-pinned source links. Existing overview credits stay independent.
These adaptations are also available under CC BY-SA 4.0; retained exact CN keys are
the game-text revision guard, not a claim of official localization.

The game text takes precedence where wiki prose or numbers differ: Caleido converts
30% of incoming Physical/Arts damage into **half** that amount of Frenzy; Toska's
second talent follows **applying** a Trigger effect; her third skill deals Physical
damage and transfers to another Operator. Territoriya's retirement talent hits ground
enemies, third-skill rank values come from each game row, and her module mission uses
WD-8. Talulah's second talent requires her to be deployed and leaves Footsteps on
passable ground. Her third skill consistently calls its projectiles Flame Clusters.
Muelsyse's final module copies **all** listed attributes; SilverAsh's final module
reduces the cap on the DP cost increase after retreat, not the first redeployment cost.
These are deliberately corrected adaptations rather than unchecked wiki copies.

Reviewed wiki revisions:

- [Herdbells](https://arknights.wiki.gg/w/index.php?title=Herdbells&oldid=775072)
- [Matsukiri](https://arknights.wiki.gg/w/index.php?title=Matsukiri&oldid=775407)
- [Olga](https://arknights.wiki.gg/w/index.php?title=Olga&oldid=775114)
- [Caleido](https://arknights.wiki.gg/w/index.php?title=Caleido&oldid=775115)
- [Astgenne the Lightchaser](https://arknights.wiki.gg/w/index.php?title=Astgenne_the_Lightchaser&oldid=775122)
- [Horn](https://arknights.wiki.gg/w/index.php?title=Horn&oldid=775305)
- [Muelsyse](https://arknights.wiki.gg/w/index.php?title=Muelsyse&oldid=775390)
- [SilverAsh the Reignfrost](https://arknights.wiki.gg/w/index.php?title=SilverAsh_the_Reignfrost&oldid=780748)
- [Talulah](https://arknights.wiki.gg/w/index.php?title=Talulah&oldid=780685)
- [Territoriya](https://arknights.wiki.gg/w/index.php?title=Territoriya&oldid=775113)
- [Toska](https://arknights.wiki.gg/w/index.php?title=Toska&oldid=775568)

Wiki adaptations are licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The revision links identify the source and its contributor history; the qualifications and number corrections above describe the changes.
