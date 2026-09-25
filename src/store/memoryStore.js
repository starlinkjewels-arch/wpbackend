/**
 * The same interface as the Firestore store, held in a Map. Used by demo mode
 * (nothing leaves the process, nothing survives a restart) and by the tests.
 *
 * Documents are copied on the way in and out, so a caller mutating what it
 * got back cannot change the stored record behind the store's back — Firestore
 * behaves that way, and code written against this must not come to rely on
 * anything else.
 */
const copy = (v) => (v == null ? v : structuredClone(v));

function parent(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function createMemoryStore() {
  const docs = new Map();

  const store = {
    kind: "memory",
    docs,

    async getDoc(path) {
      return copy(docs.get(path) ?? null);
    },

    async setDoc(path, data) {
      docs.set(path, copy(data));
    },

    async mergeDoc(path, patch) {
      docs.set(path, { ...(docs.get(path) ?? {}), ...copy(patch) });
    },

    async deleteDoc(path) {
      docs.delete(path);
    },

    async list(collectionPath, { orderBy, desc = false, limit } = {}) {
      let out = [];
      for (const [path, data] of docs) {
        if (parent(path) === collectionPath) {
          out.push({ id: path.slice(collectionPath.length + 1), ...copy(data) });
        }
      }
      if (orderBy) {
        out.sort((a, b) => {
          const x = a[orderBy] ?? 0;
          const y = b[orderBy] ?? 0;
          return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
        });
      }
      if (limit) out = out.slice(0, limit);
      return out;
    },

    async batch(ops) {
      for (const { op, path, data } of ops) {
        if (op === "delete") await store.deleteDoc(path);
        else if (op === "merge") await store.mergeDoc(path, data);
        else await store.setDoc(path, data);
      }
    },

    async deleteCollection(collectionPath) {
      for (const path of [...docs.keys()]) {
        if (parent(path) === collectionPath) docs.delete(path);
      }
    },
  };
  return store;
}
