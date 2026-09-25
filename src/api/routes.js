/**
 * The web app's API. Everything under /api, and all of it behind requireUser.
 *
 * Errors come back as { error, code } with a status that says whose move it
 * is: 4xx for something the person can fix (the message says how), 409 when
 * the thing is in the wrong state for that action, 503 while data is loading.
 */
import express from "express";
import wa from "../wa.js";
import { DEMO_MODE, STORE_KIND } from "../store/index.js";
import { login, isSignedIn, requireUser, signedMediaQuery, mediaSignatureValid } from "../auth.js";
import { campaigns, contacts, conversations, mediaIndex, dataState } from "../data/collections.js";
import * as C from "../data/contacts.js";
import * as Camp from "../data/campaigns.js";
import * as T from "../data/templates.js";
import * as Inbox from "../data/inbox.js";
import { getSettings, updateSettings } from "../data/settings.js";
import { getDay, todayKey, lastDays, bump } from "../data/stats.js";
import { saveMedia, getMedia, deleteMedia, MAX_MEDIA_BYTES } from "../data/media.js";
import { runner, pauseCampaign, resumeCampaign, cancelCampaign, retryFailed, getRecipients, estimateFinish, sendTest } from "../engine/runner.js";
import { renderMessage, varsForContact, missingVarCounts, BUILT_IN_VARS } from "../engine/personalize.js";
import { estimateDurationMs, SPEEDS } from "../engine/rules.js";
import { formatPhone } from "../phone.js";

export const api = express.Router();

/** Async route, errors turned into the JSON shape above. */
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    const status = err.status ?? (err.code === "NOT_CONNECTED" ? 409 : err.code === "NOT_ON_WHATSAPP" ? 422 : 500);
    if (status >= 500) console.error(`[api] ${req.method} ${req.path} failed:`, err);
    res.status(status).json({ error: status >= 500 && !err.code ? "Something went wrong — please try again" : err.message, code: err.code ?? null });
  }
};

/* ── Sign in ─────────────────────────────────────────────────────────── */

api.post("/auth/login", express.json(), login);
api.get("/auth/me", (req, res) => res.json({ signedIn: isSignedIn(req), demo: DEMO_MODE }));

/* An attachment, opened by an <img> or <video> tag — which cannot send the
   session header, so the link carries its own short-lived signature instead. */
