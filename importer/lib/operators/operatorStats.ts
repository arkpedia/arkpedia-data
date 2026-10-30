export const STAT_KEYS = ['hp', 'atk', 'def', 'res', 'redeploy', 'dp', 'block', 'interval'] as const;
export type StatKey = typeof STAT_KEYS[number];
export type StatValues = Record<StatKey, number>;

export interface StatPhase {
  elite: number;
  minLevel: number;
  maxLevel: number;
  base: StatValues;
  max: StatValues;
  rangeId: string;
  /** Supplied per-level values that differ from rounded linear interpolation. */
  overrides?: Record<string, Partial<StatValues> & { rangeId?: string }>;
}

export interface OperatorStats {
  phases: StatPhase[];
  trust: Pick<StatValues, 'hp' | 'atk' | 'def'>;
}

export type ModuleStatBonuses = Partial<StatValues> & { aspd?: number };

const MODULE_STAT_KEYS: Record<string, keyof ModuleStatBonuses> = {
  HP: 'hp', ATK: 'atk', DEF: 'def', RES: 'res', Cost: 'dp', Block: 'block', 'Rdp.': 'redeploy', ASPD: 'aspd',
};

/** Parse the concise stat line supplied by the game data for one module stage. */
export function parseModuleStatBonuses(attributes: string | null | undefined): ModuleStatBonuses {
  const bonuses: ModuleStatBonuses = {};
  for (const part of attributes?.split(',') ?? []) {
    const match = part.trim().match(/^(HP|ATK|DEF|RES|Cost|Block|Rdp\.|ASPD)\s*([+-]\s*\d+(?:\.\d+)?)/i);
    if (!match) continue;
    const sourceKey = Object.keys(MODULE_STAT_KEYS).find(key => key.toLowerCase() === match[1].toLowerCase());
    if (!sourceKey) continue;
    const key = MODULE_STAT_KEYS[sourceKey];
    bonuses[key] = Number(match[2].replace(/\s/g, ''));
  }
  return bonuses;
}

/** Apply direct module attributes to the stat block. ASPD modifies attack interval. */
export function applyModuleStatBonuses(base: StatValues, bonuses: ModuleStatBonuses): StatValues {
  const withDirectBonuses = Object.fromEntries(STAT_KEYS.map(key => [key, base[key] + (bonuses[key] ?? 0)])) as StatValues;
  if (bonuses.aspd) withDirectBonuses.interval = base.interval * 100 / (100 + bonuses.aspd);
  return withDirectBonuses;
}

export interface OperatorFile {
  section: string;
  unlock: string;
  description: string;
}

export function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

export function getBaseStats(phase: StatPhase, requestedLevel: number): StatValues {
  const level = clampInteger(requestedLevel, phase.minLevel, phase.maxLevel);
  const span = phase.maxLevel - phase.minLevel;
  const ratio = span ? (level - phase.minLevel) / span : 0;
  const result = {} as StatValues;
  for (const key of STAT_KEYS) {
    const interpolated = phase.base[key] + (phase.max[key] - phase.base[key]) * ratio;
    const rounded = key === 'interval' || key === 'res' ? interpolated : Math.round(interpolated);
    result[key] = phase.overrides?.[String(level)]?.[key] ?? rounded;
  }
  return result;
}

/** Owned-operator bonuses reach their maximum at 100% displayed trust. */
export function getTrustBonus(stats: OperatorStats, requestedTrust: number): OperatorStats['trust'] {
  // favor_table maps each pair of displayed percentages to one battlePhase.
  // favorKeyFrames reaches its final value at battlePhase 50 (100% trust).
  const phase = Math.floor(clampInteger(requestedTrust, 0, 100) / 2);
  return {
    hp: Math.round(stats.trust.hp * phase / 50),
    atk: Math.round(stats.trust.atk * phase / 50),
    def: Math.round(stats.trust.def * phase / 50),
  };
}
