/**
 * The campaign runner: the one loop that actually sends.
 *
 * Every second it asks, in this order, and stops at the first "no":
 *   1. Is a campaign running, or one due to start?
 *   2. Is WhatsApp connected?           — if not, wait; nothing is marked failed
 *   3. Is it inside sending hours?      — if not, wait until they open
 *   4. Is today's cap still unreached?  — if not, wait until tomorrow
 *   5. Has the random gap since the last message passed?
 * …then sends to exactly one client, records how it went, and picks the next
 * random gap.
 *
 * Everything it needs to resume is in the store, so a restart — a redeploy, a
 * host putting the process to sleep — picks up at the next unsent client. The
 * one message that might have been mid-send when the process died is covered by
 * the send claim (sendOnce.js): its id is stable per campaign and client, so a
 * resend of a message that did go out is answered "already sent", not repeated.
 */
import wa from "../wa.js";
import { campaigns, contacts, dataState } from "../data/collections.js";
import * as R from "../data/recipients.js";
import { resolveAudience, fail } from "../data/contacts.js";
import { getSettings } from "../data/settings.js";
import { renderMessage, varsForContact } from "./personalize.js";
import { inWindow, nextWindowOpen, randomGapMs, localParts } from "./rules.js";
import { sentToday, bump } from "../data/stats.js";
import { getMedia } from "../data/media.js";
import { logMessage } from "../data/inbox.js";

/** What the runner is doing, for the dashboard. Never persisted. */
export const runner = {
  activeId: null,
  /** { campaignId, code, reason, until? } — why nothing is being sent right now. */
  waiting: null,
  nextSendAt: 0,
};

const TICK_MS = 1000;
/** A run of failures this long is not bad luck; stop and let a person look. */
const MAX_CONSECUTIVE_ERRORS = 5;

let busy = false;
let consecutiveErrors = 0;
let interval = null;

export function startRunner() {
  if (interval) return;
  interval = setInterval(tick, TICK_MS);
}

export function stopRunner() {
  clearInterval(interval);
  interval = null;
}

async function tick() {
  if (busy || !dataState.ready) return;
  busy = true;
  try {
    await step(Date.now());
  } catch (err) {
    console.error("[runner] step failed:", err.message);
    runner.waiting = { campaignId: runner.activeId, code: "error", reason: err.message };
  } finally {
    busy = false;
  }
}

/** Exposed for tests: one pass of the loop. */
export async function runOnce(now = Date.now()) {
  if (busy) return;
  busy = true;
  try {
    await step(now);
  } finally {
    busy = false;
  }
}

function wait(campaignId, code, reason, until) {
  runner.waiting = { campaignId, code, reason, ...(until ? { until } : null) };
}

async function step(now) {
  const all = campaigns.all();
  let active = all.filter((c) => c.status === "running").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
  const due = all
    .filter((c) => (c.status === "scheduled" || c.status === "queued") && (c.scheduledAt ?? 0) <= now)
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));

  if (!active) {
    if (!due.length) {
      runner.activeId = null;
      runner.waiting = null;
      return;
    }
    active = await begin(due.shift(), now);
    if (active?.status !== "running") return;
  }
  // Due but blocked behind the running one: say so on its card.
  for (const c of due) if (c.status === "scheduled") await campaigns.patch(c.id, { status: "queued" });

  runner.activeId = active.id;
  const settings = getSettings();

  if (wa.state.status !== "connected") {
    return wait(active.id, "disconnected", wa.state.halted ? `WhatsApp stopped: ${wa.state.lastError}` : "Waiting for WhatsApp to connect");
  }
  if (!inWindow(now, settings.window, settings.timezone)) {
    return wait(active.id, "window", `Outside sending hours (${settings.window.start}–${settings.window.end})`, nextWindowOpen(now, settings.window, settings.timezone));
  }
  if (sentToday(now) >= settings.dailyLimit) {
    const { minutes } = localParts(now, settings.timezone);
    return wait(active.id, "limit", `Daily limit of ${settings.dailyLimit} messages reached`, now - (now % 60000) + (1440 - minutes) * 60000);
  }
  if (now < runner.nextSendAt) {
    return wait(active.id, "gap", "Pausing between messages", runner.nextSendAt);
  }

  runner.waiting = null;
  const entry = await R.loadRecipients(active.id, active.chunkCount);
  const next = R.nextPending(entry);
  if (!next) return finish(active.id, entry);
  await sendOne(active, entry, next, settings);
}

