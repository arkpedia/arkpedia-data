export function getClassIconPath(className: string | null | undefined): string | null {
  if (!className) return null;
  return `/class-icons/${className}.webp`;
}

export function getBranchIconPath(branchName: string | null | undefined): string | null {
  if (!branchName) return null;
  return `/branch-icons/${branchName}.webp`;
}

// Operator records and the original emblem filenames use different display names.
// Keep these aliases at the asset boundary; faction membership stays unchanged.
const FACTION_ICON_FILES: Record<string, string> = {
  Aegir: 'Ægir.webp',
  Blacksteel: 'Blacksteel Worldwide.webp',
  'Elite Op': 'Rhodes Island-Elite Operator.webp',
  Lungmen: 'Yan-Lungmen.webp',
  'Op A4': 'Op Team A4.webp',
  'Op Reserve A1': 'Reserve Op Team A1.webp',
  'Op Reserve A4': 'Reserve Op Team A4.webp',
  'Op Reserve A6': 'Reserve Op Team A6.webp',
  'Pinus Sylvestris': 'Pinus Sylvestris Knightclub.webp',
  "Chiave's Gang": "Chiave's Gang.webp",
  // The game uses the Rhodes Island emblem for these two collaboration teams.
  "Laios's Party": 'Rhodes Island.webp',
  'Ave Mujica': 'Rhodes Island.webp',
  'S.E.E.S': 'Rhodes Island.webp',
};

export function getFactionIconPath(factionName: string | null | undefined): string | null {
  if (!factionName) return null;
  return `/faction-icons/${FACTION_ICON_FILES[factionName] ?? `${factionName}.webp`}`;
}
