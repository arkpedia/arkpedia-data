import { newsSections } from '../build/official-news.mjs';

export const titleText = value => String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

/** Match printed pack titles, not nearby item art. Longest titles claim their
 * ranges first; a one-character OCR error is accepted only when unambiguous. */
export function printedPacks(text, names) {
  let available = titleText(text);
  const ordered = [...new Set(names)].sort((a, b) => titleText(b).length - titleText(a).length);
  const found = new Set();
  for (const name of ordered) {
    const title = titleText(name);
    if (!title) continue;
    const at = available.indexOf(title);
    if (at < 0) continue;
    found.add(name);
    available = available.split(title).join('#'.repeat(title.length));
  }
  const fuzzy = [];
  for (const name of ordered.filter(name => !found.has(name) && titleText(name).length >= 12)) {
    const title = titleText(name);
    const hits = [];
    for (let at = 0; at < available.length; at++) {
      for (const size of [title.length, title.length - 1, title.length + 1]) {
        const part = available.slice(at, at + size);
        if (part.length === size && !part.includes('#') && oneEdit(title, part)) hits.push({ at, end: at + size });
      }
    }
    if (hits.length) fuzzy.push({ name, hits });
  }
  for (const candidate of fuzzy) {
    const ambiguous = fuzzy.some(other => other !== candidate && candidate.hits.some(a => other.hits.some(b => a.at < b.end && b.at < a.end)));
    if (!ambiguous) found.add(candidate.name);
  }
  return names.filter(name => found.has(name));
}

/** Only pictures inside the official pack section can become pack artwork.
 * English titles are checked against the image itself before a mapping is made. */
export function packPromoCandidates(rewards, readPost) {
  const sources = new Map();
  for (const entry of Object.values(rewards.events ?? {})) for (const group of entry.groups ?? []) {
    if (group.kind !== 'packs' || !group.packs?.length || !/^https:\/\/www\.arknights\.global\/news\/\d+$/.test(group.source)) continue;
    const groups = sources.get(group.source) ?? []; groups.push(group); sources.set(group.source, groups);
  }
  const candidates = new Map();
  for (const [source, groups] of sources) {
    const post = readPost(source.split('/').at(-1));
    if (!post || !Array.isArray(post.lines) || !Array.isArray(post.art)) continue;
    const sections = newsSections(post.lines);
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const matching = groups.filter(group => titleText(group.title) === titleText(section.title));
      const names = [...new Set(matching.flatMap(group => group.packs.map(pack => pack.name)))];
      if (!names.length) continue;
      for (const art of post.art) {
        if (art.line < section.at || art.line >= (sections[i + 1]?.at ?? post.lines.length + 1)) continue;
        let url;
        try { url = new URL(art.url); } catch { continue; }
        if (url.protocol !== 'https:' || url.hostname !== 'webusstatic.yo-star.com' || url.username || url.password) continue;
        const key = `${source}:${url.href}`;
        const previous = candidates.get(key);
        // An image placed directly before a unique bracketed pack heading is
        // independent evidence when ornate lettering defeats OCR. Other images
        // still need printed-title recognition; do not guess from proximity.
        const heading = post.lines[art.line]?.match(/^\[([^\]]+)\]$/)?.[1];
        const directNames = names.filter(name => titleText(name) === titleText(heading ?? ''));
        candidates.set(key, { source, url: url.href, names: [...new Set([...(previous?.names ?? []), ...names])], directNames: directNames.length === 1 ? directNames : [], published: Number(post.publishTime) || 0, line: art.line });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.published - a.published || a.line - b.line || a.url.localeCompare(b.url));
}
