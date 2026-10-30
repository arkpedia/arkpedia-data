import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const clean = text => String(text ?? '').replace(/<[^>]*>/g, '').trim();
/* An operator's rarity, 1-6: character_table writes "TIER_6", an older dump 5 (zero-based). */
const operatorRarity = character => {
  const tier = /^TIER_([1-6])$/.exec(String(character?.rarity ?? ''));
  return tier ? Number(tier[1]) : Number.isInteger(character?.rarity) && character.rarity >= 0 && character.rarity <= 5 ? character.rarity + 1 : undefined;
};
/** Global client rewards only. Paid login packages and banner-only permits are never savings. */
export function buildFreeRewards({ handbook, missions, openServer, checkin, activity, items, characters, shops, retro = { retroActList: {}, retroTrailList: {} }, eventRewards = { events: {} }, announcements = { events: {} } }) {
  const names = items.items;
  const rewardItems = rewards => (Array.isArray(rewards) ? rewards : []).map(item => {
    const id = item.id ?? item.itemId, type = item.type ?? item.itemType;
    const count = Number(item.count);
    if (!id || !Number.isFinite(count) || count <= 0) throw new Error('Invalid free reward item');
    // An operator says so by its rarity: the Reward Tracker opens its preview (OperatorPreview).
    const rarity = id.startsWith('char_') && characters[id] ? operatorRarity(characters[id]) : undefined;
    return { id, ...(rarity ? { rarity } : {}), name: names[id]?.name ?? characters[id]?.name ?? item.name ?? ({ FURN: 'Furniture', CHAR_SKIN: 'Operator outfit', PLAYER_AVATAR: 'Player avatar', HOME_BACKGROUND: 'Home background', NAME_CARD_SKIN: 'Profile theme' }[type] ?? 'Reward item'), count,
      ...(id === '4002' ? { op: count } : id === '4003' ? { orundum: count } : id === '7003' ? { permits: count } : id === '7004' ? { permits: count * 10 } : {}),
      ...(type?.includes('TKT_GACHA') && !['7003', '7004'].includes(id) ? { restricted: true } : {}),
    };
  });
  const out = [];
  const beginnerRewards = [];
  const add = (id, group, name, rewards, timing = {}, forecast = false, target = out) => {
    const list = rewardItems(rewards);
    if (list.length) target.push({ id: `free:${id}`, group, name: clean(name), rewards: list, ...timing, forecast });
  };
  for (const mission of Object.values(missions.missions)) {
    if (!['GUIDE', 'MAIN', 'SUB'].includes(mission.type)) continue;
    add(mission.id, mission.type === 'GUIDE' ? 'Pinboard missions' : 'Main and side missions', mission.description, mission.rewards, {}, true);
  }
  for (const group of Object.values(missions.missionGroups)) {
    if (group.type === 'GUIDE') add(group.id, 'Pinboard missions', group.title, group.rewards, {}, true);
  }
  // Older builds keep the current default; account-aware builds also read historical sign-ins.
  const current = [...openServer.schedule].sort((a, b) => b.startTs - a.startTs)[0];
  for (const programme of openServer.schedule) {
    const data = openServer.dataMap[programme.id];
    if (!data) continue;
    const beginner = { id: programme.id, startTs: programme.startTs, ...(Number.isSafeInteger(programme.endTs) ? { endTs: programme.endTs } : {}), current: programme.id === current.id };
    const target = beginner.current ? out : beginnerRewards;
    for (const mission of data.openServerMissionData ?? []) add(mission.id, 'Beginner rewards', mission.description, mission.rewards, { beginner }, true, target);
    for (const key of ['checkInData', 'chainLoginData']) for (const day of data[key] ?? []) {
      add(`${programme.id}:${key}:${day.order}`, 'Beginner rewards', `${key === 'chainLoginData' ? 'Consecutive' : 'Cumulative'} sign-in · Day ${day.order}`, [day.item], { beginner }, true, target);
    }
  }
  add('welcome-mail', 'Beginner rewards', 'Welcome mail', [{ id: '4003', count: openServer.constant.firstDiamondShardMailCount }], {}, true);
  for (const milestone of openServer.longTermCheckInData?.groupList ?? []) add(milestone.groupId, 'Sign-in milestones', `${milestone.days} sign-in days · Doctor Lv.${milestone.level}`, milestone.rewardList);
  for (const month of Object.values(checkin.groups)) month.items.forEach((item, index) =>
    add(`${month.groupId}:${index + 1}`, 'Monthly sign-in', `${month.title} · Day ${index + 1}`, [item], { startAt: month.signStartTime * 1000, endAt: (month.signEndTime + 1) * 1000 }));
  /* Each client sign-in's days, as the counts of its items: an official post announcing the
     same sign-in under another title and its own item names is that sign-in, not a second one. */
  const clientSignIns = [];
  const dayCounts = list => JSON.stringify((Array.isArray(list) ? list : []).map(item => Number(item.count)).sort((a, b) => a - b));
  for (const type of ['CHECKIN_ONLY', 'CHECKIN_ALL_PLAYER', 'CHECKIN_VS', 'LOGIN_ONLY']) for (const [id, event] of Object.entries(activity.activity[type] ?? {})) {
    const info = activity.basicInfo[id];
    if (!info) throw new Error(`Missing Global sign-in dates: ${id}`);
    const timing = { startAt: info.startTime * 1000, endAt: (info.rewardEndTime + 1) * 1000 };
    if (type === 'LOGIN_ONLY') add(id, 'Event sign-in and gifts', info.name, event.itemList, timing);
    const days = Object.values(event.checkInList ?? event.checkInDict ?? {});
    if (days.length) clientSignIns.push({ startAt: timing.startAt, days: [...days].sort((a, b) => a.order - b.order).map(day => day.isDynItem ? 'choice' : dayCounts(day.itemList ?? day.rewardList)) });
    for (const day of days) {
      add(`${id}:${day.order}`, 'Event sign-in and gifts', `${info.name} · Day ${day.order}`, day.isDynItem ? [{ id: `${id}:choice`, name: 'Choice reward (choose one in game)', count: 1 }] : day.itemList ?? day.rewardList, timing);
    }
    for (const bonus of Object.values(event.pubBhvs ?? {})) add(`${id}:${bonus.allBehaviorId}`, 'Event sign-in and gifts', `${info.name} · ${bonus.allBehaviorDesc}`, bonus.rewards, timing);
  }
  /* Two sign-ins kept in activity_table's dynActs, not its activity blocks: CHECKIN_ACCESS (the
     Recommended Monthly Card's daily bonus, for a monthly card's holder: dayCount days of
     rewardItemPerDay; the save counts the days claimed, rewardsCount) and CHECKIN_VIDEO (a short
     login event, its checkInList days; the save's history holds 0 for a claimed day). Built from
     the table, their ids are the save's (lib/account/rewardClaims.ts), and an official post of
     the same days is matched to them below rather than kept as a never-imported second copy. */
  for (const [id, dyn] of Object.entries(activity.dynActs ?? {})) {
    const info = activity.basicInfo[id];
    if (!info || !['CHECKIN_ACCESS', 'CHECKIN_VIDEO'].includes(info.type)) continue;
    const timing = { startAt: info.startTime * 1000, endAt: (info.rewardEndTime + 1) * 1000 };
    const days = info.type === 'CHECKIN_ACCESS'
      ? (Number.isInteger(dyn.dayCount) && dyn.dayCount > 0 && dyn.dayCount <= 62 && Array.isArray(dyn.rewardItemPerDay)
        ? Array.from({ length: dyn.dayCount }, (_, index) => ({ order: index + 1, itemList: dyn.rewardItemPerDay })) : [])
      : Object.values(dyn.checkInList ?? {}).filter(day => Number.isInteger(day.order)).sort((a, b) => a.order - b.order);
    if (!days.length) continue;
    const name = info.type === 'CHECKIN_ACCESS' ? 'Monthly Card check-in' : info.name;
    clientSignIns.push({ startAt: timing.startAt, days: days.map(day => dayCounts(day.itemList)) });
    for (const day of days) add(`${id}:${day.order}`, 'Event sign-in and gifts', `${name} · Day ${day.order}`, day.itemList, timing);
  }
  // Official Global gifts may precede their client-table entries, including free selectors.
  const seen = new Set();
  for (const source of [eventRewards, announcements]) for (const [eventName, entry] of Object.entries(source.events)) for (const group of entry.groups ?? []) {
    if (!['login', 'banner-gift', 'free-rolls'].includes(group.kind) || (group.region ?? entry.region ?? 'Global') !== 'Global' || group.source?.startsWith('activity_table') || !group.start || !group.end) continue;
    const startAt = Date.parse(group.start), endAt = Date.parse(group.end);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error(`Invalid free gift window: ${eventName}`);
    const totals = list => {
      const values = new Map();
      for (const item of list) values.set(item.id, (values.get(item.id) ?? 0) + item.count);
      return JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b)));
    };
    const title = clean(group.title).toLowerCase();
    const recorded = out.filter(reward => reward.group === 'Event sign-in and gifts' && reward.name.toLowerCase().includes(title)
      && reward.startAt === startAt && Math.abs(reward.endAt - endAt) <= 60_000);
    // When a later client patch carries the same announced gift, count its claims once.
    if (recorded.length && totals(recorded.flatMap(reward => reward.rewards)) === totals(rewardItems(group.items.map(item => ({ ...item, id: item.id || `label:${item.name}` }))))) continue;
    const daily = group.kind === 'login' && group.days > 1 && group.items?.length && group.items.every(item => item.count % group.days === 0);
    const days = group.daily?.length ? group.daily : daily ? Array.from({ length: group.days }, () => group.items.map(item => ({ ...item, count: item.count / group.days }))) : [group.items];
    // The client's own sign-in, announced under the post's title (2026-10-14: '2026 CELEBRATION
    // SIGN-IN EVENT OPEN' was act59sign): opening within a day of it, day for day the same counts.
    // Kept, it was a second, never-imported copy of every day, counted twice in the totals.
    const announced = days.map(dayCounts);
    const allCounts = (list) => JSON.stringify(list.flatMap(counts => counts === 'choice' ? [] : JSON.parse(counts)).sort((a, b) => a - b));
    if (group.kind === 'login' && clientSignIns.some(signIn => Math.abs(signIn.startAt - startAt) < 86_400_000 && (
      (signIn.days.length === announced.length && signIn.days.every((counts, index) => counts === 'choice' || counts === announced[index]))
      // One post listing every day's items as one gift (2026-10-08: "To Look Back on Terra", the
      // three days of act3video in a single row): the same counts, all together.
      || (announced.length === 1 && signIn.days.length > 1 && allCounts(signIn.days) === allCounts(announced))))) continue;
    days.forEach((items, index) => {
      if (!items?.length) return;
      const identity = `${eventName}:${group.title}:${index}`;
      if (seen.has(identity)) return; seen.add(identity);
      const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
      add(`announcement:${id}`, 'Event sign-in and gifts', `${eventName} · ${group.title}${days.length > 1 ? ` · Day ${index + 1}` : ''}`,
        items.map(item => ({ ...item, id: item.id || `label:${item.name}`, type: item.kind })),
        { startAt, endAt, href: `/events/${encodeURIComponent(eventName)}` });
    });
  }
  /* Welfare operators: every free operator the Global tables give outside sign-ins (a sign-in's
     operator is already a day of its sign-in above), each where the game records its claim, so an
     import ticks it (lib/account/rewardClaims.ts). Global only; JP/KR keep a row only through
     their own schedule's window (lib/time/regional.ts).
       - An event's missions (activity_table missionData, a CHAR reward): a side story's 4- or
         5-star. Claimable while the event's stages are open (basicInfo startTime to endTime), as
         the roster's Now Available counts an event's own operator
         (lib/operators/operatorReleaseSchedule.ts). Identity: the mission id.
       - A main-story event's permanent missions (mission_table, type RETRO, a CHAR reward), whose
         group retro_table links to the event: Viy, act4mainssPermanent_5 'Clear 17-13', for
         Critical Phase Transition (act4mainss). The group outlives the event (Archives), so the
         row opens with the event and has no end. Identity: the mission id.
       - An archived story's Record Restoration (retro_table retroTrailList, a CHAR reward): the
         side story's operator again, for its stars, from trailStartTime with no end. Identity:
         trail:<retro id>:<trail reward id>, as the account keys it (retro.trail): the reward ids
         alone repeat (Twilight of Wolumonde's is Darknights Memoir's trailReward_sub_1_1).
       - A story restored without a trail (retroActList haveTrail false): its event's operator
         mission, reopened for good from the restore date. Identity: restore:<retro id>:<mission id>.
       - Anything else an event's own data gives (milestones, exploration, investments: a CHAR
         item in activity_table.activity), while its stages are open. Manual: the account has no
         per-reward record of these.
     Stage first clears give operators only in the tutorial and the first chapters (permanent,
     not an event's); no Global event store sells an operator, only its tokens. */
  const eventHref = activityId => {
    if (!activityId) return {};
    const name = Object.keys(eventRewards.events).find(event => eventRewards.events[event]?.activity === activityId);
    return name ? { href: `/events/${encodeURIComponent(name)}` } : {};
  };
  const operators = [];
  /* Each row says where it comes from (`source`), which is what the Reward Tracker's overview
     reads to list only the operators still obtainable (lib/pulls/freeRewards.ts
     obtainableWelfare): 'trail' (Record Restoration, the Archives: permanent), 'event' and
     'extra' (an event's own missions and data: while it runs, its endAt), 'retro' (a
     main-story event's permanent missions: claimable for ticking with no end, so the row has
     none, and `eventEndAt` keeps when the event's own window closes). */
  const welfare = (id, charId, how, activityId, window, source) => {
    if (!characters[charId] || out.some(reward => reward.id === `free:${id}`)) return;
    const info = activity.basicInfo[activityId];
    operators.push({ charId, activityId, retroId: window.retroId });
    add(id, 'Welfare operators', `${characters[charId].name} · ${how}`, [{ id: charId, type: 'CHAR', count: 1 }],
      { startAt: window.startAt, ...(window.endAt ? { endAt: window.endAt } : {}), event: clean(window.event ?? info?.name) || activityId, ...eventHref(activityId),
        source, ...(window.eventEndAt ? { eventEndAt: window.eventEndAt } : {}) });
  };
  const eventWindow = activityId => {
    const info = activity.basicInfo[activityId];
    return info?.startTime && info?.endTime ? { startAt: info.startTime * 1000, endAt: (info.endTime + 1) * 1000 } : null;
  };
  const isOperator = reward => (reward?.type ?? reward?.itemType) === 'CHAR' && String(reward?.id ?? reward?.itemId).startsWith('char_');
  for (const mission of activity.missionData ?? []) for (const reward of mission.rewards ?? []) {
    const window = isOperator(reward) && eventWindow(mission.missionGroup);
    if (window) welfare(mission.id, reward.id, `Event missions: ${clean(mission.description)}`, mission.missionGroup, window, 'event');
  }
  // The event a retro group belongs to: the one it is named for, else the first it links.
  const retroActivity = retroId => {
    const act = retro.retroActList?.[retroId];
    return act ? [act.customActId, ...(act.linkedActId ?? [])].find(id => id && activity.basicInfo[id]) : undefined;
  };
  for (const mission of Object.values(missions.missions)) {
    if (mission.type !== 'RETRO') continue;
    for (const reward of mission.rewards ?? []) {
      const activityId = isOperator(reward) && retroActivity(mission.missionGroup);
      const window = activityId && eventWindow(activityId);
      if (window) welfare(mission.id, reward.id, `Event missions (permanent): ${clean(mission.description)}`, activityId, { startAt: window.startAt, eventEndAt: window.endAt, retroId: mission.missionGroup }, 'retro');
    }
  }
  for (const [retroId, trail] of Object.entries(retro.retroTrailList ?? {})) for (const step of trail.trailRewardList ?? []) {
    const act = retro.retroActList?.[retroId];
    const opens = trail.trailStartTime > 0 ? trail.trailStartTime : act?.startTime;
    if (!isOperator(step.rewardItem) || !act || !(opens > 0)) continue;
    welfare(`trail:${retroId}:${step.trailRewardId}`, step.rewardItem.id, `Record Restoration: ${step.starCount} stars`, retroActivity(retroId), { startAt: opens * 1000, event: act.name, retroId }, 'trail');
  }
  /* Record Restoration without a trail (retroActList haveTrail false, trailStartTime -1): every
     story restored since Ending a Grand Overture (Global, 2025-04). It has no star track; the
     restored story reopens its event's missions for good, the operator's with them (the owner's
     save, 2026-10-28: Crownslayer's PV-5 and Papyrus' AS-5 missions held under both the event's
     and its rerun's ids, the stories open in retro.block, no retro.trail). So the operator of the
     event's missions is a permanent row from the restore date. One per operator and story: the
     event's mission first (linkedActId lists the event, then its rerun). Identity:
     restore:<retro id>:<mission id>; the import ticks it from the roster (rosterClaimedWelfare). */
  for (const [retroId, act] of Object.entries(retro.retroActList ?? {})) {
    if (act.haveTrail !== false || !(act.startTime > 0)) continue;
    for (const actId of act.linkedActId ?? []) for (const mission of activity.missionData ?? []) {
      if (mission.missionGroup !== actId) continue;
      for (const reward of mission.rewards ?? []) {
        if (!isOperator(reward) || operators.some(row => row.retroId === retroId && row.charId === reward.id)) continue;
        welfare(`restore:${retroId}:${mission.id}`, reward.id, `Record Restoration: ${clean(mission.description)}`, retroActivity(retroId), { startAt: act.startTime * 1000, event: act.name, retroId }, 'trail');
      }
    }
  }
  /* Every restored story whose event's missions give an operator has a permanent row for it:
     its trail, its trail-less restoration above, or a main-story event's permanent missions. A
     story whose trail is still to come (haveTrail with a later trailStartTime: Path of Life's
     opens 2026-12-11) gets its row when the table lists the trail. A format the game adds that
     none of these reads fails the run, rather than hiding the operator as it did until
     2026-10-28 (Catherine, Papyrus, Crownslayer, Rose Salt, Xingzhu, Brigid). */
  for (const [retroId, act] of Object.entries(retro.retroActList ?? {})) {
    const linked = new Set(act.linkedActId ?? []);
    const gives = (activity.missionData ?? []).some(mission => linked.has(mission.missionGroup) && (mission.rewards ?? []).some(isOperator));
    const trailToCome = act.haveTrail === true || (act.haveTrail === undefined && act.trailStartTime > 0);
    if (gives && !trailToCome && !operators.some(row => row.retroId === retroId)) {
      throw new Error(`Record Restoration without a welfare row: ${retroId} restores ${[...linked].join(', ')}, whose missions give an operator, and no rule here reads it`);
    }
  }
  const checkIns = new Set(['CHECKIN_ONLY', 'CHECKIN_ALL_PLAYER', 'CHECKIN_VS', 'LOGIN_ONLY']);
  for (const [type, events] of Object.entries(activity.activity)) if (!checkIns.has(type)) for (const [activityId, data] of Object.entries(events ?? {})) {
    const window = eventWindow(activityId);
    if (!window) continue;
    const found = new Set();
    const walk = value => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') { if (isOperator(value)) found.add(value.id ?? value.itemId); else Object.values(value).forEach(walk); }
    };
    walk(data);
    for (const charId of found) if (!operators.some(row => row.activityId === activityId && row.charId === charId)) {
      welfare(`welfare:${activityId}:${charId}`, charId, 'Event rewards', activityId, window, 'extra');
    }
  }
  // Every operator the client's event mission pages feature (ILLUST_CHAR_REWARD) has its row:
  // Viy's page featured her while no table this builder read gave her, and nothing said so.
  for (const [page, style] of Object.entries(activity.activityTemplateMissionStyles ?? {})) {
    if (style?.bigRewardType !== 'ILLUST_CHAR_REWARD') continue;
    const charId = style.bigRewardParamList?.[0];
    if (!operators.some(row => row.charId === charId && (row.activityId === page || row.retroId === page))) {
      throw new Error(`Welfare operator without a row: ${charId} featured by ${page}'s missions`);
    }
  }
  // The client names these free packs but does not publish their contents here. Track the claim, without inventing currency.
  for (const [id, pack] of Object.entries(shops.shopGPDataDict)) if (id.startsWith('GP_freeL_')) {
    add(id, 'Free level-up packs', pack.displayName, [{ id, name: pack.displayName, count: 1 }]);
  }
  const paradox = Object.values(handbook.handbookStageData).map(stage => ({
    operatorId: stage.charId,
    ...(stage.unlockParam?.length === 1 && stage.unlockParam[0].unlockType === 'AWAKE' ? { unlock: { elite: Number(stage.unlockParam[0].unlockParam1), level: Number(stage.unlockParam[0].unlockParam2) } } : {}),
    id: `paradox:${stage.stageId}`, name: clean(`${characters[stage.charId]?.name ?? stage.charId} · ${stage.name}`),
    amount: stage.rewardItem.filter(item => item.id === '4003').reduce((sum, item) => sum + item.count, 0),
  })).filter(stage => stage.amount > 0).sort((a, b) => a.name.localeCompare(b.name));
  const all = [...out, ...beginnerRewards];
  if (new Set(all.map(item => item.id)).size !== all.length) throw new Error('Duplicate free reward IDs');
  return { paradox, rewards: out, beginnerRewards };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const excel = process.env.ARKPEDIA_EN_EXCEL ?? '.cache/upstream/en-gamedata/en/gamedata/excel';
  const read = name => JSON.parse(fs.readFileSync(path.join(excel, `${name}_table.json`), 'utf8'));
  const data = buildFreeRewards({ handbook: read('handbook_info'), missions: read('mission'), openServer: read('open_server'), checkin: read('checkin'), activity: read('activity'), items: read('item'), characters: read('character'), shops: read('shop_client'), retro: read('retro'), eventRewards: JSON.parse(fs.readFileSync('data/event-rewards.json', 'utf8')), announcements: JSON.parse(fs.readFileSync('config/event-announcements.json', 'utf8')) });
  fs.writeFileSync('data/free-rewards.json', JSON.stringify(data, null, 2) + '\n');
  console.log(`${data.paradox.length} Paradox Simulations; ${data.rewards.length} free reward claims`);
}
