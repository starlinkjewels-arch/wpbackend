/**
 * What happened after a campaign message went out: delivered, read, replied,
 * opted out.
 *
 * Every send is remembered by its WhatsApp message id
 * (waMsgIndex/{id} → campaign + client), because receipts arrive later — a
 * "read" can come days after the send, long after a restart. When WhatsApp
 * reports a receipt, or the client writes back within a week, the matching
 * line in the campaign is marked and its numbers recalculated.
 */
import wa from "../wa.js";
import { campaigns, contacts, dataState } from "../data/collections.js";
import * as R from "../data/recipients.js";
import { getStore } from "../store/index.js";

const REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const recent = new Map(); // messageId -> { c, p }
const RECENT_MAX = 5000;

export async function rememberSend({ messageId, campaignId, phone }) {
  if (!messageId) return;
  recent.set(messageId, { c: campaignId, p: phone });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  await getStore().setDoc(`waMsgIndex/${messageId}`, { c: campaignId, p: phone, at: Date.now() });
}

async function lookup(messageId) {
  return recent.get(messageId) ?? (await getStore().getDoc(`waMsgIndex/${messageId}`).catch(() => null));
}

/** Mark one line of a campaign, and refresh that campaign's numbers. */
async function markRecipient(campaignId, phone, patch, onlyIfMissing) {
  const c = campaigns.get(campaignId);
  if (!c?.materialized) return false;
  const entry = await R.loadRecipients(campaignId, c.chunkCount);
  const handle = R.findRecipient(entry, phone);
  if (!handle || handle.r.s !== "sent") return false;
  if (onlyIfMissing && handle.r[onlyIfMissing]) return false;
  R.updateRecipient(entry, handle, patch);
  await R.flush(campaignId);
  await campaigns.patch(campaignId, { stats: R.countStatuses(entry) });
  return true;
}

export async function handleStatus({ id, status }) {
  if (!dataState.ready) return;
  const hit = await lookup(id);
  if (!hit) return;
  const now = Date.now();
  if (status >= 4) await markRecipient(hit.c, hit.p, { r: now }, "r");
  else if (status === 3) await markRecipient(hit.c, hit.p, { d: now }, "d");
  // The inbox shows the same ticks WhatsApp does.
  await getStore()
    .mergeDoc(`waConversations/${hit.p}/messages/${id}`, { status: status >= 4 ? "read" : "delivered" })
    .catch(() => {});
}

/**
 * A client wrote to us. Counts as a reply to the last campaign they got, if
 * that was within a week, and resets their "ignored campaigns" count.
 */
export async function noteReply(contact, at = Date.now(), { optedOut = false } = {}) {
  if (!contact) return;
  if (contact.campaignsSinceReply) await contacts.patch(contact.id, { campaignsSinceReply: 0 });
  if (!contact.lastCampaignId || at - (contact.lastCampaignAt ?? 0) > REPLY_WINDOW_MS) return;
  if (optedOut) await markRecipient(contact.lastCampaignId, contact.id, { oo: at }, "oo");
  else await markRecipient(contact.lastCampaignId, contact.id, { rp: at }, "rp");
}

export function startTracking() {
  wa.onStatus?.((s) => handleStatus(s).catch((err) => console.error("[tracking] receipt not recorded:", err.message)));
}
