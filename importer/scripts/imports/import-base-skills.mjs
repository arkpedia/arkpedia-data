import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripRichText } from '../lib/gametext.mjs';
import { BASE_ROOMS as ROOMS, facilityLabel } from '../lib/base-rooms.mjs';
const clean = name => String(name ?? '').split('Replaces')[0].trim();
const norm = name => clean(name).replace(/[·’“”"']/g, '').replace(/\s+/g, '').toLowerCase();
const rank = skill => skill.phase ?? Math.max(0, ['Base', 'Elite 1', 'Elite 2'].indexOf(skill.eliteLevel));

/* `<$cc.tra.closure><@cc.kw>Closure's Special Order</></>`: a keyword the game underlines and
   explains on a tap, its term id, then the words, which may carry a colour tag of their own. */
const TERM_SPAN = /<\$([\w.]+)>((?:<@[^>]*>)?[^<]*(?:<\/>)?)<\/>/g;

/**
 * The keywords a base skill's description links to the game's glossary, each with the game's own
 * explanation (gamedata_const termDescriptionDict, EN): Closure's Special Order, Worldly Plight,
 * a faction's members. The page underlines `text` in the description and shows `definition` on
 * hover, focus or tap. A Global skill's keywords are the words the game tags. A CN-only skill's
 * description is a reviewed English translation, so its CN tags count where the term's English
 * name appears in that text. Then any other Base term (a `cc.` term of two words or more, such
 * as Rhine Lab) the text names without the game's tag: four skills name Rhine Lab untagged.
 * One-word names (Passion) are left to the game's tags, as ordinary words. One per term.
 */
export function baseSkillKeywords(rawDescription, description, terms) {
  const seen = new Set();
  const keywords = [];
  for (const [, term, inner] of String(rawDescription ?? '').matchAll(TERM_SPAN)) {
    const entry = terms[term];
    if (!entry || seen.has(term)) continue;
    const tagged = stripRichText(inner);
    const name = stripRichText(entry.termName);
    const text = description.includes(tagged) && /[A-Za-z]/.test(tagged) ? tagged : description.includes(name) ? name : null;
    if (!text) continue;
    seen.add(term);
    keywords.push({ text, term, name, definition: stripRichText(entry.description) });
  }
  for (const [term, entry] of Object.entries(terms)) {
    const name = stripRichText(entry?.termName);
    if (!term.startsWith('cc.') || seen.has(term) || !/\S\s+\S/.test(name) || !description.includes(name)) continue;
    if (keywords.some(keyword => keyword.text.includes(name) || name.includes(keyword.text))) continue;
    seen.add(term);
    keywords.push({ text: name, term, name, definition: stripRichText(entry.description) });
  }
  return keywords;
}

/** Rebuild only base skills. Names/icons stay compatible with the site's assets and handlers.
 * EN supplies descriptions; CN-only translations retain their text, but use CN slot chains.
 * A missing/ambiguous join fails before ANY operator file is written. */
export function reconcileBaseSkills(operator, building, region, translations, terms) {
  if (!terms || typeof terms !== 'object') throw new Error(`${operator.name}: no glossary (gamedata_const termDescriptionDict) for the base skill keywords`);
  const character = building.chars?.[operator.internalName];
  if (!character) throw new Error(`${operator.name}: no building_data character ${operator.internalName}`);
  const old = operator.baseSkills ?? [];
  const used = new Set();
  const skills = [];
  for (const [slot, chain] of (character.buffChar ?? []).entries()) {
    for (const entry of Array.isArray(chain.buffData) ? chain.buffData : []) {
      const buff = building.buffs[entry.buffId];
      if (!buff) throw new Error(`${operator.name}: unknown buff ${entry.buffId}`);
      // A new facility must be named in scripts/lib/base-rooms.mjs before its skills import.
      if (!ROOMS[buff.roomType]) throw new Error(`${operator.name}: ${entry.buffId} is in facility ${buff.roomType}, which scripts/lib/base-rooms.mjs does not name`);
      const phase = Number(entry.cond.phase.replace('PHASE_', ''));
      const exact = old.map((skill, index) => ({ skill, index })).filter(({ skill, index }) => !used.has(index) && skill.buffId === entry.buffId && skill.slot === slot && skill.phase === phase);
      let candidates = old.map((skill, index) => ({ skill, index })).filter(({ skill, index }) => !used.has(index) && facilityLabel(skill.facility) === ROOMS[buff.roomType] && norm(skill.name) === norm(buff.buffName));
      if (candidates.length > 1) candidates = candidates.filter(({ skill }) => rank(skill) === phase);
      if (!candidates.length && region === 'CN') {
        candidates = old.map((skill, index) => ({ skill, index })).filter(({ skill, index }) => !used.has(index) && facilityLabel(skill.facility) === ROOMS[buff.roomType] && rank(skill) === phase);
      }
      if (exact.length) candidates = exact;
      if (candidates.length > 1) candidates = candidates.filter(({ skill }) => skill.slot === slot && skill.phase === phase);
      if (candidates.length > 1) throw new Error(`${operator.name}: ambiguous translation join for ${entry.buffId}`);
      // CN text needs an existing translation. Ordering is valid only for repeated
      // same-facility/same-promotion steps within the record's source slot order.
      // A reviewed translation (data/base-skill-translations.json) is the CN skill's English: it
      // wins over the record's text, which the catalogue first writes in Chinese for a new CN
      // operator (Homebound, 2026-10-13). Global skills keep the game's English.
      const reviewed = region === 'CN' ? translations[entry.buffId] : undefined;
      const prior = reviewed ? { ...candidates[0], skill: { ...(candidates[0]?.skill ?? { icon: null }), ...reviewed } }
        : candidates[0] ?? (translations[entry.buffId] ? { skill: { ...translations[entry.buffId], icon: null } } : undefined);
      if (!prior && region === 'CN') throw new Error(`${operator.name}: untranslated ${entry.buffId}`);
      if (prior?.index !== undefined) used.add(prior.index);
      const level = entry.cond.level;
      const description = region === 'Global' ? stripRichText(buff.description) : prior.skill.description;
      const keywords = baseSkillKeywords(buff.description, description, terms);
      const { keywords: _stale, ...kept } = prior?.skill ?? { icon: null };
      skills.push({
        ...kept,
        name: prior ? prior.skill.name : buff.buffName.replace(/·/g, ' '),
        facility: ROOMS[buff.roomType],
        eliteLevel: phase === 0 && level > 1 ? `Level ${level}` : ['Base', 'Elite 1', 'Elite 2'][phase],
        description,
        ...(keywords.length ? { keywords } : {}),
        buffId: entry.buffId, slot, phase, level,
      });
    }
  }
  if (used.size !== old.length) throw new Error(`${operator.name}: ${old.length - used.size} existing base skills have no source match`);
  return skills;
}

/** A Base schema or translation gap belongs to that operator, not the event/banner catalogue. */
export function reconcileCatalogueBaseSkills(operators, previous, cn, en, translations) {
  const saved = new Map(previous.map(op => [op.internalName, op]));
  const problems = [];
  for (const op of operators) {
    if (/^Amiya \(/.test(op.name)) continue;
    const region = en.building.chars[op.internalName] ? 'Global' : 'CN';
    try {
      op.baseSkills = reconcileBaseSkills(op, region === 'Global' ? en.building : cn.building, region, translations, en.constants.termDescriptionDict);
    } catch (error) {
      const prior = saved.get(op.internalName);
      op.baseSkills = structuredClone(prior?.baseSkills ?? []);
      console.warn(`Catalogue Base skills: ${error.message}`);
      problems.push({ key: `operator-base:${op.internalName}`, reason: `${op.name}: Base skills require source or translation reconciliation`, action: prior ? 'kept-previous' : 'published-partial', sourceRef: `${region === 'Global' ? en.source : cn.source}/building_data.json` });
    }
  }
  return problems;
}

export function importBaseSkills({ root, en, cn, terms, write = false }) {
  const report = { operators: 0, skills: 0, global: 0, cn: 0, changed: [], descriptionChanges: [], problems: [] };
  const writes = [];
  const translationFile = path.join(root, 'data/base-skill-translations.json');
  const translations = fs.existsSync(translationFile) ? JSON.parse(fs.readFileSync(translationFile, 'utf8')) : {};
  for (const folder of fs.readdirSync(path.join(root, 'data')).filter(name => /^operators-.*star$/.test(name))) {
    for (const file of fs.readdirSync(path.join(root, 'data', folder)).filter(name => name.endsWith('.json'))) {
      const target = path.join(root, 'data', folder, file);
      const op = JSON.parse(fs.readFileSync(target, 'utf8'));
      // Combat-only Amiya forms deliberately carry no base skills; the original
      // operator owns those skills and must not be counted three times.
      if (/^Amiya \(/.test(op.name)) continue;
      report.operators++;
      const region = en.chars[op.internalName] ? 'Global' : 'CN';
      try {
        const skills = reconcileBaseSkills(op, region === 'Global' ? en : cn, region, translations, terms);
        report[region === 'Global' ? 'global' : 'cn']++;
        report.skills += skills.length;
        for (const skill of skills) {
          const previous = (op.baseSkills ?? []).find(s => norm(s.name) === norm(skill.name) && rank(s) === skill.phase);
          if (previous?.description?.replace(/\s+/g, '') !== skill.description?.replace(/\s+/g, '')) report.descriptionChanges.push(`${op.name}|${skill.name}`);
        }
        if (JSON.stringify(skills) !== JSON.stringify(op.baseSkills)) {
          report.changed.push(op.name);
          writes.push([target, { ...op, baseSkills: skills }]);
        }
      } catch (error) { report.problems.push(error.message); }
    }
  }
  if (write && report.problems.length) throw new Error(`Base skill import refused:\n${report.problems.join('\n')}`);
  if (write) for (const [target, op] of writes) fs.writeFileSync(target, JSON.stringify(op, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [enPath, cnPath, constPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (!enPath || !cnPath || !constPath) throw new Error('Usage: node scripts/imports/import-base-skills.mjs EN/building_data.json CN/building_data.json EN/gamedata_const.json [--write]');
  const terms = JSON.parse(fs.readFileSync(constPath)).termDescriptionDict;
  const report = importBaseSkills({ root: process.cwd(), en: JSON.parse(fs.readFileSync(enPath)), cn: JSON.parse(fs.readFileSync(cnPath)), terms, write: process.argv.includes('--write') });
  fs.mkdirSync('.cache/base-audit', { recursive: true });
  fs.writeFileSync('.cache/base-audit/data-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, changed: report.changed.length, descriptionChanges: report.descriptionChanges.length }, null, 2));
  if (report.problems.length) process.exitCode = 1;
}
