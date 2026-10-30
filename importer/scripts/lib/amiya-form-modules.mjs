/**
 * The modules build-amiya-forms.mjs writes onto a form's record.
 *
 * That script lists a form's modules by name with no stages (it does not write effect text
 * the game did not write). The English refresh does build them: operator-english runs
 * before it in the same content run, reads the forms from char_patch_table and gives each
 * module its stages and costs from the module tables (officialModules). Writing the bare
 * list over that left AFT-X and INC-X with no stages, so operator-costs had nowhere to put
 * their costs and held both records every night (issue #59, 2026-10-07 to 10-13).
 *
 * So a module the existing record already carries with stages is kept as it is, matched
 * the way officialModules matches: the Original by type, an upgrade by its module code
 * (AFT-X, with α/β/Δ read as A/B/D). Anything else is the bare entry from the gamedata.
 */
const normalizeCode = value => String(value ?? '').replace(/α/gi, 'A').replace(/β/gi, 'B').replace(/δ/gi, 'D')
  .replace(/[^a-z0-9]/gi, '').toLowerCase();
const codeOf = module => normalizeCode(String(module?.name ?? '').split(':')[0]);

export function keepRefreshedModules(derived, existing) {
  const previous = Array.isArray(existing) ? existing : [];
  const used = new Set();
  return derived.map(module => {
    const prior = previous.find(entry => !used.has(entry) && entry?.type === module.type
      && Array.isArray(entry.stages) && entry.stages.length
      && (module.type === 'Original' || codeOf(entry) === codeOf(module)));
    if (!prior) return module;
    used.add(prior);
    return prior;
  });
}
