/**
 * Where send claims (sendOnce.js) live: beside the rest of the app's data.
 *
 * sendOnce.js is written against Firestore's document API, and its whole
 * guarantee is `create()` failing when the document exists. With
 * DATA_STORE=firestore that is Firestore itself. Otherwise this shim gives the
 * same calls over the local store — and `create()` is exact there too, because
 * one process is the only writer and the check and the write happen with no
 * await between them.
 */
import { getDb } from "../firebaseAdmin.js";
import { getStore, STORE_KIND } from "./index.js";

function shim() {
  const store = getStore();
  return {
    collection: (name) => ({
      doc: (id) => {
        const path = `${name}/${id}`;
        return {
          async create(data) {
            // Same tick for the check and the write: nothing can slip between.
            if (store.docs?.has(path)) {
              const err = new Error("ALREADY_EXISTS");
              err.code = 6;
              throw err;
            }
            await store.setDoc(path, data);
          },
          async get() {
            const data = await store.getDoc(path);
            return { exists: data != null, data: () => data };
          },
          set: (data, opts) => (opts?.merge ? store.mergeDoc(path, data) : store.setDoc(path, data)),
          delete: () => store.deleteDoc(path),
        };
      },
    }),
  };
}

let db = null;
export function claimsDb() {
  if (!db) db = STORE_KIND === "firestore" ? getDb() : shim();
  return db;
}