api.get("/media/:id", async (req, res, next) => {
  if (!mediaSignatureValid(req.params.id, req.query.sig)) return next();
  try {
    const m = await getMedia(req.params.id);
    if (!m) return res.status(404).json({ error: "File not found", code: "NOT_FOUND" });
    res.set({
      "Content-Type": m.meta.mimetype,
      "Content-Disposition": `inline; filename="${encodeURIComponent(m.meta.name)}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    res.send(m.buffer);
  } catch (err) {
    next(err);
  }
});

api.use(requireUser);

/* Everything past here reads the cached data. Until it has loaded, say so
   rather than answering with an empty client list that looks real. */
api.use((req, res, next) => {
  if (dataState.ready || req.path === "/status") return next();
  res.status(503).json({ error: dataState.error ? `Could not load data: ${dataState.error}` : "Starting up — try again in a moment", code: "NOT_READY" });
});

/* ── Status: polled by every page ────────────────────────────────────── */

function waStatus() {
  const s = wa.state;
  return {
    status: s.status,
    phone: s.phone,
    phoneDisplay: s.phone ? formatPhone(s.phone) : null,
    qr: s.status === "qr" ? s.qrDataUrl : null,
    halted: Boolean(s.halted),
    error: s.lastError,
  };
}

api.get("/status", (_req, res) => {
  const settings = dataState.ready ? getSettings() : null;
  res.json({
    demo: DEMO_MODE,
    store: STORE_KIND,
    dataReady: dataState.ready,
    dataError: dataState.error,
    wa: waStatus(),
    unread: dataState.ready ? Inbox.unreadTotal() : 0,
    runner: { activeId: runner.activeId, waiting: runner.waiting },
    sentToday: dataState.ready ? getDay(todayKey()).sent : 0,
    dailyLimit: settings?.dailyLimit ?? null,
    businessName: settings?.businessName ?? "",
  });
});

api.post("/wa/disconnect", h(async () => {
  await wa.disconnect();
}));

/* ── Home ────────────────────────────────────────────────────────────── */

api.get("/dashboard", h(() => {
  const settings = getSettings();
  const all = Camp.listCampaigns();
  const recentInquiries = contacts
    .all()
    .filter((c) => c.source === "inbound")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 6);
  return {
    counts: C.contactCounts(),
    today: getDay(todayKey()),
    dailyLimit: settings.dailyLimit,
    chart: lastDays(14),
    active: all.filter((c) => ["running", "queued", "paused"].includes(c.status)).slice(0, 4).map(view),
    upcoming: all.filter((c) => c.status === "scheduled").slice(0, 5).map(view),
    recent: all.filter((c) => c.status === "completed").slice(0, 3).map(view),
    recentInquiries,
    unread: Inbox.unreadTotal(),
    onboarding: {
      connected: wa.state.status === "connected",
      hasContacts: contacts.size > 0,
      hasCampaign: campaigns.size > 0,
      dismissed: settings.onboardingDismissed,
    },
  };
}));

/* ── Clients ─────────────────────────────────────────────────────────── */

const filtersFrom = (q) => ({
  q: q.q ?? "",
  tag: q.tag ? String(q.tag).split(",").filter(Boolean) : [],
  status: q.status ?? "all",
  source: q.source ?? "",
});

api.get("/contacts", h((req) => ({
  ...C.listContacts({ ...filtersFrom(req.query), page: req.query.page, pageSize: req.query.pageSize, sort: req.query.sort }),
  counts: C.contactCounts(),
})));

api.get("/contacts/ids", h((req) => ({ ids: C.filterContacts(filtersFrom(req.query)).map((c) => c.id) })));
api.get("/contacts/export", h((req) => ({ items: C.filterContacts(filtersFrom(req.query)) })));
api.get("/contacts/meta", h(() => ({ tags: C.tagSummary(), fields: C.customFields(), builtIn: BUILT_IN_VARS, counts: C.contactCounts() })));

api.get("/contacts/:id", h((req) => {
  const c = contacts.get(req.params.id);
  if (!c) throw C.fail("Client not found", "NOT_FOUND", 404);
  return c;
}));

api.post("/contacts", express.json(), h((req) => C.createContact(req.body ?? {})));
api.put("/contacts/:id", express.json(), h((req) => C.updateContact(req.params.id, req.body ?? {})));
api.delete("/contacts/:id", h(async (req) => ({ deleted: await C.deleteContacts([req.params.id]) })));

/** One endpoint for everything the bulk-action bar does. */
api.post("/contacts/bulk", express.json({ limit: "5mb" }), h(async (req) => {
  const { action, ids: given, filter, tags } = req.body ?? {};
  const ids = Array.isArray(given) ? given.map(String) : C.filterContacts(filtersFrom(filter ?? {})).map((c) => c.id);
  switch (action) {
    case "delete": return { count: await C.deleteContacts(ids) };
    case "addTags": return { count: await C.tagContacts(ids, { add: tags }) };
    case "removeTags": return { count: await C.tagContacts(ids, { remove: tags }) };
    case "optOut": return { count: await C.setOptedOut(ids, true) };
    case "optIn": return { count: await C.setOptedOut(ids, false) };
    case "resetInvalid": {
      const patches = ids.filter((id) => contacts.get(id)?.waStatus === "invalid").map((id) => ({ id, patch: { waStatus: "unknown" } }));
      await contacts.patchMany(patches);
      return { count: patches.length };
    }
    default: throw C.fail("Unknown action");
  }
}));

api.post("/tags/rename", express.json(), h(async (req) => ({ count: await C.renameTag(String(req.body?.from ?? ""), String(req.body?.to ?? "").trim()) })));

const importBody = express.json({ limit: "25mb" });
api.post("/contacts/import/preview", importBody, h((req) => {
  const { rows, mapping, options } = req.body ?? {};
  return C.analyzeImport(rows, mapping, options);
}));
api.post("/contacts/import/commit", importBody, h((req) => {
  const { rows, mapping, options } = req.body ?? {};
  return C.commitImport(rows, mapping, options);
}));

/* ── Who a campaign would reach, and what they would read ────────────── */

api.post("/audience/preview", express.json({ limit: "5mb" }), h((req) => {
  const { audience, message } = req.body ?? {};
  const { eligible, excluded } = C.resolveAudience(audience);
  const settings = getSettings();
  return {
    count: eligible.length,
    excluded,
    sample: eligible.slice(0, 8).map((c) => ({ id: c.id, name: c.name, company: c.company, phone: c.phone })),
    missing: message ? missingVarCounts(message, eligible) : [],
    estimateMs: estimateDurationMs(eligible.length, settings.minDelay, settings.maxDelay),
  };
}));

api.post("/render", express.json(), h((req) => {
  const { message, contactId } = req.body ?? {};
  const settings = getSettings();
  const sample = (contactId && contacts.get(contactId)) || contacts.all()[0] || { name: "Rahul Mehta", company: "Mehta Gems", city: "Dubai", country: "AE" };
  return { text: renderMessage(message, varsForContact(sample, { business_name: settings.businessName })), contact: { id: sample.id ?? null, name: sample.name } };
}));

/* ── Campaigns ───────────────────────────────────────────────────────── */

/** An attachment as the web app sees it, with a link it can open. */
export function mediaView(m) {
  if (!m) return null;
  return { id: m.id, name: m.name, kind: m.kind, mimetype: m.mimetype, size: m.size, url: `/api/media/${m.id}?${signedMediaQuery(m.id)}` };
}

function view(c) {
  const out = {
    ...c,
    media: c.mediaId ? mediaView(mediaIndex.get(c.mediaId)) : null,
    waiting: runner.waiting?.campaignId === c.id && (c.status === "running" || c.status === "queued") ? runner.waiting : null,
    eta: estimateFinish(c),
  };
  if (!c.materialized) out.audienceCount = C.resolveAudience(c.audience).eligible.length;
  return out;
}

api.get("/campaigns", h((req) => ({ items: Camp.listCampaigns({ status: req.query.status }).map(view), speeds: SPEEDS })));
api.get("/campaigns/:id", h((req) => {
  const c = campaigns.get(req.params.id);
  if (!c) throw C.fail("Campaign not found", "NOT_FOUND", 404);
  return view(c);
}));
api.get("/campaigns/:id/recipients", h((req) => getRecipients(req.params.id, req.query)));
api.post("/campaigns", express.json({ limit: "5mb" }), h(async (req) => view(await Camp.createCampaign(req.body ?? {}))));
api.put("/campaigns/:id", express.json({ limit: "5mb" }), h(async (req) => view(await Camp.updateCampaign(req.params.id, req.body ?? {}))));
api.delete("/campaigns/:id", h(async (req) => { await Camp.deleteCampaign(req.params.id); }));
api.post("/campaigns/:id/pause", h(async (req) => view(await pauseCampaign(req.params.id))));
api.post("/campaigns/:id/resume", h(async (req) => view(await resumeCampaign(req.params.id))));
api.post("/campaigns/:id/cancel", h(async (req) => view(await cancelCampaign(req.params.id))));
api.post("/campaigns/:id/retry", h(async (req) => retryFailed(req.params.id)));
api.post("/campaigns/:id/duplicate", h(async (req) => view(await Camp.duplicateCampaign(req.params.id))));
api.post("/test-message", express.json(), h((req) => sendTest(req.body ?? {})));

/* ── Attachments ─────────────────────────────────────────────────────── */

api.post(
  "/media",
  express.raw({ type: () => true, limit: MAX_MEDIA_BYTES + 1024 }),
  h(async (req) => {
    const name = decodeURIComponent(req.get("x-file-name") ?? "file");
    const m = await saveMedia(req.body, { name, mimetype: req.get("content-type") });
    return mediaView(m);
  }),
);

api.delete("/media/:id", h(async (req) => {
  const inUse = campaigns.all().some((c) => c.mediaId === req.params.id && !Camp.FINISHED.has(c.status));
  if (!inUse) await deleteMedia(req.params.id);
  return { deleted: !inUse };
}));

/* ── Templates ───────────────────────────────────────────────────────── */

api.get("/templates", h(() => ({ items: T.listTemplates().map((t) => ({ ...t, media: t.mediaId ? mediaView(mediaIndex.get(t.mediaId)) : null })) })));
api.post("/templates", express.json(), h((req) => T.createTemplate(req.body ?? {})));
api.put("/templates/:id", express.json(), h((req) => T.updateTemplate(req.params.id, req.body ?? {})));
api.delete("/templates/:id", h(async (req) => { await T.deleteTemplate(req.params.id); }));

/* ── Inbox ───────────────────────────────────────────────────────────── */

api.get("/conversations", h((req) => ({
  items: Inbox.listConversations({ q: req.query.q, filter: req.query.filter }, (p) => contacts.get(p)).slice(0, 300),
  unread: Inbox.unreadTotal(),
})));

api.get("/conversations/:key", h(async (req) => {
  const key = req.params.key;
  const conv = conversations.get(key);
  const contact = contacts.get(key);
  if (!conv && !contact) throw C.fail("Conversation not found", "NOT_FOUND", 404);
  const messages = await Inbox.getMessages(key);
  await Inbox.markRead(key);
  return { key, conversation: conv, contact, messages };
}));

api.post("/conversations/:key/read", h(async (req) => { await Inbox.markRead(req.params.key); }));

api.post("/conversations/:key/send", express.json(), h(async (req) => {
  const key = req.params.key;
  const text = String(req.body?.text ?? "").trim();
  const mediaId = req.body?.mediaId;
  if (!text && !mediaId) throw C.fail("Type a message first");
  const conv = conversations.get(key);
  const contact = contacts.get(key);
  const phone = /^\d+$/.test(key) ? key : null;
  let media;
  if (mediaId) {
    const m = await getMedia(mediaId);
    if (!m) throw C.fail("The attached file is missing");
    media = { buffer: m.buffer, mimetype: m.meta.mimetype, fileName: m.meta.name };
  }
  const res = await wa.sendMessage({ phone, jid: conv?.jid ?? undefined, message: text, media });
  const at = Date.now();
  await Inbox.logMessage({
    phone: key, jid: conv?.jid, dir: "out", text, id: res.messageId ?? undefined, at,
    name: contact?.name ?? conv?.name, manual: true,
    mediaType: media ? (media.mimetype.startsWith("image/") ? "Photo" : media.mimetype.startsWith("video/") ? "Video" : media.fileName) : undefined,
  });
  await bump("sent");
  if (contact) await contacts.patch(key, { lastMessageAt: at, waStatus: "valid" });
  return { ok: true, messageId: res.messageId };
}));

/* ── Settings ────────────────────────────────────────────────────────── */

api.get("/settings", h(() => getSettings()));
api.put("/settings", express.json(), h((req) => updateSettings(req.body ?? {})));

/* ── Demo helpers ────────────────────────────────────────────────────── */

if (DEMO_MODE) {
  api.post("/demo/incoming", express.json(), h((req) => {
    const n = String(Math.floor(Math.random() * 9e8) + 1e8);
    wa.simulateIncoming({
      phone: req.body?.phone || `9715${n}`,
      name: req.body?.name || ["Yosef Katz", "Ahmed Al Mansoori", "Linda Chen", "Pieter Janssens"][Math.floor(Math.random() * 4)],
      text: req.body?.text || "Hello, I saw your collection at the show. Please share your catalogue and B2B prices.",
    });
  }));
}
