/**
 * Every record the app lists, held in memory and written through to the store.
 *
 * Why a cache: Firestore bills by the document read, and the free tier is 50k
 * reads a day. A client list of 5,000 read on every page load is ten page
 * loads. This process is the only writer — WhatsApp allows one linked session,
 * so only one copy of this service can run — which makes a write-through cache
 * exact rather than approximate: read everything once at boot, then serve from
 * memory and write each change to both.
 *
 * Collection names all start with "wa". The database is shared with the
 * billing app, and a collection called "contacts" or "settings" there is a
 * collision waiting to happen.
 */
import { getStore } from "../store/index.js";

export class CachedCollection {
  constructor(path) {
    this.path = path;
    this.map = new Map();
    this.loaded = false;
  }

  async load() {
    const rows = await getStore().list(this.path);
    this.map.clear();
    for (const row of rows) this.map.set(row.id, row);
    this.loaded = true;
  }

  get size() {
    return this.map.size;
  }

  all() {
    return [...this.map.values()];
  }

  get(id) {
    return this.map.get(String(id)) ?? null;
  }

  has(id) {
    return this.map.has(String(id));
  }

  /* Store first, cache second: if the write fails the cache still says what
     the database says, and the caller gets the error. */
  async put(id, data) {
    const doc = { ...data, id: String(id) };
    await getStore().setDoc(`${this.path}/${id}`, doc);
    this.map.set(String(id), doc);
    return doc;
  }

  async patch(id, patch) {
    const prev = this.get(id);
    if (!prev) return null;
    const doc = { ...prev, ...patch, id: String(id) };
    await getStore().mergeDoc(`${this.path}/${id}`, patch);
    this.map.set(String(id), doc);
    return doc;
  }

  async remove(id) {
    await getStore().deleteDoc(`${this.path}/${id}`);
    this.map.delete(String(id));
  }

  async putMany(docs) {
    const withIds = docs.map((d) => ({ ...d, id: String(d.id) }));
    await getStore().batch(withIds.map((d) => ({ op: "set", path: `${this.path}/${d.id}`, data: d })));
    for (const d of withIds) this.map.set(d.id, d);
    return withIds;
  }

  async patchMany(patches) {
    const live = patches.filter(({ id }) => this.has(id));
    await getStore().batch(live.map(({ id, patch }) => ({ op: "merge", path: `${this.path}/${id}`, data: patch })));
    for (const { id, patch } of live) this.map.set(String(id), { ...this.get(id), ...patch });
  }

  async removeMany(ids) {
    await getStore().batch(ids.map((id) => ({ op: "delete", path: `${this.path}/${id}` })));
    for (const id of ids) this.map.delete(String(id));
  }
}

export const contacts = new CachedCollection("waContacts");
export const campaigns = new CachedCollection("waCampaigns");
export const templates = new CachedCollection("waTemplates");
export const conversations = new CachedCollection("waConversations");
export const mediaIndex = new CachedCollection("waMedia");
export const dailyStats = new CachedCollection("waStats");
export const settingsCol = new CachedCollection("waSettings");

const ALL = [contacts, campaigns, templates, conversations, mediaIndex, dailyStats, settingsCol];

export const dataState = { ready: false, error: null };

/** Loads every collection. Throws on failure; the caller decides how to retry. */
export async function loadAll() {
  await Promise.all(ALL.map((c) => c.load()));
  dataState.ready = true;
  dataState.error = null;
}

export function newId(prefix = "") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
