/**
 * When a message may go out. Pure, so each rule can be checked without a clock
 * or a WhatsApp connection.
 *
 * Three limits, all set by the business on the Settings page:
 *   - a gap between messages, random between min and max seconds;
 *   - sending hours, in the business's own time zone;
 *   - a daily cap.
 *
 * All three are there because the number is the business's real WhatsApp. A
 * burst of identical messages at 3am is what gets a number banned, and a banned
 * number is every client conversation the business has, gone.
 */

/** Minutes past midnight and the calendar date at `ms`, in `timeZone`. */
export function localParts(ms, timeZone = "Asia/Kolkata") {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
  } catch {
    return localParts(ms, "UTC");
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

export function dayKey(ms, timeZone) {
  return localParts(ms, timeZone).date;
}

/** "09:30" -> 570. Anything unreadable -> null. */
export function parseHm(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return Math.min(h * 60 + min, 1440);
}

/**
 * Is `ms` inside the sending hours? A window may wrap midnight (22:00–02:00).
 * A disabled or unreadable window means "any time" — failing closed here would
 * stop every campaign over a typo.
 */
export function inWindow(ms, window, timeZone) {
  if (!window?.enabled) return true;
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  if (start == null || end == null || start === end) return true;
  const { minutes } = localParts(ms, timeZone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** When the sending hours next open, at or after `ms`. */
export function nextWindowOpen(ms, window, timeZone) {
  if (inWindow(ms, window, timeZone)) return ms;
  const start = parseHm(window.start);
  const { minutes } = localParts(ms, timeZone);
  const wait = (start - minutes + 1440) % 1440 || 1440;
  // Snap to the start of the minute so "opens at 09:00" is 09:00:00.
  const base = ms - (ms % 60000);
  return base + wait * 60000;
}

/**
 * Inside sending hours AND not on the weekend (when weekends are skipped).
 * `weekend` is the list of weekday numbers that are the weekend there.
 */
export function isOpen(ms, window, timeZone, weekend = [6, 0]) {
  if (window?.skipWeekends && weekend.includes(localParts(ms, timeZone).weekday)) return false;
  return inWindow(ms, window, timeZone);
}

/** The next moment isOpen() is true, at or after `ms`. Looks at most ten days ahead. */
export function nextOpen(ms, window, timeZone, weekend = [6, 0]) {
  let t = ms;
  for (let i = 0; i < 10; i += 1) {
    if (isOpen(t, window, timeZone, weekend)) return t;
    const open = nextWindowOpen(t, window, timeZone);
    if (open > t && isOpen(open, window, timeZone, weekend)) return open;
    // Still the weekend there: jump to the start of their next day.
    const { minutes } = localParts(open, timeZone);
    t = open - (open % 60000) + (1440 - minutes) * 60000;
  }
  return t;
}

/**
 * Today's cap. With warm-up on, day one allows `startLimit` and each day adds
 * `step`, never above the normal daily limit.
 * @returns {{limit: number, day: number|null, fullOnDay: number|null}}
 */
export function dailyCap(settings, now = Date.now()) {
  const w = settings.warmup;
  if (!w?.enabled || !w.startedAt) return { limit: settings.dailyLimit, day: null, fullOnDay: null };
  const tz = settings.timezone;
  const start = Date.parse(`${localParts(w.startedAt, tz).date}T00:00:00Z`);
  const today = Date.parse(`${localParts(now, tz).date}T00:00:00Z`);
  const day = Math.max(0, Math.round((today - start) / 86400000)) + 1;
  const limit = Math.min(settings.dailyLimit, w.startLimit + (day - 1) * w.step);
  const fullOnDay = Math.max(1, Math.ceil((settings.dailyLimit - w.startLimit) / w.step) + 1);
  return { limit, day, fullOnDay };
}

/** Seconds, random in [min, max], with the pair repaired if entered backwards. */
export function randomGapMs(minSec, maxSec, random = Math.random) {
  let lo = Math.max(1, Number(minSec) || 1);
  let hi = Math.max(1, Number(maxSec) || lo);
  if (hi < lo) [lo, hi] = [hi, lo];
  return Math.round((lo + random() * (hi - lo)) * 1000);
}

/** Speed presets the composer offers, in seconds between messages. */
export const SPEEDS = {
  safe: { minDelay: 20, maxDelay: 45, label: "Safe" },
  normal: { minDelay: 10, maxDelay: 25, label: "Normal" },
  fast: { minDelay: 5, maxDelay: 12, label: "Fast" },
};

/** A rough "this will take about…" for the review step, in ms. */
export function estimateDurationMs(count, minSec, maxSec) {
  const avg = (Math.max(1, minSec) + Math.max(1, maxSec)) / 2;
  // Each send also waits a few seconds for WhatsApp's own acknowledgement.
  return Math.max(0, count) * (avg + 3) * 1000;
}
