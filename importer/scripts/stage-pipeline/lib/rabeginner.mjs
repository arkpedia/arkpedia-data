// Reclamation Algorithm ships two cuts of four of its operations.
//
// Four names appear twice in the season's 106 stages -- Headquarters, 'Greeting
// Gallery', 'Treasury' and Crossroads -- and the second of each is the cut the game
// plays while it is still teaching you. They are stageData rows sandbox_1_81 through
// _84, appended after the last ordinary stage rather than sitting in the numbering,
// and their level files carry the game's own training names:
//
//   level_sandbox1_tr_home     against level_sandbox1_27   Headquarters
//   level_sandbox1_06_t        against level_sandbox1_06   'Greeting Gallery'
//   level_sandbox1_07_t        against level_sandbox1_07   'Treasury'
//   level_sandbox1_43_t        against level_sandbox1_43   Crossroads
//
// tr_home is named outright by runeDatas.sandbox_1_tutorial, whose description is
// "Use beginner mode to display tutorials" and whose one rune points at
// Obt/SandboxPerm/sandbox_1/TrainingLevel/level_sandbox1_tr_home.txt. That is where
// the label comes from: the game calls this beginner mode.
//
// They are not duplicates. Each is the SAME map -- the tile grids match exactly --
// with a different fight: one more route and one more enemy in the roster than the
// ordinary cut (a Lost Colossus in 'Greeting Gallery', a Gravestone in 'Treasury', an
// Originium Slug in the otherwise empty Headquarters). So they belong on one card
// with a toggle, the way an Integrated Strategies node's alternates do, rather than
// as two cards reading the same name.
//
// The three Lessons -- Hunting, Gathering and Equipment, level_sandbox1_tr01..tr03 --
// are training levels too, but each has a name of its own and no ordinary twin, so
// they are operations in their own right and this leaves them alone.
import { compareNatural } from './synthetic.mjs';

// An ordinary RA level file is the mode's name and a number. Anything else in the
// same folder is a special cut, which is how tr_home and the three _t files read.
const PLAIN = /^level_[a-z0-9]+_\d+$/;

/**
 * record id -> { of }: the id of the operation this is the beginner cut of.
 *
 * Only pairs, and only where exactly one member is an ordinary numbered level. A name
 * shared by three, or by two special cuts, would mean the game had changed how it
 * files these, and guessing at that is worse than leaving them as separate cards.
 */
export function raBeginnerCuts(records) {
  const mine = records.filter((r) => r.stage_type === 'reclamation');
  if (!mine.length) return new Map();

  const byName = new Map();
  for (const record of mine) {
    const name = String(record.name || '').trim().toLowerCase();
    if (!name) continue;
    const key = `${record.content?.id || ''} ${name}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(record);
  }

  const out = new Map();
  for (const group of byName.values()) {
    if (group.length !== 2) continue;
    const plain = group.filter((r) => PLAIN.test(r.id.split('/').pop() || ''));
    if (plain.length !== 1) continue;
    const base = plain[0];
    const cut = group.find((r) => r !== base);
    out.set(cut.id, { of: base.id });
  }
  // Sorted so the pipeline's log reads in level order rather than hash order.
  return new Map([...out].sort((a, b) => compareNatural(a[0], b[0])));
}
