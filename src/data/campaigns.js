/**
 * Campaigns: one message, sent to many clients, one at a time.
 *
 * Status, and who moves it:
 *
 *   draft ──schedule──> scheduled ──(time comes)──> running ──> completed
 *                           │                        │  ▲
 *                           │         another is running → queued
 *                           └────── pause ──> paused ─┴──┘ resume
 *   any unfinished ──cancel──> cancelled
 *
 * Only one campaign runs at a time — it is one phone number, and two
 * campaigns interleaving would just be one campaign sent twice as fast. The
 * runner (engine/runner.js) does the sending; this file is the records.
 */
import { campaigns, mediaIndex, newId } from "./collections.js";
import { getSettings } from "./settings.js";
import { fail, splitTags, resolveAudience } from "./contacts.js";
import { deleteRecipients } from "./recipients.js";

/** Can still be changed: nothing has been sent. */
export const EDITABLE = new Set(["draft", "scheduled"]);
export const FINISHED = new Set(["completed", "cancelled"]);

const clamp = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function cleanAudience(a = {}) {
  const mode = ["all", "tags", "contacts"].includes(a.mode) ? a.mode : "all";
  return {
    mode,
    tags: mode === "tags" ? splitTags(a.tags ?? []) : [],
    tagMatch: a.tagMatch === "all" ? "all" : "any",
    contactIds: mode === "contacts" ? [...new Set((a.contactIds ?? []).map(String))].slice(0, 50000) : [],
    excludeTags: splitTags(a.excludeTags ?? []),
  };
}

function defaultName(now) {
  const d = new Date(now);
  return `Campaign · ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: getSettings().timezone })}`;
}

function clean(input, prev = {}) {
  const settings = getSettings();
  const now = Date.now();
  const merged = { ...prev, ...input };
  const message = String(merged.message ?? "").slice(0, 4000);
  const mediaId = merged.mediaId || null;
  if (mediaId && !mediaIndex.has(mediaId)) throw fail("The attached file is missing — attach it again");
  let minDelay = clamp(merged.minDelay, 3, 600, settings.minDelay);
  let maxDelay = clamp(merged.maxDelay, 3, 900, settings.maxDelay);
  if (maxDelay < minDelay) [minDelay, maxDelay] = [maxDelay, minDelay];
  return {
    name: String(merged.name ?? "").trim().slice(0, 100) || prev.name || defaultName(now),
    message,
    mediaId,
    audience: cleanAudience(merged.audience),
    minDelay,
    maxDelay,
    scheduledAt: merged.scheduledAt ? Number(merged.scheduledAt) : null,
  };
}

/** What must be true before a campaign may be scheduled. Messages in words. */
function checkReady(c) {
  if (!c.message.trim() && !c.mediaId) throw fail("Write a message or attach a file");
  const { eligible } = resolveAudience(c.audience);
  if (!eligible.length) throw fail("No clients to send to — choose who should receive this campaign", "NO_AUDIENCE");
}

/**
 * @param input  fields, plus `action`: "draft" to save, "schedule" to queue it.
 *               With "schedule", `sendAt` is a time (ms) or absent for "now".
 */
export async function createCampaign(input) {
  const now = Date.now();
  const doc = clean(input);
  let status = "draft";
  if (input.action === "schedule") {
    checkReady(doc);
    doc.scheduledAt = scheduleTime(input.sendAt, now);
    status = "scheduled";
  }
  return campaigns.put(newId("c"), {
    ...doc,
    status,
    stats: null,
    createdAt: now,
    updatedAt: now,
  });
}

function scheduleTime(sendAt, now) {
  if (!sendAt) return now;
  const at = Number(sendAt);
  if (!Number.isFinite(at)) throw fail("Pick a date and time to send");
  // A minute's grace: the form was filled in a moment ago.
  if (at < now - 60000) throw fail("That time has already passed — pick a time in the future");
  if (at > now + 366 * 86400000) throw fail("Schedule within the next year");
  return Math.max(at, now);
}

export async function updateCampaign(id, input) {
  const prev = campaigns.get(id);
  if (!prev) throw fail("Campaign not found", "NOT_FOUND", 404);
  if (!EDITABLE.has(prev.status) && !(prev.status === "paused" && !prev.materialized)) {
    throw fail("This campaign has started sending and can no longer be edited — duplicate it instead", "LOCKED", 409);
  }
  const now = Date.now();
  const doc = clean(input, prev);
  let status = prev.status;
  if (input.action === "schedule") {
    checkReady(doc);
    doc.scheduledAt = scheduleTime(input.sendAt, now);
    status = "scheduled";
  } else if (input.action === "draft") {
    status = "draft";
  }
  return campaigns.put(id, { ...prev, ...doc, status, pausedReason: null, updatedAt: now });
}

const ORDER = { running: 0, queued: 1, paused: 2, scheduled: 3, draft: 4, completed: 5, cancelled: 6 };

export function listCampaigns({ status } = {}) {
  return campaigns
    .all()
    .filter((c) => !status || status === "all" || c.status === status || (status === "active" && !FINISHED.has(c.status) && c.status !== "draft"))
    .sort(
      (a, b) =>
        (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
        (a.status === "scheduled" ? (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    );
}

export async function duplicateCampaign(id) {
  const prev = campaigns.get(id);
  if (!prev) throw fail("Campaign not found", "NOT_FOUND", 404);
  const now = Date.now();
  return campaigns.put(newId("c"), {
    ...clean({ ...prev, name: `${prev.name} (copy)`.slice(0, 100), scheduledAt: null }),
    status: "draft",
    stats: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteCampaign(id) {
  const c = campaigns.get(id);
  if (!c) return;
  if (c.status === "running") throw fail("Pause or cancel the campaign before deleting it", "RUNNING", 409);
  await deleteRecipients(id);
  await campaigns.remove(id);
}
