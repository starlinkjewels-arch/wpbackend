/**
 * How healthy the number looks — the signals WhatsApp itself watches, in one
 * place, with what to do about each.
 *
 * WhatsApp does not publish its thresholds. These are the ones bulk-sending
 * guides agree on: opt-outs and failed numbers hurt most, replies help most,
 * and messages nobody answers now count against a monthly cap.
 */
import { campaigns, contacts } from "../data/collections.js";
import { getSettings } from "../data/settings.js";
import { dailyCap, localParts } from "./rules.js";

const DAY = 86400000;

export function accountHealth(now = Date.now()) {
  const settings = getSettings();
  const since = now - 30 * DAY;
  const t = { sent: 0, delivered: 0, read: 0, replied: 0, optedOut: 0, failed: 0 };
  for (const c of campaigns.all()) {
    if (!c.stats || (c.startedAt ?? 0) < since) continue;
    for (const k of Object.keys(t)) t[k] += c.stats[k] ?? 0;
  }

  const month = localParts(now, settings.timezone).date.slice(0, 7);
  let unanswered = 0;
  let ignoring = 0;
  for (const c of contacts.all()) {
    const mo = c.monthOut;
    if (mo?.m === month && !((c.lastInboundAt ?? 0) >= mo.first)) unanswered += mo.n ?? 0;
    if ((c.campaignsSinceReply ?? 0) >= settings.engagement.ignoredAfter && !c.optedOut) ignoring += 1;
  }

  const rate = (a, b) => (b ? a / b : null);
  const rates = {
    reply: rate(t.replied, t.sent),
    optOut: rate(t.optedOut, t.sent),
    fail: rate(t.failed, t.sent + t.failed),
    read: rate(t.read, t.delivered),
  };

  const checks = [];
  const add = (level, title, tip) => checks.push({ level, title, tip });

  if (rates.optOut != null && t.sent >= 20) {
    if (rates.optOut > 0.03) add("bad", "Many clients are replying STOP", "Send less often, only to clients who know you, and make each message useful to them.");
    else if (rates.optOut > 0.01) add("warn", "Opt-outs are rising", "Keep campaigns relevant: send to tags that fit the offer, not to everyone.");
  }
  if (rates.fail != null && t.sent + t.failed >= 20) {
    if (rates.fail > 0.1) add("bad", "Many numbers are not on WhatsApp", "Use Clients → Check on WhatsApp before your next campaign.");
    else if (rates.fail > 0.05) add("warn", "Some numbers are not on WhatsApp", "Check numbers on WhatsApp to clean the list.");
  }
  if (rates.reply != null && t.sent >= 50 && rates.reply < 0.05) {
    add("warn", "Few clients reply", "Ask a clear question (\"Reply YES for the catalogue\") and turn on AI personalisation.");
  }
  if (unanswered >= 500) add("warn", `${unanswered} unanswered messages this month`, "WhatsApp limits messages to people who never answer. Turn on “skip clients who ignore campaigns”.");
  if (!settings.window.enabled) add("warn", "Sending at any hour", "Turn on sending hours so messages never arrive at night.");
  if (!settings.restBreak.enabled) add("warn", "No safety breaks", "Turn safety breaks on in Settings → Sending safety.");
  if (settings.dailyLimit > 500) add("warn", `Daily limit is ${settings.dailyLimit}`, "Above 300–500 a day the risk of a ban rises quickly for a normal WhatsApp number.");
  if (settings.minDelay < 8) add("warn", "Messages go out very fast", "Use at least 8–10 seconds between messages.");

  const verdict = checks.some((c) => c.level === "bad") ? "risk" : checks.length ? "watch" : "good";
  return { verdict, totals: t, rates, unanswered, ignoring, cap: dailyCap(settings, now), checks };
}
