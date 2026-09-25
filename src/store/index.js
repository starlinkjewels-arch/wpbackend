/**
 * Where the app keeps its records — clients, campaigns, templates, inbox,
 * settings. (The WhatsApp session is separate and always in Firebase; see
 * firestoreAuthState.js.)
 *
 * DATA_STORE picks one:
 *   local      JSON files in DATA_DIR (default ./data). The default: nothing
 *              to set up. Wiped by hosts without a persistent disk.
 *   firestore  the Firebase project in FIREBASE_SERVICE_ACCOUNT_KEY. Use this
 *              on Render's free tier, where the disk does not survive a deploy.
 *   memory     nothing saved at all; for tests.
 *
 * Every implementation offers the same small interface, in slash paths
 * ("waContacts/9198…", "waCampaigns/abc/chunks/0"):
 *
 *   getDoc(path)            -> object | null
 *   setDoc(path, data)      -> replaces
 *   mergeDoc(path, patch)   -> shallow merge, creates when missing
 *   deleteDoc(path)
 *   list(collectionPath, { orderBy, desc, limit }) -> [{ id, ...data }]
 *   batch(ops)              -> ops: [{ op: "set" | "merge" | "delete", path, data? }]
 *   deleteCollection(collectionPath)
 */
import path from "node:path";
import { createFirestoreStore } from "./firestoreStore.js";
import { createMemoryStore } from "./memoryStore.js";
import { createLocalFileStore } from "./localFileStore.js";

export const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || "");

export const STORE_KIND = (process.env.DATA_STORE || "local").toLowerCase();

let store = null;

export function getStore() {
  if (store) return store;
  if (STORE_KIND === "firestore") store = createFirestoreStore();
  else if (STORE_KIND === "memory") store = createMemoryStore();
  else {
    // Demo data gets its own folder, so trying the demo never mixes sample
    // clients into the real list.
    const dir = path.resolve(process.env.DATA_DIR || (DEMO_MODE ? "./data-demo" : "./data"));
    store = createLocalFileStore(dir);
  }
  return store;
}

/** Tests hand in their own. */
export function setStore(s) {
  store = s;
}
