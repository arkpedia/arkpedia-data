import { chapterSections, timoEntries } from './timo-chapters.mjs';

/** Timo's public catalog.js category rules, read as data; no remote code is executed.
 * Keep the library independent of the community board and retain the reader's group IDs. */
export function timoLibrary(catalog) {
  if (!catalog.review || !Object.keys(catalog.review).length) throw new Error('The reader catalogue has no stories.');
  const review = { ...catalog.review };
  const entries = [];
  const chapters = {};
  const seen = new Set();
  const ops = catalog.ops ?? {};
  const shortNames = Object.fromEntries(Object.entries(ops).map(([id, pair]) => [id.split('_').slice(2).join('_'), pair[0] || pair[1] || id]));
  const row = (storyTxt, storyName) => ({ storyTxt, storyName });
  function add(id, category, title, rows) {
    if (seen.has(id)) throw new Error(`Duplicate reader group: ${id}`);
    seen.add(id);
    if (rows) review[id] = { infoUnlockDatas: rows };
    const sections = chapterSections(timoEntries({ ...catalog, review }, id) ?? []);
    entries.push({ id, category, title: title || id, url: `https://arknights.timo.beer/story.html#${category}&${id}&0` });
    if (sections.length) chapters[id] = sections;
  }
  for (const [id, group] of Object.entries(catalog.review)) {
    const category = id.startsWith('main_') ? 'main' : id.startsWith('story_') ? 'record' : group.entryType?.startsWith('MINI_') ? 'mini' : 'side';
    let title = group.name;
    if (category === 'main') title = `Chapter ${id.slice(5).padStart(2, '0')}: ${title || id}`;
    if (category === 'record') {
      const match = /^story_(.+)_set_(\d+)$/.exec(id);
      title = `${shortNames[match?.[1]] || title || id}${match ? ` [${match[2]}]` : ''}`;
    }
    add(id, category, title);
  }
  for (const ids of Object.values(catalog.equip?.charEquip ?? {})) {
    for (const id of ids.slice(1)) {
      const info = catalog.equip.equipDict[id];
      if (!info || !ops[info.charId]) continue;
      const designation = [info.typeName1, info.typeName2].filter(Boolean).join(' ');
      add(id, 'module', `${ops[info.charId][0] || ops[info.charId][1]}, ${designation || info.uniEquipName}`, [row(id, info.uniEquipName || 'Module story')]);
    }
  }
  if (catalog.rogue) {
    add('rogue_0', 'rogue', catalog.rogue.legacy || "Ceobe's Fungimist", ['Prologue', 'Dust of Dreams', 'Perplexed Traveler', 'Return to the Wilds'].map((title, i) => row(`activities/act12d6/level_act12d6_${i ? `ending_${i}` : 'entry'}`, title)));
    const keys = new Set((catalog.storyKeys ?? []).map(key => key.toLowerCase()));
    for (const [id, topic] of Object.entries(catalog.rogue.topics ?? {})) {
      const number = /_(\d+)/.exec(id)?.[1];
      const detail = catalog.rogue.details?.[id] ?? {};
      const rows = [];
      const prologue = `obt/roguelike/ro${number}/level_rogue${number}_entry`;
      if (keys.has(prologue)) rows.push(row(prologue, 'Prologue'));
      const endbook = detail.archiveComp?.endbook?.endbook ?? {};
      if (!Object.keys(endbook).length) {
        for (const [key, ending] of Object.entries(detail.endings ?? {})) rows.push(row(`obt/roguelike/ro${number}/level_rogue${number}_ending_${key.split('_').at(-1)}`, ending.name));
      } else for (const book of Object.values(endbook)) {
        rows.push(row(book.avgId?.toLowerCase(), book.title));
        for (const part of Object.values(book.clientEndbookItemDatas ?? {})) rows.push(row(part.textId?.toLowerCase(), `${book.title} - ${part.endbookName}`));
      }
      add(id, 'rogue', topic.name, rows);
      Object.entries(detail.monthSquad ?? {}).forEach(([key, squad], index) => {
        const chat = detail.archiveComp?.chat?.chat?.[squad.chatId];
        const rows = Object.values(chat?.clientChatItemData ?? chat?.chatItemList ?? {}).map(part => row(part.chatStoryId?.toLowerCase(), `Floor ${part.chatFloor ?? part.floor}`));
        add(`${id}_${key}`, 'rogue', `${topic.name} · M${index + 1} - ${squad.teamName}`, rows);
      });
    }
  }
  for (const [id, info] of Object.entries(catalog.sandbox?.basicInfo ?? {})) {
    const prefix = `Obt/SandboxPerm/${id}/`;
    const own = (catalog.storyKeys ?? []).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    const ordered = [`${id}_entry`, `${id}_1`, ...own.filter(key => /_ending_\d+$/.test(key)).sort((a, b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1)))];
    ordered.push(...own.filter(key => !ordered.includes(key) && !/guide|tutorial|uiavg/i.test(key)));
    let part = 0;
    const rows = ordered.filter(key => own.includes(key)).map(key => row(`${prefix}${key}`.toLowerCase(), key.endsWith('_entry') ? 'Prologue' : key === `${id}_1` ? 'Arrival' : /_ending_(\d+)$/.test(key) ? `Ending ${key.split('_').at(-1)}` : `Part ${++part}`));
    add(id, 'sandbox', info.topicName, rows);
  }
  for (const [id, act] of Object.entries(catalog.extras ?? {})) {
    if (!act.scripts?.length) continue;
    let part = 0;
    const rows = act.scripts.map(item => row(item.txt, item.kind === 'intro' ? 'Intro' : item.kind === 'ending' ? `Ending ${item.n}` : item.kind === 'system' ? 'System' : ['before', 'after'].includes(item.kind) ? `Stage ${item.n} (${item.kind})` : `Part ${++part}`));
    add(id, act.shelf === 'sandbox' ? 'sandbox' : 'extra', act.name, rows);
  }
  // The reference's chapters ascend numerically, records/modules by operator name.
  const order = ['main', 'side', 'mini', 'rogue', 'sandbox', 'extra', 'record', 'module'];
  entries.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || (a.category === 'main' ? Number(a.id.slice(5)) - Number(b.id.slice(5)) : ['record', 'module'].includes(a.category) ? a.title.localeCompare(b.title) : 0));
  return { entries, chapters };
}
