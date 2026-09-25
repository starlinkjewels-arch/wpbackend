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
  return { date: key, sent: d?.sent ?? 0, failed: d?.failed ?? 0, inbound: d?.inbound ?? 0, newContacts: d?.newContacts ?? 0 };
}

export function sentToday(now = Date.now()) {
  return getDay(todayKey(now)).sent;
}

/* Counters are read-modify-write through the cache. Safe because this process
   is the only writer; see collections.js. */
export async function bump(field, by = 1, now = Date.now()) {
  const key = todayKey(now);
  const cur = getDay(key);
  const next = { ...cur, [field]: (cur[field] ?? 0) + by };
  await dailyStats.put(key, next);
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
