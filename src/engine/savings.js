/**
 * What the same messages would have cost on WhatsApp's official Business API.
 *
 * Meta charges every marketing message by the RECIPIENT's country (rate card
 * effective 1 Oct 2026, USD, before any provider's markup). This app sends
 * from the business's own number, so each of those is money not spent — the
 * plainest answer to "why this and not WATI / AiSensy / Interakt".
 *
 * Only campaign messages to people count: replies inside a conversation are
 * free on the API too, and a group post has no API price because the API
 * cannot post to groups at all.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { campaigns, contacts } from "../data/collections.js";
import { peekRecipients, allRecipients } from "../data/recipients.js";

export const RATES_AS_OF = "2026-10-01";

/** USD per marketing message, by recipient country. */
export const MARKETING_RATES = {
  IN: 0.0118, AE: 0.0576, SA: 0.0576, IL: 0.0353, US: 0.025, CA: 0.025, GB: 0.0635,
  DE: 0.1365, FR: 0.0859, IT: 0.0795, NL: 0.1597, ES: 0.0707, BE: 0.0592, CH: 0.0859,
  HK: 0.0732, CN: 0.0842, SG: 0.0732, JP: 0.0842, AU: 0.0842, TH: 0.0842,
  QA: 0.0341, KW: 0.0341, BH: 0.0341, OM: 0.0341, TR: 0.0109, RU: 0.0802,
};
export const DEFAULT_RATE = 0.0604;
/** For showing rupees next to dollars. Approximate, and labelled as such. */
export const USD_INR = 88;

/* A number can be valid for its calling code without naming one territory
   (+44 is shared by the UK, Jersey, Guernsey, the Isle of Man): price it as
   the main country of that code. */
const MAIN_COUNTRY = { 1: "US", 7: "RU", 44: "GB", 61: "AU", 39: "IT", 47: "NO", 212: "MA", 262: "RE", 358: "FI", 590: "GP", 599: "CW" };

export function rateFor(phone) {
  const parsed = parsePhoneNumberFromString("+" + String(phone ?? ""));
  return MARKETING_RATES[parsed?.country] ?? MARKETING_RATES[MAIN_COUNTRY[parsed?.countryCallingCode]] ?? DEFAULT_RATE;
}

const round = (n) => Math.round(n * 10000) / 10000;

/** Sum over a campaign's delivered-to people. Group campaigns cost nothing on the API: they are impossible there. */
export async function campaignSavings(c) {
  if (!c?.materialized || c.audience?.mode === "groups") return { usd: 0, messages: 0 };
  // A finished campaign never changes: work it out once and keep it.
  // ("Retry failed" sends more later, so a count that no longer matches is redone.)
  if (c.savings && ["completed", "cancelled"].includes(c.status) && c.savings.messages === (c.stats?.sent ?? c.savings.messages)) return c.savings;
  const entry = await peekRecipients(c.id, c.chunkCount ?? 0).catch(() => null);
  if (!entry) return { usd: 0, messages: 0 };
  let usd = 0;
  let messages = 0;
  for (const r of allRecipients(entry)) {
    if (r.s !== "sent") continue;
    usd += rateFor(r.p);
    messages += 1;
  }
  const out = { usd: round(usd), messages };
  if (["completed", "cancelled"].includes(c.status)) await campaigns.patch(c.id, { savings: out }).catch(() => {});
  return out;
}

/** One broadcast to every client who can receive it, priced at their own countries' rates. */
export function perBroadcast() {
  let usd = 0;
  let clients = 0;
  for (const c of contacts.all()) {
    if (c.optedOut || c.waStatus === "invalid") continue;
    usd += rateFor(c.phone);
    clients += 1;
  }
  return { usd: round(usd), inr: Math.round(usd * USD_INR), clients };
}

/** All campaigns: total, this month, and the rates behind it. */
export async function totalSavings(now = Date.now()) {
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  let usd = 0;
  let messages = 0;
  let monthUsd = 0;
  for (const c of campaigns.all()) {
    const s = await campaignSavings(c);
    usd += s.usd;
    messages += s.messages;
    if ((c.finishedAt ?? c.startedAt ?? 0) >= monthStart.getTime()) monthUsd += s.usd;
  }
  return { usd: round(usd), inr: Math.round(usd * USD_INR), messages, perBroadcast: perBroadcast(), monthUsd: round(monthUsd), monthInr: Math.round(monthUsd * USD_INR), ratesAsOf: RATES_AS_OF, usdInr: USD_INR };
}
