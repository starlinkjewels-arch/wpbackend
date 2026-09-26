/**
 * Each client's own AI-written version of a campaign message.
 *
 *   waCampaigns/{campaignId}/ai/{phone}  { text, edited, hash, at }
 *
 * One document per client, so an admin editing one message writes one
 * document. `hash` is a fingerprint of the campaign message the draft was
 * written from: when the admin changes the campaign text afterwards, drafts
 * with an old fingerprint are "outdated" — never sent as they are, rewritten
 * instead — unless the admin edited that draft by hand, which always wins.
 */
import { createHash } from "node:crypto";
import { getStore } from "../store/index.js";

const cache = new Map(); // campaignId -> Map(phone -> draft)

export function messageHash(message) {
  return createHash("sha1").update(String(message ?? "")).digest("hex").slice(0, 12);
}

export async function loadDrafts(campaignId) {
  const hit = cache.get(campaignId);
  if (hit) return hit;
  const rows = await getStore().list(`waCampaigns/${campaignId}/ai`);
  const map = new Map(rows.map(({ id, ...d }) => [id, d]));
  cache.set(campaignId, map);
  return map;
}

export async function getDraft(campaignId, phone) {
  return (await loadDrafts(campaignId)).get(phone) ?? null;
}

export async function setDraft(campaignId, phone, draft) {
  const map = await loadDrafts(campaignId);
  const doc = { text: String(draft.text ?? "").slice(0, 4000), edited: Boolean(draft.edited), hash: draft.hash ?? null, at: Date.now() };
  await getStore().setDoc(`waCampaigns/${campaignId}/ai/${phone}`, doc);
  map.set(phone, doc);
  return doc;
}

export async function removeDraft(campaignId, phone) {
  const map = await loadDrafts(campaignId);
  await getStore().deleteDoc(`waCampaigns/${campaignId}/ai/${phone}`);
  map.delete(phone);
}

export async function deleteDrafts(campaignId) {
  cache.delete(campaignId);
  await getStore().deleteCollection(`waCampaigns/${campaignId}/ai`);
}

/** Is this draft good to send for a campaign whose message has this hash? */
export function draftUsable(draft, hash) {
  return Boolean(draft?.text?.trim()) && (draft.edited || draft.hash === hash);
}
