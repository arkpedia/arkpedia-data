// An album's release date is stored as YYYY/MM/DD. One definition, shared by the album sync
// that writes the dates (scripts/sync/sync-albums.mjs), the completeness check that holds an
// album whose date is anything else (scripts/content/check-completeness.mjs), and the music
// pages that sort by them (lib/music/albumsDataServer.ts). Plain JavaScript so the Node
// pipeline scripts can import it as they are; releaseDate.d.mts types it for the app.
//
// Sorting the stored strings as strings is what put "October 8, 2025" above every 2026
// album in Recently added: only the stored form orders correctly as text, so everything
// that orders albums reads the day through here instead.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The day as a UTC timestamp, or null when the three numbers name no real day. */
function utcDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime() : null;
}

const stored = (year, month, day) => `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;

/** A stored release date's day as a UTC timestamp, or null unless it is a real day written
 * YYYY/MM/DD. Nothing else is accepted: a date in any other form is a record to fix. */
export function parseReleaseDate(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/) : null;
  return match ? utcDay(+match[1], +match[2], +match[3]) : null;
}

/**
 * The stored form of a date as someone typed it, or null when it names no real day. Takes
 * YYYY/MM/DD, YYYY-MM-DD and unpadded months and days, and the prose the catalogue has
 * been written in by hand: "October 8, 2025", "December 5th, 2023", "8 October 2025", and
 * a misspelt month ("Febuary 16, 2024"), which is read by its first three letters.
 */
export function normalizeReleaseDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  let match = text.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (match) return utcDay(+match[1], +match[2], +match[3]) === null ? null : stored(+match[1], +match[2], +match[3]);
  const month = name => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  match = text.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (match && month(match[1])) return utcDay(+match[3], month(match[1]), +match[2]) === null ? null : stored(+match[3], month(match[1]), +match[2]);
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/i);
  if (match && month(match[2])) return utcDay(+match[3], month(match[2]), +match[1]) === null ? null : stored(+match[3], month(match[2]), +match[1]);
  return null;
}

/**
 * The day Monster Siren uploaded an album's cover, in stored form, from the date in its
 * address (https://web.hycdn.cn/siren/pic/YYYYMMDD/...), or null. Monster Siren publishes
 * no release date anywhere in its API. Of the albums released since its covers stopped
 * being uploaded in bulk (April 2021), the catalogue's hand-written date is within a week
 * of this day for 224 of 239, and for 106 of the 108 released since 2024. It only ever
 * fills a blank, never replaces a date someone wrote.
 */
export function coverUploadDate(coverUrl) {
  const match = typeof coverUrl === 'string' ? coverUrl.match(/\/siren\/pic\/(\d{4})(\d{2})(\d{2})\//) : null;
  return match && utcDay(+match[1], +match[2], +match[3]) !== null ? stored(+match[1], +match[2], +match[3]) : null;
}
