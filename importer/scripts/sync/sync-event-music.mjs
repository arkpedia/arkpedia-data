/** Import explicit event lobby uses, never infer music from an OST title or file prefix.
 * One PRTS request per import. Released MSR ids and known events are required; reviewed
 * associations win. A failed/changed source leaves all previous records in place. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage } from '../lib/quarantine.mjs';
import { eventTitle, isRerun } from '../lib/event-records.mjs';
export const SOURCE = 'https://prts.wiki/w/音乐鉴赏/游戏内音乐一览';
export const STAGE = 'event-music';
const FILE = 'data/event-page-music.json';
const key = value => eventTitle(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// These references name the whole mode, including its named seasons. Older
// calendar records have no activityId. Keep this identity bridge free of song ids:
// the reference still decides the recording and conflicting choices are held.
const MODE_NAMES = new Map([
  ['视相博物馆', ['Poly Vision Museum']], ['争锋频道', ['Duel Channel']],
  ['卫戍协议：盟约', ['Stronghold Protocol Alliance', 'Stronghold Protocol Alliance 2nd Half']],
  ['引航者试炼', ['Trials for Navigator']], ['促融共竞', ['Icebreaker Games']],
  ['次生预案', ['Rebuilding Mandate']], ['罗德岛促融共竞', ['Rhodes Island Icebreaker Games']],
  ['纷争演绎', ['Design of Strife']], ['骑兵与猎人2020', ["Grani and the Knights' Treasure"]],
]);
const modeNameMatches = (name, modes) => modes.some(mode => name === mode || name.startsWith(`${mode}: `) ||
  (name.startsWith(`${mode} #`) && /^\d+$/.test(name.slice(mode.length + 2))));

// Split template arguments only at its own depth (nested exlink2 templates and
// piped wikilinks contain bars too). Reject an unfinished row instead of guessing.
export function musicRows(text) {
  const rows = [];
  for (const match of text.matchAll(/\{\{音乐一览\s*\|/g)) {
    let depth = 1, links = 0, start = match.index + match[0].length, parts = [], i = start;
    for (; i < text.length; i++) {
      const pair = text.slice(i, i + 2);
      if (pair === '{{') { depth++; i++; }
      else if (pair === '}}') {
        if (--depth === 0) { parts.push(text.slice(start, i).trim()); break; }
        i++;
      } else if (pair === '[[') { links++; i++; }
      else if (pair === ']]') { links--; i++; }
      else if (text[i] === '|' && depth === 1 && !links) { parts.push(text.slice(start, i).trim()); start = i + 1; }
    }
    if (depth || links) throw new Error('Incomplete music reference template');
    const fields = {};
    for (const part of parts.slice(1)) { const named = /^(\w+)\s*=([\s\S]*)$/.exec(part); if (named) fields[named[1]] = named[2].trim(); }
    rows.push({ file: parts[0], fields, text: text.slice(match.index, i + 2) });
  }
  return rows;
}

export function reconcileMusic({ text, events, albums, curated, expansion, minimumRows = 100 }) {
  const rows = musicRows(text);
  if (rows.length < minimumRows) throw new Error('Music reference is missing or truncated');
  const next = structuredClone(expansion), holds = [], candidates = new Map();
  const knownSongs = new Set(albums.flatMap(album => album.songs.map(song => String(song.songId))));
  const byEvent = new Map();
  for (const event of events.filter(event => !isRerun(event.name))) {
    const identity = event.activityId ?? key(event.name), prior = byEvent.get(identity);
    byEvent.set(identity, { ...event, aliases: [...new Set([...(prior ? [prior.name, ...(prior.aliases ?? [])] : []), ...(event.aliases ?? [])])] });
  }
  const originals = [...byEvent.values()];
  const namesOf = event => [event.name, ...(event.aliases ?? [])].map(eventTitle);
  const hold = (id, reason) => holds.push({ key: `event:${id}`, reason, action: 'kept-previous', sourceRef: SOURCE });
  for (const row of rows) {
    // Only the event explicitly named as the main interface, not submenus, PVs,
    // battle/story use or an invented title inferred from a sys_ filename.
    const uses = [...(row.fields.oth ?? '').matchAll(/\[\[([^|\]#]+)(?:\|[^\]]*)?\]\]\s*(?:主界面|会场)BGM/g)].map(match => match[1].trim());
    if (uses.length !== 1) continue;
    const activity = /^sys_(act\d+[a-z0-9]+)(?:_entry)?$/.exec(row.file)?.[1];
    const reviewed = [...curated.events, ...expansion.events].filter(entry => entry.names.some(name => key(name) === key(uses[0])));
    const aliases = [uses[0], ...reviewed.flatMap(entry => entry.names)];
    const mode = MODE_NAMES.get(uses[0]);
    const matches = originals.filter(event => namesOf(event).some(name => aliases.some(alias => key(name) === key(alias)) || (mode && modeNameMatches(name, mode))) || (activity && event.activityId === activity));
    const sharedMode = mode && matches.every(event => namesOf(event).some(name => modeNameMatches(name, mode)));
    if (!matches.length || (matches.length !== 1 && !sharedMode)) { if (activity && !reviewed.some(entry => entry.tracks.some(track => track.role === 'lobby'))) hold(activity, 'The lobby reference does not identify one known event; its previous music is kept.'); continue; }
    const ids = [...new Set([...row.text.matchAll(/https:\/\/monster-siren\.hypergryph\.com\/music\/(\d+)(?!\d)/g)].map(match => match[1]))];
    // A reviewed missing-link repair is bounded to this exact reference/title.
    // A later upstream link always takes precedence and gets normal conflict checks.
    if (!ids.length) {
      const repair = (next.referenceRecordings ?? []).find(review => review.file === row.file && review.title === row.fields.title && knownSongs.has(review.id));
      if (repair) ids.push(repair.id);
    }
    const targets = sharedMode ? [{ ...matches[0], activityId: activity ?? matches[0].activityId,
      aliases: [...new Set(matches.flatMap(namesOf))] }] : matches;
    for (const event of targets) {
      const id = event.activityId ?? key(event.name);
      // A manually verified video covers this exact otherwise unreleased lobby.
      // If the reference later supplies an MSR id, import it normally ahead of the
      // video fallback. A changed title or usage must be reviewed again.
      const video = (next.recordings ?? []).find(recording => recording.reference?.file === row.file &&
        recording.reference.title === row.fields.title && recording.names.some(name => key(name) === key(uses[0])) &&
        /^[\w-]{11}$/.test(recording.videoId) && recording.source === `https://www.youtube.com/watch?v=${recording.videoId}`);
      if (!ids.length && video) continue;
      if (ids.length !== 1 || !knownSongs.has(ids[0])) { hold(id, 'The lobby reference has no single released catalogue recording yet; its previous music is kept.'); continue; }
      const value = { event, cid: ids[0], referenceName: uses[0], file: row.file, title: row.fields.title };
      candidates.set(id, [...(candidates.get(id) ?? []), value]);
    }
  }
  for (const [id, matches] of candidates) {
    const namesForMatches = new Set(matches.flatMap(match => namesOf(match.event).map(key)));
    const overlaps = [...candidates].some(([otherId, other]) => otherId !== id && other.some(candidate =>
      namesOf(candidate.event).some(name => namesForMatches.has(key(name))) && matches.some(match => match.cid !== candidate.cid)));
    if (overlaps) { hold(id, 'Mode-wide and event-specific lobby references disagree; review is needed.'); continue; }
    const { event, cid, referenceName, file, title } = matches[0];
    const names = [...new Set([...namesOf(event), referenceName])];
    const existing = [...curated.events, ...next.events].filter(entry => entry.activityId === id || entry.names.some(name => names.some(alias => key(alias) === key(name))));
    const lobbies = existing.flatMap(entry => entry.tracks.filter(track => track.role === 'lobby'));
    const candidateIds = [...new Set(matches.map(match => match.cid))];
    if (candidateIds.length !== 1) {
      // Several legitimate lobby variants already reviewed are not a conflict.
      if (!candidateIds.every(value => lobbies.some(track => track.id === value))) hold(id, 'The reference names several lobby recordings for this event; review is needed.');
      continue;
    }
    if (lobbies.length) {
      const accepted = lobbies.some(track => track.id === cid);
      const reviewedConflict = (next.referenceReviews ?? []).some(review => review.file === file &&
        review.title === title && review.sourceId === cid && lobbies.some(track => track.id === review.keepId));
      if (!accepted && !reviewedConflict) hold(id, 'The reference conflicts with an existing lobby choice; the existing choice is kept for review.');
      // Keep old names as aliases when Global supplies the official translation.
      const automatic = next.events.find(entry => entry.activityId === id && entry.importedBy === STAGE);
      if (automatic && accepted) automatic.names = [...new Set([...automatic.names, ...names])];
      continue;
    }
    next.events.push({ names, characters: [], activityId: id, importedBy: STAGE, source: `${SOURCE}#${file}`, tracks: [{ id: cid, role: 'lobby' }] });
  }
  return { next, holds, rows: rows.length };
}

export async function sync({ root = process.cwd(), text, dryRun = false } = {}) {
  if (text === undefined) {
    const url = `https://prts.wiki/api.php?action=parse&page=${encodeURIComponent('音乐鉴赏/游戏内音乐一览')}&prop=wikitext&format=json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'ArkpediaMusicReference/1.0 (https://github.com/arkpedia/arkpedia-data)' } });
    if (!response.ok) throw new Error(`Music reference HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 3_000_000) throw new Error('Music reference too large'); chunks.push(chunk); }
    text = JSON.parse(Buffer.concat(chunks).toString()).parse?.wikitext?.['*'];
    if (typeof text !== 'string') throw new Error('Music reference has no wikitext');
  }
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const expansion = fs.existsSync(path.join(root, FILE)) ? read(FILE) : { version: 1, events: [] };
  const result = reconcileMusic({ text, expansion, curated: { events: [...read('data/music-guesser-event-music.json').events, ...read('data/music-guesser-event-expansion.json').events] }, albums: read('data/albums.json'),
    events: fs.readdirSync(path.join(root, 'data/events')).filter(file => /^events_\d{4}\.json$/.test(file)).flatMap(file => read(`data/events/${file}`)) });
  if (!dryRun) {
    if (JSON.stringify(expansion) !== JSON.stringify(result.next)) fs.writeFileSync(path.join(root, FILE), JSON.stringify(result.next, null, 2) + '\n');
    const report = beginStage(root, STAGE); result.holds.forEach(entry => report.add(entry)); report.commit();
  }
  console.log(`Event music: ${result.rows} reference rows; ${result.next.events.length - expansion.events.length} new lobby links; ${result.holds.length} held for review${dryRun ? ' (dry run)' : ''}.`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sync({ dryRun: process.argv.includes('--dry-run') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
