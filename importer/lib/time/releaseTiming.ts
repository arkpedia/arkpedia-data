export type ReleaseTiming = 'confirmed' | 'datamined' | 'cn-estimate' | 'estimated' | 'global-fallback';

export interface TimingEvidence {
  startAt?: string | null;
  timingSource?: string | null;
  status?: string;
}

const CLIENT_DATA = /^https:\/\/raw\.githubusercontent\.com\/ArknightsAssets\/ArknightsGamedata\/[^/]+\/(?:en|jp|kr)\/gamedata\//i;

export function sourcedTiming({ status, timingSource }: TimingEvidence): 'confirmed' | 'datamined' {
  return status !== 'announced' && (status === 'datamined' || CLIENT_DATA.test(timingSource ?? '')) ? 'datamined' : 'confirmed';
}

export function eventReleaseTiming(window: TimingEvidence & { note?: string | null; releaseTiming?: ReleaseTiming }, hasCnDate: boolean, predicted = false): ReleaseTiming {
  if (window.releaseTiming === 'global-fallback') return window.releaseTiming;
  if (window.startAt && (window.timingSource || window.status) && !/withdrawn/i.test(window.note ?? '')) return sourcedTiming(window);
  if (window.releaseTiming) return window.releaseTiming;
  if (predicted || /estimat|predict|unannounced|withdrawn/i.test(window.note ?? '')) return hasCnDate ? 'cn-estimate' : 'estimated';
  return 'confirmed';
}

export function timingQualifier(timing: ReleaseTiming): string | null {
  switch (timing) {
    case 'datamined': return 'Datamined';
    case 'cn-estimate': return 'CN-based estimate';
    case 'estimated': return 'Estimated';
    case 'global-fallback': return 'Global dates';
    case 'confirmed': return null;
  }
}

export function isReleaseEstimate(timing: ReleaseTiming): boolean {
  return timing === 'cn-estimate' || timing === 'estimated' || timing === 'global-fallback';
}

/** The Global schedule can contain a client window older than a published correction. */
export function preferRegionalWindow(global: TimingEvidence, regional: TimingEvidence, server: string): boolean {
  return server !== 'en' || !global.startAt || !global.timingSource || sourcedTiming(global) === 'datamined'
    || sourcedTiming(regional) === 'confirmed';
}
