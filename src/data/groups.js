/**
 * WhatsApp groups this number is in.
 *
 * WhatsApp owns the list; the app keeps a copy (waGroups/{jid}) so the page
 * loads instantly and so the business can add what WhatsApp has no place for:
 * tags ("Buyers", "Dubai") to broadcast to several groups at once. A sync
 * refreshes names, sizes and admin rights and keeps the tags. A group the
 * number has left stays, marked, so old broadcasts still read sensibly.
 */
import wa from "../wa.js";
import { groups, contacts } from "./collections.js";
import { fail, splitTags, uniqTags } from "./contacts.js";
import { normalizePhone } from "../phone.js";
import { bump } from "./stats.js";

let lastSync = 0;
let syncing = null;

export async function syncGroups() {
  if (syncing) return syncing;
  syncing = (async () => {
    const live = await wa.listGroups();
    const now = Date.now();
    const seen = new Set(live.map((g) => g.id));
    const writes = live.map((g) => {
      const prev = groups.get(g.id);
      return {
        ...g,
        tags: prev?.tags ?? [],
        note: prev?.note ?? "",
        lastPostAt: prev?.lastPostAt ?? null,
        left: false,
        syncedAt: now,
        firstSeenAt: prev?.firstSeenAt ?? now,
      };
    });
    const gone = groups.all().filter((g) => !seen.has(g.id) && !g.left).map((g) => ({ ...g, left: true, canSend: false, syncedAt: now }));
    await groups.putMany([...writes, ...gone]);
    lastSync = now;
    return { count: live.length, left: gone.length, syncedAt: now };
  })();
  try {
    return await syncing;
  } finally {
    syncing = null;
  }
}

export function lastSyncedAt() {
  return lastSync || Math.max(0, ...groups.all().map((g) => g.syncedAt ?? 0));
}

/** List view: no member lists, they can be long. */
export function listGroups({ q = "", tag = "", show = "active" } = {}) {
  const query = String(q).trim().toLowerCase();
  return groups
    .all()
    .filter((g) => (show === "all" ? true : show === "left" ? g.left : !g.left))
    .filter((g) => !tag || (g.tags ?? []).some((t) => t.toLowerCase() === String(tag).toLowerCase()))
    .filter((g) => !query || `${g.name} ${(g.tags ?? []).join(" ")}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.canSend) - Number(a.canSend) || (b.size ?? 0) - (a.size ?? 0))
    .map(({ members, ...g }) => ({ ...g, memberPhones: (members ?? []).filter((m) => m.phone && !m.me).length }));
}

export function groupTags() {
  const counts = new Map();
  for (const g of groups.all()) {
    if (g.left) continue;
    for (const t of g.tags ?? []) {
      const k = t.toLowerCase();
      counts.set(k, { tag: t, count: (counts.get(k)?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function groupDetail(id) {
  const g = groups.get(id);
  if (!g) throw fail("Group not found", "NOT_FOUND", 404);
  return {
    ...g,
    members: (g.members ?? [])
      .filter((m) => !m.me)
      .map((m) => {
        const c = m.phone ? contacts.get(m.phone) : null;
        return { phone: m.phone, admin: m.admin, clientName: c?.name ?? null, isClient: Boolean(c) };
      }),
  };
}

export async function updateGroup(id, { tags, note }) {
  if (!groups.has(id)) throw fail("Group not found", "NOT_FOUND", 404);
  const patch = {};
  if (tags !== undefined) patch.tags = splitTags(tags);
  if (note !== undefined) patch.note = String(note).slice(0, 500);
  return groups.patch(id, patch);
}

/**
 * Save a group's members as clients — the fastest way to turn a buyers'
 * group into a client list. Members already saved only get the new tags.
 * Members WhatsApp shows without a number (privacy) cannot be saved.
 */
export async function importMembers(id, { tags = [] } = {}) {
  const g = groups.get(id);
  if (!g) throw fail("Group not found", "NOT_FOUND", 404);
  const addTags = uniqTags([...splitTags(tags)]);
  const now = Date.now();
  const writes = [];
  let added = 0;
  let updated = 0;
  let hidden = 0;
  for (const m of g.members ?? []) {
    if (m.me) continue;
    if (!m.phone) {
      hidden += 1;
      continue;
    }
    const prev = contacts.get(m.phone);
    if (prev) {
      const next = uniqTags([...(prev.tags ?? []), ...addTags]);
      if (next.length !== (prev.tags ?? []).length) {
        writes.push({ ...prev, tags: next, updatedAt: now });
        updated += 1;
      }
      continue;
    }
    writes.push({
      id: m.phone, phone: m.phone, name: "", company: "", email: "", city: "",
      country: normalizePhone("+" + m.phone).country ?? "",
      tags: addTags, notes: `Member of the WhatsApp group “${g.name}”`, fields: {},
      optedOut: false, waStatus: "valid", source: "group", createdAt: now, updatedAt: now,
    });
    added += 1;
  }
  await contacts.putMany(writes);
  if (added) await bump("newContacts", added).catch(() => {});
  return { added, updated, hidden };
}

/** Groups a broadcast may go to: still a member, and allowed to post. */
export function resolveGroups(audience = {}) {
  const ids = new Set((audience.groupIds ?? []).map(String));
  const tags = splitTags(audience.groupTags ?? []).map((t) => t.toLowerCase());
  const picked = groups.all().filter((g) => ids.has(g.id) || (g.tags ?? []).some((t) => tags.includes(t.toLowerCase())));
  const eligible = [];
  const excluded = { left: 0, cannotSend: 0 };
  for (const g of picked) {
    if (g.left) excluded.left += 1;
    else if (!g.canSend) excluded.cannotSend += 1;
    else eligible.push({ id: g.id, name: g.name, kind: "group", size: g.size });
  }
  return { eligible, excluded };
}

export function recentlySynced(maxAgeMs = 10 * 60 * 1000) {
  return Date.now() - lastSyncedAt() < maxAgeMs;
}
