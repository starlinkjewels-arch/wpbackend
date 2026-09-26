/**
 * Who a campaign is going to, and how each one went.
 *
 * Stored 250 to a document (waCampaigns/{id}/chunks/{n}) rather than one
 * document each. Firestore bills per document: a 2,000-client campaign is 8
 * reads to show instead of 2,000, and each send rewrites one small chunk.
 *
 * Each entry is deliberately terse — it is repeated thousands of times:
 *   p  phone (the contact id)      n  name at the time the campaign started
 *   s  "pending" | "sent" | "failed" | "skipped"
 *   e  why it failed or was skipped  t  when it was sent or failed
 *   m  WhatsApp's message id
 */
import { getStore } from "../store/index.js";

export const CHUNK_SIZE = 250;

const path = (id, n) => `waCampaigns/${id}/chunks/${n}`;

/** Loaded recipient lists, so a running campaign is read from the store once. */
const cache = new Map();
const CACHE_MAX = 6;

function remember(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (cache.get(oldest).dirty.size) break; // never drop unsaved changes
    cache.delete(oldest);
  }
}

export async function writeRecipients(id, items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) chunks.push(items.slice(i, i + CHUNK_SIZE));
  await getStore().batch(chunks.map((c, n) => ({ op: "set", path: path(id, n), data: { items: c } })));
  remember(id, { chunks, dirty: new Set() });
  return chunks.length;
}

export async function loadRecipients(id, chunkCount) {
  const hit = cache.get(id);
  if (hit) return hit;
  const chunks = [];
  for (let n = 0; n < (chunkCount ?? 0); n += 1) {
    const doc = await getStore().getDoc(path(id, n));
    chunks.push(doc?.items ?? []);
  }
  const entry = { chunks, dirty: new Set() };
  remember(id, entry);
  return entry;
}

/** Find the next recipient still to be sent. Returns a handle for updating it. */
export function nextPending(entry) {
  for (let n = 0; n < entry.chunks.length; n += 1) {
    const i = entry.chunks[n].findIndex((r) => r.s === "pending");
    if (i >= 0) return { n, i, r: entry.chunks[n][i] };
  }
  return null;
}

/** The first pending recipient `accept` says may be sent to now (local-time sending). */
export function nextPendingWhere(entry, accept) {
  for (let n = 0; n < entry.chunks.length; n += 1) {
    const i = entry.chunks[n].findIndex((r) => r.s === "pending" && accept(r));
    if (i >= 0) return { n, i, r: entry.chunks[n][i] };
  }
  return null;
}

export function findRecipient(entry, phone) {
  for (let n = 0; n < entry.chunks.length; n += 1) {
    const i = entry.chunks[n].findIndex((r) => r.p === phone);
    if (i >= 0) return { n, i, r: entry.chunks[n][i] };
  }
  return null;
}

export function updateRecipient(entry, { n, i }, patch) {
  entry.chunks[n][i] = { ...entry.chunks[n][i], ...patch };
  entry.dirty.add(n);
}

export async function flush(id) {
  const entry = cache.get(id);
  if (!entry?.dirty.size) return;
  const dirty = [...entry.dirty];
  entry.dirty.clear();
  try {
    await getStore().batch(dirty.map((n) => ({ op: "set", path: path(id, n), data: { items: entry.chunks[n] } })));
  } catch (err) {
    for (const n of dirty) entry.dirty.add(n);
    throw err;
  }
}

export function countStatuses(entry) {
  /* delivered / read / replied / optedOut come from WhatsApp receipts and
     from replies after the send (engine/tracking.js):
       d  delivered to their phone   r  read   rp  replied   oo  opted out */
  const stats = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, delivered: 0, read: 0, replied: 0, optedOut: 0 };
  for (const chunk of entry.chunks) {
    for (const r of chunk) {
      stats.total += 1;
      stats[r.s] = (stats[r.s] ?? 0) + 1;
      if (r.s !== "sent") continue;
      if (r.d || r.r) stats.delivered += 1;
      if (r.r) stats.read += 1;
      if (r.rp) stats.replied += 1;
      if (r.oo) stats.optedOut += 1;
    }
  }
  return stats;
}

export function allRecipients(entry) {
  return entry.chunks.flat();
}

/** Put some back in the queue — "retry failed". Returns how many. */
export function requeue(entry, predicate) {
  let count = 0;
  entry.chunks.forEach((chunk, n) => {
    chunk.forEach((r, i) => {
      if (predicate(r)) {
        chunk[i] = { p: r.p, n: r.n, s: "pending", retry: (r.retry ?? 0) + 1 };
        entry.dirty.add(n);
        count += 1;
      }
    });
  });
  return count;
}

export async function deleteRecipients(id) {
  cache.delete(id);
  await getStore().deleteCollection(`waCampaigns/${id}/chunks`);
}
