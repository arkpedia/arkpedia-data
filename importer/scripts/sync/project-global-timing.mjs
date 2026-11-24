import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Apply notice-corrected EN timing while retaining CN-only forecast windows. */
export function globalTimingProjections(contentWindows, eventFarming, schedule) {
  return {
    contentWindows: { ...contentWindows, ...schedule.contents },
    eventFarming: { ...eventFarming, drops: schedule.farming },
  };
}

export function projectGlobalTiming(root) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (read('.cache/import-global-timing-ready.json') !== true) {
    throw new Error('No fresh EN reconciliation: retain published Global timing');
  }
  const projected = globalTimingProjections(
    read('.cache/import-content-windows.json'),
    read('.cache/import-event-farming.json'),
    read('data/regional-schedules.json').servers.en,
  );
  // The stage runner rolls both files back if either write fails.
  fs.writeFileSync(path.join(root, 'data/content-windows.json'), JSON.stringify(projected.contentWindows));
  fs.writeFileSync(path.join(root, 'data/event-farming.json'), `${JSON.stringify(projected.eventFarming, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  projectGlobalTiming(process.cwd());
}
