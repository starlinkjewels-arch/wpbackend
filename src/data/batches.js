/**
 * Client batches: a named, hand-picked list of clients — "Dubai VIP buyers",
 * "HK show leads Oct 2026" — with a record of every broadcast sent to it.
 *
 *   waBatches/{id}  { name, description, color, contactIds[], createdAt, updatedAt }
 *
 * Unlike a tag, a batch is a deliberate list with its own identity: it has a
 * description, a colour, and a history. The history is not stored twice — it
 * is every broadcast whose audience named this batch, read from the
 * broadcasts themselves, so it can never disagree with what was really sent.
 */
import { batches, contacts, campaigns, newId } from "./collections.js";
import { fail } from "./contacts.js";

export const MAX_MEMBERS = 20000;
export const COLORS = ["violet", "blue", "pink", "amber", "emerald", "cyan", "rose", "slate"];

function cleanColor(c) {
  return COLORS.includes(c) ? c : "violet";
}

function need(id) {
  const b = batches.get(id);
  if (!b) throw fail("Batch not found", "NOT_FOUND", 404);
  return b;
}

/** Members who still exist — a deleted client silently leaves every batch. */
export function liveMembers(b) {
  return (b.contactIds ?? []).filter((id) => contacts.has(id));
}

/** Broadcasts that went (or will go) to this batch, newest first. */
export function batchCampaigns(id) {
  return campaigns
    .all()
    .filter((c) => c.audience?.mode === "batch" && (c.audience.batchIds ?? []).includes(id))
    .sort((a, b) => (b.startedAt ?? b.scheduledAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.scheduledAt ?? a.createdAt ?? 0));
}

function totals(list) {
  const t = { broadcasts: list.length, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, optedOut: 0 };
  for (const c of list) {
    for (const k of ["sent", "delivered", "read", "replied", "failed", "optedOut"]) t[k] += c.stats?.[k] ?? 0;
  }
  return t;
}

export function summary(b) {
  const history = batchCampaigns(b.id);
  const sentOnes = history.filter((c) => c.materialized);
  const last = sentOnes[0];
  return {
    id: b.id,
    name: b.name,
    description: b.description ?? "",
    color: b.color ?? "violet",
    members: liveMembers(b).length,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    lastSentAt: last ? last.startedAt ?? last.scheduledAt ?? null : null,
    lastBroadcastName: last?.name ?? null,
    scheduled: history.filter((c) => ["scheduled", "queued", "running"].includes(c.status)).length,
    totals: totals(sentOnes),
  };
}

export function listBatches({ q = "" } = {}) {
  const query = String(q).trim().toLowerCase();
  return batches
    .all()
    .filter((b) => !query || `${b.name} ${b.description ?? ""}`.toLowerCase().includes(query))
    .map(summary)
    .sort((a, b) => (b.lastSentAt ?? b.updatedAt ?? 0) - (a.lastSentAt ?? a.updatedAt ?? 0));
}

/**
 * One batch in full: its members (with what each did after the latest
 * broadcast) and its history.
 */
export function batchDetail(id) {
  const b = need(id);
  const history = batchCampaigns(id);
  const members = liveMembers(b).map((cid) => {
    const c = contacts.get(cid);
    return {
      id: c.id,
      phone: c.phone,
      name: c.name,
      company: c.company,
      country: c.country,
      tags: c.tags ?? [],
      optedOut: Boolean(c.optedOut),
      waStatus: c.waStatus,
      lastInboundAt: c.lastInboundAt ?? null,
      lastCampaignAt: c.lastCampaignAt ?? null,
    };
  });
  return {
    ...summary(b),
    members,
    removedMembers: (b.contactIds ?? []).length - members.length,
    history: history.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      message: c.message,
      mediaId: c.mediaId ?? null,
      aiPersonalize: Boolean(c.ai?.personalize),
      batchCount: (c.audience.batchIds ?? []).length,
      createdAt: c.createdAt,
      scheduledAt: c.scheduledAt ?? null,
      startedAt: c.startedAt ?? null,
      finishedAt: c.finishedAt ?? null,
      stats: c.stats ?? null,
      audienceCount: c.stats?.total ?? null,
    })),
  };
}

