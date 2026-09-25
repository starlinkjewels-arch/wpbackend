import { getDb } from "../firebaseAdmin.js";

/* Firestore allows 500 writes per batch. Stay well under it — a merge that
   touches a nested field counts once, but never assume that. */
const BATCH_SIZE = 400;

/** Firestore rejects `undefined` anywhere in a document; the app uses it to
 *  mean "not set", so it is dropped rather than turned into an error. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return value;
}

export function createFirestoreStore() {
  const db = () => getDb();

  return {
    kind: "firestore",

    async getDoc(path) {
      const snap = await db().doc(path).get();
      return snap.exists ? snap.data() : null;
    },

    async setDoc(path, data) {
      await db().doc(path).set(clean(data));
    },

    async mergeDoc(path, patch) {
      await db().doc(path).set(clean(patch), { merge: true });
    },

    async deleteDoc(path) {
      await db().doc(path).delete();
    },

    async list(collectionPath, { orderBy, desc = false, limit } = {}) {
      let q = db().collection(collectionPath);
      if (orderBy) q = q.orderBy(orderBy, desc ? "desc" : "asc");
      if (limit) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async batch(ops) {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        const b = db().batch();
        for (const { op, path, data } of ops.slice(i, i + BATCH_SIZE)) {
          const ref = db().doc(path);
          if (op === "delete") b.delete(ref);
          else if (op === "merge") b.set(ref, clean(data), { merge: true });
          else b.set(ref, clean(data));
        }
        await b.commit();
      }
    },

    async deleteCollection(collectionPath) {
      const refs = await db().collection(collectionPath).listDocuments();
      for (let i = 0; i < refs.length; i += BATCH_SIZE) {
        const b = db().batch();
        for (const ref of refs.slice(i, i + BATCH_SIZE)) b.delete(ref);
        await b.commit();
      }
    },
  };
}
