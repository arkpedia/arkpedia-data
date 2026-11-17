import type { TableRewardGroup } from './tableRewards';

/** Global announces its own sale catalogue. Never retain CN-only offers alongside it. */
export function preferredPackGroups(groups: TableRewardGroup[]): TableRewardGroup[] {
  const global = groups.some(group => group.kind === 'packs' && group.region !== 'CN' && !group.region?.includes('preview') && group.packs?.length);
  return global ? groups.filter(group => group.kind !== 'packs' || group.region !== 'CN') : groups;
}
