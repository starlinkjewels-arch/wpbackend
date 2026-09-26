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
  ai: {
    enabled: true,
    model: "sarvam-105b",
    // 0 = the same wording every time, 1+ = more varied. 0.6 reads natural
    // without drifting away from the facts it was given.
    temperature: 0.6,
    // Thinking makes answers slower and costs more, and a short sales message
    // does not need it. Off by default; the admin can turn it up.
    reasoning: "off",
    tone: "professional",
    language: "English",
    businessProfile:
      "Starlink Jewels is an India-based manufacturer and exporter of certified natural diamond jewellery " +
      "(rings, earrings, pendants, bracelets, bridal sets) for jewellers, retailers and wholesalers worldwide. " +
      "Diamonds are GIA / IGI certified. We offer B2B pricing, custom manufacturing and worldwide insured shipping.",
    instructions: "",
    // Saved here when the admin types it in Settings; never sent back to the
    // browser. SARVAM_API_KEY on the server is used when this is empty.
    apiKey: "",
  },
};

export const AI_MODELS = ["sarvam-105b", "sarvam-105b-conversations"];
export const AI_TONES = ["professional", "warm", "luxury", "friendly", "concise"];
const REASONING = ["off", "low", "medium", "high"];

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
    ai: sanitizeAi(s.ai, base.ai ?? DEFAULTS.ai),
  };
  if (out.maxDelay < out.minDelay) [out.minDelay, out.maxDelay] = [out.maxDelay, out.minDelay];
  return out;
}

/* A settings document saved before AI existed has no `ai` at all, and one
   edited by hand may have half of it — every field falls back on its own. */
function sanitizeAi(a = {}, base = DEFAULTS.ai) {
  const temp = Number(a.temperature);
  const model = String(a.model ?? "").trim();
  return {
    enabled: Boolean(a.enabled ?? base.enabled),
    // Any name is accepted, so a model Sarvam adds later can be typed in.
    model: /^[\w.:-]{2,60}$/.test(model) ? model : base.model,
    temperature: Number.isFinite(temp) ? Math.min(1.5, Math.max(0, Math.round(temp * 10) / 10)) : base.temperature,
    reasoning: REASONING.includes(a.reasoning) ? a.reasoning : base.reasoning,
    tone: AI_TONES.includes(a.tone) ? a.tone : base.tone,
    language: String(a.language ?? "").trim().slice(0, 40) || base.language,
    businessProfile: String(a.businessProfile ?? base.businessProfile).slice(0, 3000),
    instructions: String(a.instructions ?? "").slice(0, 2000),
    apiKey: String(a.apiKey ?? base.apiKey ?? "").trim().slice(0, 200),
  };
}

/** The key to call Sarvam with: the one saved in Settings, else the server's. */
export function aiKey(settings = getSettings()) {
  return settings.ai.apiKey || process.env.SARVAM_API_KEY || "";
}

/**
 * Settings as the browser may see them. The API key never leaves the server:
 * the page is told whether one is set and its last characters, which is enough
 * to recognise it and not enough to use it.
 */
export function publicSettings(settings = getSettings()) {
  const { apiKey, ...ai } = settings.ai;
  const key = aiKey(settings);
  return {
    ...settings,
    ai: {
      ...ai,
      hasKey: Boolean(key),
      keySource: apiKey ? "settings" : key ? "server" : null,
      keyHint: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : null,
    },
  };
}

export function getSettings() {
  const { id: _id, ...saved } = settingsCol.get("app") ?? {};
  return sanitize(saved);
}

/* The page sends back what it was shown, which has no key in it — so an
   absent or empty key means "keep the saved one". Removing it is explicit. */
function mergeAi(current, patch) {
  if (!patch) return current;
  const { apiKey, clearKey, hasKey: _h, keySource: _s, keyHint: _k, ...rest } = patch;
  const next = { ...current, ...rest };
  if (clearKey) next.apiKey = "";
  else if (typeof apiKey === "string" && apiKey.trim()) next.apiKey = apiKey.trim();
  return next;
}

export async function updateSettings(patch) {
  const current = getSettings();
  const merged = {
    ...current,
    ...patch,
    window: { ...current.window, ...(patch.window ?? {}) },
    optOut: { ...current.optOut, ...(patch.optOut ?? {}) },
    autoReply: { ...current.autoReply, ...(patch.autoReply ?? {}) },
    ai: mergeAi(current.ai, patch.ai),
  };
  const next = sanitize(merged, current);
  await settingsCol.put("app", next);
  return next;
}
