/**
 * One small document per day: how many messages went out, failed, and came in.
 * The daily sending cap is enforced from this, so it counts in the business's
 * own time zone — "today" is the shop's today, not the server's.
 */
import { dailyStats } from "./collections.js";
import { getSettings } from "./settings.js";
import { dayKey } from "../engine/rules.js";

export function todayKey(now = Date.now()) {
  return dayKey(now, getSettings().timezone);
}

export function getDay(key) {
  const d = dailyStats.get(key);
  return {
    date: key,
    sent: d?.sent ?? 0,
    failed: d?.failed ?? 0,
    inbound: d?.inbound ?? 0,
    newContacts: d?.newContacts ?? 0,
    aiRequests: d?.aiRequests ?? 0,
    aiTokens: d?.aiTokens ?? 0,
  };
}

export function sentToday(now = Date.now()) {
  return getDay(todayKey(now)).sent;
}

/* Counters are read-modify-write through the cache, which is only safe one at
   a time: the cache is updated after the store write finishes, so two bumps
   in flight together both read the old value and one is lost. That happened
   as soon as the AI wrote three messages at once. Every bump waits its turn. */
let queue = Promise.resolve();

export function bump(field, by = 1, now = Date.now()) {
  const run = queue.then(async () => {
    const key = todayKey(now);
    const cur = getDay(key);
    await dailyStats.put(key, { ...cur, [field]: (cur[field] ?? 0) + by });
  });
  // A failed write must not jam every counter after it.
  queue = run.catch(() => {});
  return run;
}

/** The last `days` days, oldest first, zero-filled. */
export function lastDays(days = 14, now = Date.now()) {
  const tz = getSettings().timezone;
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(getDay(dayKey(now - i * 86400000, tz)));
  }
  return out;
}