/** A campaign's time has come: work out who it goes to, and freeze that list. */
async function begin(c, now) {
  // Already has its list: a resume, or a restart that died right after
  // freezing it. Never rebuild — that would re-queue everyone already sent.
  if (c.materialized) {
    return campaigns.patch(c.id, { status: "running", startedAt: c.startedAt ?? now });
  }
  const { eligible } = resolveAudience(c.audience);
  const items = eligible.map((ct) => ({ p: ct.id, n: ct.name || "", s: "pending" }));
  const chunkCount = await R.writeRecipients(c.id, items);
  const stats = { total: items.length, pending: items.length, sent: 0, failed: 0, skipped: 0 };
  if (!items.length) {
    return campaigns.patch(c.id, {
      status: "completed", materialized: true, chunkCount, stats, startedAt: now, finishedAt: now,
      note: "No clients matched when it was time to send",
    });
  }
  consecutiveErrors = 0;
  runner.nextSendAt = 0;
  console.log(`[runner] starting "${c.name}" — ${items.length} clients`);
  return campaigns.patch(c.id, { status: "running", materialized: true, chunkCount, stats, startedAt: now });
}

async function save(id, entry) {
  await R.flush(id);
  await campaigns.patch(id, { stats: R.countStatuses(entry), updatedAt: Date.now() });
}

async function finish(id, entry) {
  await R.flush(id);
  const stats = R.countStatuses(entry);
  await campaigns.patch(id, { status: "completed", stats, finishedAt: Date.now(), updatedAt: Date.now() });
  runner.activeId = null;
  runner.waiting = null;
  console.log(`[runner] finished campaign — sent ${stats.sent}, failed ${stats.failed}, skipped ${stats.skipped}`);
}

function mediaLabel(meta) {
  if (!meta) return undefined;
  return meta.kind === "image" ? "Photo" : meta.kind === "video" ? "Video" : meta.name;
}

async function sendOne(c, entry, handle, settings) {
  const now = Date.now();
  const contact = contacts.get(handle.r.p);

  /* Checked again at send time, not only when the list was frozen: a client
     who replied STOP an hour into an eight-hour campaign must not get it. */
  const skip = !contact ? "Client was deleted" : contact.optedOut ? "Opted out" : contact.waStatus === "invalid" ? "Not on WhatsApp" : null;
  if (skip) {
    R.updateRecipient(entry, handle, { s: "skipped", e: skip, t: now });
    return save(c.id, entry);
  }

  let media = null;
  if (c.mediaId) {
    try {
      media = await getMedia(c.mediaId);
    } catch (err) {
      media = null;
      console.error("[runner] attachment unreadable:", err.message);
    }
    if (!media) return pause(c.id, "The attached file could not be loaded — it may have been deleted");
  }

  const text = renderMessage(c.message, varsForContact(contact, { business_name: settings.businessName }));
  try {
    const res = await wa.sendMessage({
      phone: contact.phone,
      message: text,
      media: media ? { buffer: media.buffer, mimetype: media.meta.mimetype, fileName: media.meta.name } : undefined,
      clientMessageId: `c_${c.id}_${contact.phone}`,
    });
    R.updateRecipient(entry, handle, { s: "sent", t: Date.now(), m: res.messageId ?? null, ...(res.acknowledged ? null : { e: "Sent, not yet confirmed by WhatsApp" }) });
    consecutiveErrors = 0;
    await bump("sent");
    await contacts.patch(contact.id, { waStatus: "valid", lastCampaignAt: now, lastMessageAt: now });
    await logMessage({
      phone: contact.phone, dir: "out", text, id: res.messageId ?? undefined, campaignId: c.id,
      name: contact.name, mediaType: mediaLabel(media?.meta),
    }).catch((e) => console.error("[runner] could not log to inbox:", e.message));
    runner.nextSendAt = Date.now() + randomGapMs(c.minDelay, c.maxDelay);
  } catch (err) {
    if (err.code === "NOT_CONNECTED") {
      // Nothing was sent. The client stays in the queue for when it reconnects.
      return wait(c.id, "disconnected", "Waiting for WhatsApp to connect");
    }
    if (err.code === "IN_FLIGHT") {
      runner.nextSendAt = Date.now() + 30000;
      return;
    }
    if (err.code === "NOT_ON_WHATSAPP") {
      R.updateRecipient(entry, handle, { s: "failed", e: "Not on WhatsApp", t: Date.now() });
      await contacts.patch(contact.id, { waStatus: "invalid" });
      // Only a lookup was made, not a send; a short gap is enough.
      runner.nextSendAt = Date.now() + 3000;
    } else {
      consecutiveErrors += 1;
      R.updateRecipient(entry, handle, { s: "failed", e: err.message?.slice(0, 200) || "Failed", t: Date.now() });
      runner.nextSendAt = Date.now() + randomGapMs(c.minDelay, c.maxDelay);
    }
    await bump("failed");
    await save(c.id, entry);
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return pause(c.id, `Stopped after ${MAX_CONSECUTIVE_ERRORS} failures in a row. Last error: ${err.message}`);
    }
    return;
  }
  await save(c.id, entry);
}

async function pause(id, reason) {
  await R.flush(id);
  await campaigns.patch(id, { status: "paused", pausedReason: reason, updatedAt: Date.now() });
  if (runner.activeId === id) runner.activeId = null;
  console.warn(`[runner] paused campaign${reason ? `: ${reason}` : " (by the user)"}`);
}

/* ── Controls, from the campaign page ────────────────────────────────── */