function cleanIds(ids) {
  return [...new Set((ids ?? []).map(String))].filter((id) => contacts.has(id));
}

export async function createBatch({ name, description, color, contactIds }) {
  const n = String(name ?? "").trim().slice(0, 80);
  if (!n) throw fail("Give the batch a name");
  if (batches.all().some((b) => b.name.toLowerCase() === n.toLowerCase())) throw fail(`A batch called "${n}" already exists`, "EXISTS", 409);
  const ids = cleanIds(contactIds);
  if (ids.length > MAX_MEMBERS) throw fail(`A batch can hold up to ${MAX_MEMBERS.toLocaleString()} clients`);
  const now = Date.now();
  const b = await batches.put(newId("b"), {
    name: n,
    description: String(description ?? "").slice(0, 500),
    color: cleanColor(color),
    contactIds: ids,
    createdAt: now,
    updatedAt: now,
  });
  return summary(b);
}

export async function updateBatch(id, { name, description, color }) {
  const b = need(id);
  const patch = { updatedAt: Date.now() };
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 80);
    if (!n) throw fail("Give the batch a name");
    if (batches.all().some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw fail(`A batch called "${n}" already exists`, "EXISTS", 409);
    patch.name = n;
  }
  if (description !== undefined) patch.description = String(description).slice(0, 500);
  if (color !== undefined) patch.color = cleanColor(color);
  return summary(await batches.patch(b.id, patch));
}

export async function addMembers(id, ids) {
  const b = need(id);
  const current = new Set(b.contactIds ?? []);
  const incoming = cleanIds(ids).filter((x) => !current.has(x));
  const next = [...current, ...incoming];
  if (next.length > MAX_MEMBERS) throw fail(`A batch can hold up to ${MAX_MEMBERS.toLocaleString()} clients`);
  await batches.patch(id, { contactIds: next, updatedAt: Date.now() });
  return { added: incoming.length, members: liveMembers({ contactIds: next }).length };
}

export async function removeMembers(id, ids) {
  const b = need(id);
  const drop = new Set((ids ?? []).map(String));
  const next = (b.contactIds ?? []).filter((x) => !drop.has(x));
  await batches.patch(id, { contactIds: next, updatedAt: Date.now() });
  return { removed: (b.contactIds ?? []).length - next.length, members: liveMembers({ contactIds: next }).length };
}

/** Deleting a batch keeps its broadcasts; they still show which batch they went to, by name. */
export async function deleteBatch(id) {
  need(id);
  await batches.remove(id);
}

/** The batches a client belongs to, for their card. */
export function batchesOf(contactId) {
  return batches
    .all()
    .filter((b) => (b.contactIds ?? []).includes(contactId))
    .map((b) => ({ id: b.id, name: b.name, color: b.color ?? "violet" }));
}

/** A client's number changed, so their id did: keep them in their batches. */
export async function renameMember(oldId, newId) {
  const patches = batches
    .all()
    .filter((b) => (b.contactIds ?? []).includes(oldId))
    .map((b) => ({ id: b.id, patch: { contactIds: b.contactIds.map((x) => (x === oldId ? newId : x)) } }));
  if (patches.length) await batches.patchMany(patches);
}

/** For the audience: every live member of these batches. */
export function batchMemberIds(batchIds) {
  const ids = new Set();
  for (const id of batchIds ?? []) {
    const b = batches.get(id);
    if (b) for (const cid of liveMembers(b)) ids.add(cid);
  }
  return [...ids];
}

export function batchNames(batchIds) {
  return (batchIds ?? []).map((id) => batches.get(id)?.name).filter(Boolean);
}
