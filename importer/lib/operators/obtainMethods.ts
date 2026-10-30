import type { LimitedBannerType } from '@/lib/gacha/limitedBannerType';
import { getWelfareInfo } from './operatorTypes';

/**
 * How an operator is obtained, as the Operators page's Obtain filter asks it.
 *
 * Read from the record's howToObtain flags, one answer for every page that needs it (the
 * Obtain Method page used to hold these rules alone). The roster page carries this small
 * summary per operator, not the record: it nulls howToObtain on purpose, to keep its payload
 * to what its cards read.
 *
 *  - limited: a Limited banner operator, in any of its four sub-types.
 *  - standard, kernel: the 6★ pools. (Lower rarities are on the standard flag too, but the
 *    list has only ever meant the 6★ ones.)
 *  - recruitment: can be got by Recruitment at all, whatever else also gives them.
 *  - recruitment-only: Recruitment and neither of those pools, the "Pure Recruitment" list.
 *  - welfare: given away (record restore, a mode's reward, a shop), whatever its type.
 */
export type ObtainMethod = 'limited' | 'standard' | 'kernel' | 'recruitment' | 'recruitment-only' | 'welfare';

export const OBTAIN_METHODS: readonly { key: ObtainMethod; label: string }[] = [
  { key: 'limited', label: 'Limited headhunting' },
  { key: 'standard', label: 'Standard headhunting' },
  { key: 'kernel', label: 'Kernel headhunting' },
  { key: 'recruitment', label: 'Recruitment' },
  { key: 'recruitment-only', label: 'Recruitment only' },
  { key: 'welfare', label: 'Welfare' },
];

export const LIMITED_SUBTYPES: readonly LimitedBannerType[] = ['Celebration', 'Festival', 'Carnival', 'Crossover'];

// Display label -> the real Unlock Type value(s) it matches in the data. Several of these
// combine real values under one label (IS/RA/Main Story, April Fools/Anniversary), and two
// use a different label than the data value (Credit Shop -> "Credit Store", Purchase
// Certificates -> "Purchase Vouchers") to match how the data is written.
//
// NOTE: 'RA Exclusive' is a guess, following the pattern of the confirmed 'IS Exclusive'
// value; no RA operator has an Unlock Type in the data yet, so if the real value is spelled
// differently this needs updating to match.
export const WELFARE_SUBTYPES: readonly { label: string; matches: readonly string[] }[] = [
  { label: 'Record Restore', matches: ['Record Restore'] },
  { label: 'IS, RA, Main Story', matches: ['IS Exclusive', 'RA Exclusive', 'Main Story Unlock'] },
  { label: 'Credit Shop', matches: ['Credit Store'] },
  { label: 'Purchase Certificates', matches: ['Purchase Vouchers'] },
  { label: 'Gold/Blue Certs', matches: ['Gold/Blue Certs'] },
  { label: 'April Fools / Anniversary', matches: ['April Fools', 'Anniversary'] },
  { label: 'Limited', matches: ['Limited Welfare'] },
];

type HowToObtain = string | Record<string, unknown> | null | undefined;

/** Which of the methods this operator is obtained by; none for a record with no obtain data. */
export function obtainMethodsOf(howToObtain: HowToObtain, rarity: number | null): ObtainMethod[] {
  const raw = howToObtain;
  if (!raw || typeof raw !== 'object') return [];
  const methods: ObtainMethod[] = [];
  if (raw['Limited'] === 'Yes') methods.push('limited');
  if (raw['Standard Headhunting'] === 'Yes' && rarity === 6) methods.push('standard');
  if (raw['Kernel Headhunting'] === 'Yes' && rarity === 6) methods.push('kernel');
  if (raw['Recruitment'] === 'Yes') methods.push('recruitment');
  if (raw['Recruitment'] === 'Yes' && raw['Standard Headhunting'] !== 'Yes' && raw['Kernel Headhunting'] !== 'Yes') methods.push('recruitment-only');
  if (getWelfareInfo(howToObtain)) methods.push('welfare');
  return methods;
}

/** An operator's welfare source: its filter label and the line shown under its card. */
export interface WelfareSource { type: string; note: string }

// Event-driven methods: the event name (location) is the useful, specific detail -- the type
// is already obvious from context. Shop and purchase methods have no single event tied to
// them, so the type itself is the useful detail.
const LOCATION_ONLY = ['Record Restore', 'IS Exclusive', 'RA Exclusive', 'Main Story Unlock', 'Limited Welfare'];

export function welfareSourceOf(howToObtain: HowToObtain): WelfareSource | null {
  const info = getWelfareInfo(howToObtain);
  if (!info) return null;
  const type = info['Unlock Type'];
  return { type, note: LOCATION_ONLY.includes(type) ? info['Unlock Location'] : type };
}

/** Whether a welfare source type belongs to the sub-filter labelled `label`. */
export function welfareMatches(source: WelfareSource | undefined, label: string): boolean {
  const subtype = WELFARE_SUBTYPES.find((s) => s.label === label);
  return !!source && (!subtype || subtype.matches.includes(source.type));
}

/** The value of the Obtain filter in the address, narrowed to a known one ('' = every operator). */
export function obtainFilter(raw: string): ObtainMethod | '' {
  return OBTAIN_METHODS.some((m) => m.key === raw) ? raw as ObtainMethod : '';
}