function need(id) {
  const c = campaigns.get(id);
  if (!c) throw fail("Campaign not found", "NOT_FOUND", 404);
  return c;
}

export async function pauseCampaign(id) {
  const c = need(id);
  if (!["running", "queued", "scheduled"].includes(c.status)) throw fail("Only a sending or scheduled campaign can be paused", "BAD_STATE", 409);
  await pause(id, null);
  return campaigns.get(id);
}

export async function resumeCampaign(id) {
  const c = need(id);
  if (c.status !== "paused") throw fail("This campaign is not paused", "BAD_STATE", 409);
  consecutiveErrors = 0;
  if (!c.materialized) {
    // Paused before its time came: back to waiting for that time.
    return campaigns.patch(id, { status: "scheduled", pausedReason: null, updatedAt: Date.now() });
  }
  return campaigns.patch(id, { status: "queued", scheduledAt: Math.min(c.scheduledAt ?? Date.now(), Date.now()), pausedReason: null, updatedAt: Date.now() });
}

export async function cancelCampaign(id) {
  const c = need(id);
  if (["completed", "cancelled"].includes(c.status)) throw fail("This campaign has already finished", "BAD_STATE", 409);
  if (c.materialized) await R.flush(id);
  await campaigns.patch(id, { status: "cancelled", finishedAt: Date.now(), updatedAt: Date.now() });
  if (runner.activeId === id) runner.activeId = null;
  return campaigns.get(id);
}

/** Failed sends go back in the queue. "Not on WhatsApp" is not retried: no
 *  retry changes that answer. */
export async function retryFailed(id) {
  const c = need(id);
  if (!c.materialized) throw fail("Nothing has been sent yet", "BAD_STATE", 409);
  if (c.status === "running") throw fail("Wait for the campaign to finish or pause it first", "BAD_STATE", 409);
  const entry = await R.loadRecipients(id, c.chunkCount);
  const count = R.requeue(entry, (r) => r.s === "failed" && r.e !== "Not on WhatsApp");
  if (!count) throw fail("There are no failed messages that can be retried", "NOTHING", 409);
  await R.flush(id);
  await campaigns.patch(id, {
    status: "queued", scheduledAt: Date.now(), stats: R.countStatuses(entry), finishedAt: null, pausedReason: null, updatedAt: Date.now(),
  });
  return { count };
}

export async function getRecipients(id, { status = "all", q = "", page = 1, pageSize = 100 } = {}) {
  const c = need(id);
  if (!c.materialized) {
    // Not frozen yet: show who it WOULD go to now.
    const { eligible } = resolveAudience(c.audience);
    const items = eligible.map((ct) => ({ p: ct.id, n: ct.name, s: "pending" }));
    return paginate(items, { status, q, page, pageSize });
  }
  const entry = await R.loadRecipients(id, c.chunkCount);
  return paginate(R.allRecipients(entry), { status, q, page, pageSize });
}

function paginate(items, { status, q, page, pageSize }) {
  const query = String(q).trim().toLowerCase();
  const filtered = items.filter(
    (r) => (status === "all" || r.s === status) && (!query || `${r.n} ${r.p}`.toLowerCase().includes(query)),
  );
  const size = Math.min(500, Math.max(1, Number(pageSize) || 100));
  const p = Math.max(1, Number(page) || 1);
  return {
    total: filtered.length,
    page: p,
    pageSize: size,
    items: filtered.slice((p - 1) * size, p * size).map((r) => {
      const ct = contacts.get(r.p);
      return { phone: r.p, name: ct?.name || r.n || "", company: ct?.company || "", status: r.s, error: r.e ?? null, at: r.t ?? null };
    }),
  };
}

/** A rough finish time for a running campaign, for the progress card. */
export function estimateFinish(c) {
  if (c.status !== "running" && c.status !== "queued") return null;
  const pending = c.stats?.pending ?? 0;
  if (!pending) return null;
  const avg = ((c.minDelay + c.maxDelay) / 2 + 2) * 1000;
  return Date.now() + pending * avg;
}

/**
 * Send one message to the business's own number (or any number), exactly as
 * a client would receive it. Nothing is recorded against the campaign.
 */
export async function sendTest({ message, mediaId, contactId, to }) {
  const settings = getSettings();
  const target = String(to || wa.state.phone || "").replace(/\D/g, "");
  if (!target) throw fail("Connect WhatsApp first — the test is sent to your own number", "NOT_CONNECTED", 409);
  const sample = (contactId && contacts.get(contactId)) || contacts.all()[0] || { name: "Rahul Mehta", company: "Mehta Gems" };
  const text = renderMessage(message, varsForContact(sample, { business_name: settings.businessName }));
  let media;
  if (mediaId) {
    const m = await getMedia(mediaId);
    if (!m) throw fail("The attached file is missing — attach it again");
    media = { buffer: m.buffer, mimetype: m.meta.mimetype, fileName: m.meta.name };
  }
  const res = await wa.sendMessage({ phone: target, message: `${text}`, media });
  await bump("sent");
  return { ...res, to: target, text };
}
