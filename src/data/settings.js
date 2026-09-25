/**
 * The business's own choices, one document. Every value has a default, and
 * every value read back is checked — a setting saved by an older version of
 * this app, or edited by hand in the Firebase console, must not be able to
 * turn "20 seconds between messages" into zero.
 */
import { settingsCol } from "./collections.js";
import { parseHm } from "../engine/rules.js";

export const DEFAULTS = {
  businessName: "Starlink Jewels",
  defaultCountry: "IN",
  timezone: "Asia/Kolkata",
  minDelay: 12,
  maxDelay: 30,
  dailyLimit: 300,
  window: { enabled: true, start: "09:00", end: "21:00" },
  autoAddInbound: true,
  inboundTag: "Inquiry",
  optOut: {
    enabled: true,
    keywords: ["STOP", "UNSUBSCRIBE", "STOP ALL", "REMOVE"],
    reply: "You have been unsubscribed and will not receive further updates from us. Reply START to subscribe again.",
  },
  autoReply: {
    enabled: false,
    onlyNewContacts: true,
    cooldownHours: 24,
    text: "Thank you for contacting {{business_name}}. Our team will get back to you shortly.",
  },
  onboardingDismissed: false,
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Anything in, a complete and sane settings object out. */
export function sanitize(input = {}, base = DEFAULTS) {
  const s = { ...base, ...input };
  const out = {
    businessName: String(s.businessName ?? "").trim().slice(0, 80) || DEFAULTS.businessName,
    defaultCountry: /^[A-Z]{2}$/.test(String(s.defaultCountry)) ? s.defaultCountry : base.defaultCountry,
    timezone: validTimezone(s.timezone) ? s.timezone : base.timezone,
    minDelay: clampInt(s.minDelay, 3, 600, base.minDelay),
    maxDelay: clampInt(s.maxDelay, 3, 900, base.maxDelay),
    dailyLimit: clampInt(s.dailyLimit, 1, 5000, base.dailyLimit),
    window: {
      enabled: Boolean(s.window?.enabled ?? base.window.enabled),
      start: parseHm(s.window?.start) != null ? s.window.start : base.window.start,
      end: parseHm(s.window?.end) != null ? s.window.end : base.window.end,
    },
    autoAddInbound: Boolean(s.autoAddInbound),
    inboundTag: String(s.inboundTag ?? "").trim().slice(0, 40),
    optOut: {
      enabled: Boolean(s.optOut?.enabled ?? base.optOut.enabled),
      keywords: (Array.isArray(s.optOut?.keywords) ? s.optOut.keywords : base.optOut.keywords)
        .map((k) => String(k).trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 20),
      reply: String(s.optOut?.reply ?? "").slice(0, 1000),
    },
    autoReply: {
      enabled: Boolean(s.autoReply?.enabled ?? base.autoReply.enabled),
      onlyNewContacts: Boolean(s.autoReply?.onlyNewContacts ?? base.autoReply.onlyNewContacts),
      cooldownHours: clampInt(s.autoReply?.cooldownHours, 1, 24 * 30, base.autoReply.cooldownHours),
      text: String(s.autoReply?.text ?? "").slice(0, 2000),
    },
    onboardingDismissed: Boolean(s.onboardingDismissed),
  };
  if (out.maxDelay < out.minDelay) [out.minDelay, out.maxDelay] = [out.maxDelay, out.minDelay];
  return out;
}

export function getSettings() {
  const { id: _id, ...saved } = settingsCol.get("app") ?? {};
  return sanitize(saved);
}

export async function updateSettings(patch) {
  const current = getSettings();
  const merged = {
    ...current,
    ...patch,
    window: { ...current.window, ...(patch.window ?? {}) },
    optOut: { ...current.optOut, ...(patch.optOut ?? {}) },
    autoReply: { ...current.autoReply, ...(patch.autoReply ?? {}) },
  };
  const next = sanitize(merged, current);
  await settingsCol.put("app", next);
  return next;
}
