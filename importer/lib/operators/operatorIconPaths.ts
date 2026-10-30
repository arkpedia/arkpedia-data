import type { BaseSkill } from './operatorTypes';
import { assetFileName } from '@/lib/assets/assetUrl';

/**
 * Skill icon path, built from the operator name + skill name -- the
 * new schema dropped the embedded icon URL entirely, so this is
 * reconstructed from the skill-icons/ folder's naming convention
 * instead of read from the operator's own JSON.
 */
/**
 * Essential icons (M1/M2/M3, Potential 2-6, Elite 0/1/2) -- these
 * replace plain text labels with small icon images. "Base" is a
 * special case since the base-skills eliteLevel field uses that word
 * for what's otherwise labeled "Elite 0" everywhere else.
 */
export function getEssentialIconPath(label: string | null | undefined): string | null {
  if (!label) return null;
  // 1★/2★ operators have no Elite path; their base skills are tagged "Level 30", which
  // is Base's tier -- pages/base.tsx already resolves it that way. Without this, 14
  // operators asked for essential-icons/Level 30.webp, which has never existed.
  const key = label.trim().toLowerCase();
  const normalized = key === 'base' || key === 'level 30' ? 'Elite 0' : label.trim();
  return `/essential-icons/${normalized}.webp`;
}

export function getMaterialIconPath(materialName: string | null | undefined): string | null {
  if (!materialName) return null;
  const safe = assetFileName(materialName);
  return `/material-icons/${safe}.webp`;
}

export function getSkillIconPath(operatorName: string, skillName: string | null | undefined): string | null {
  if (!skillName) return null;
  const safe = assetFileName(skillName);
  return `/skill-icons/${encodeURIComponent(`${operatorName} - ${safe}.webp`)}`;
}

/**
 * The scrape concatenated a base skill's "Replaces <older skill>" label onto its
 * own name with no separator, so 152 of the 880 records carry a name like
 * "SleepinessReplacesLaziness". The suffix is load bearing -- pages/base.tsx reads
 * it back out to work out which slot a skill upgrades (extractReplacedName) -- so it
 * stays in the data and in the icon filenames, and only the displayed text is cleaned.
 */
export function baseSkillDisplayName(skill: Pick<BaseSkill, 'name'>): string {
  return stripReplacesSuffix(skill.name);
}

/** Talents were scraped the same way ("Tactical Configuration 2ReplacesTactical
 * Configuration 1"). The raw name stays in the data -- lookups such as technique
 * groups and umbrella definitions are keyed on it -- and only the heading is cleaned. */
export function talentDisplayName(name: string | null | undefined): string {
  return stripReplacesSuffix(name);
}

function stripReplacesSuffix(name: string | null | undefined): string {
  return (name ?? '').split('Replaces')[0].trim();
}

/**
 * Base skill icon path, same convention, base-skill-icons/ folder.
 * Encode the filename before passing it through Next image optimization: a raw
 * Greek letter in the inner URL otherwise fails its internal image request.
 *
 * Takes the whole skill rather than a name: the filename matches the RAW name, the
 * heading shows the cleaned one, and passing a bare string let the operator page hand
 * over the cleaned name and silently 404. Only this function decides which to use.
 */
export function getBaseSkillIconPath(operatorName: string, skill: Pick<BaseSkill, 'name' | 'rawName'>): string | null {
  const fileName = skill.rawName ?? skill.name;
  if (!fileName) return null;
  const safe = assetFileName(fileName);
  return `/base-skill-icons/${encodeURIComponent(`${operatorName} - ${safe}.webp`)}`;
}