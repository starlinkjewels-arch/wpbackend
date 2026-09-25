/**
 * The app's records as JSON files in a folder on this machine.
 *
 * For local use and testing: no Firebase project needed for the client list,
 * campaigns or inbox, and the files can be opened, backed up or deleted by
 * hand. Firebase is still used for the one thing that needs it — the WhatsApp
 * session (see firestoreAuthState.js).
 *
 * On a host without a persistent disk (Render's free tier) these files are
 * wiped on every deploy and restart. Use DATA_STORE=firestore there.
 *
 * Layout — one file per group, so a busy inbox does not rewrite the client list:
 *   waContacts.json                   every top-level doc of a collection
 *   waCampaigns__<id>.json            a campaign's recipient chunks
 *   waConversations__<phone>.json     one conversation's messages
 *   waMedia__<id>.json                one attachment's bytes
 *
 * Writes go to memory at once and to disk shortly after (batched), each file
 * replaced atomically — written beside the old one, then renamed over it — so a
 * crash mid-write leaves the previous version, never half a file.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { createMemoryStore } from "./memoryStore.js";

const FLUSH_MS = 300;

function groupOf(docPath) {
  const parts = docPath.split("/");
  const name = parts.length > 2 ? `${parts[0]}__${parts[1]}` : parts[0];
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/* Bytes (attachments) as base64, and back to Buffers on load. JSON.stringify
   calls Buffer#toJSON before a replacer sees the value, so the replacer looks
   at the raw value on its holder instead. */
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Uint8Array) return { $b64: Buffer.from(raw).toString("base64") };
  return value;
}
function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.$b64 === "string" && Object.keys(value).length === 1) {
    return Buffer.from(value.$b64, "base64");
  }
  return value;
}

export function createLocalFileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const mem = createMemoryStore();

  // Load everything that is on disk.
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const docs = JSON.parse(readFileSync(path.join(dir, file), "utf8"), reviver);
      for (const [p, data] of Object.entries(docs)) mem.docs.set(p, data);
    } catch (err) {
      console.error(`[store] could not read ${file} — skipped (${err.message})`);
    }
  }

  const dirty = new Set();
  let timer = null;

  function flushNow() {
    clearTimeout(timer);
    timer = null;
    const groups = [...dirty];
    dirty.clear();
    for (const g of groups) {
      const out = {};
      for (const [p, data] of mem.docs) if (groupOf(p) === g) out[p] = data;
      const file = path.join(dir, `${g}.json`);
      try {
        if (!Object.keys(out).length) {
          if (existsSync(file)) unlinkSync(file);
          continue;
        }
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(out, replacer));
        renameSync(tmp, file);
      } catch (err) {
        dirty.add(g); // try again on the next write
        console.error(`[store] could not save ${g}.json: ${err.message}`);
      }
    }
  }

  function touch(p) {
    dirty.add(groupOf(p));
    if (!timer) timer = setTimeout(flushNow, FLUSH_MS);
  }

  // A stopping process gets its last writes onto disk.
  process.once("exit", flushNow);

  return {
    kind: "local",
    dir,
    flush: flushNow,
    getDoc: mem.getDoc,
    list: mem.list,
    async setDoc(p, data) {
      await mem.setDoc(p, data);
      touch(p);
    },
    async mergeDoc(p, patch) {
      await mem.mergeDoc(p, patch);
      touch(p);
    },
    async deleteDoc(p) {
      await mem.deleteDoc(p);
      touch(p);
    },
    async batch(ops) {
      await mem.batch(ops);
      for (const { path: p } of ops) touch(p);
    },
    async deleteCollection(collectionPath) {
      const prefix = collectionPath + "/";
      const gone = [...mem.docs.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
      await mem.deleteCollection(collectionPath);
      for (const p of gone) touch(p);
    },
  };
}
