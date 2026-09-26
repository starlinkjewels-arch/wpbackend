/**
 * Checking which clients are really on WhatsApp — before a campaign, not
 * during it.
 *
 * A campaign discovers a dead number anyway, but only by trying it; cleaning
 * the list first keeps the failure rate down (which WhatsApp watches) and
 * makes the audience count honest. One lookup every couple of seconds: a burst
 * of lookups is itself the kind of pattern that gets a number flagged.
 */
import wa from "../wa.js";
import { contacts } from "../data/collections.js";
import { fail } from "../data/contacts.js";

const RECHECK_AFTER_MS = 30 * 24 * 3600 * 1000;
const MAX_PER_RUN = 1000;

let job = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function verifyStatus() {
  if (!job) return null;
  const { cancel: _c, ...pub } = job;
  return pub;
}

export function cancelVerify() {
  if (job?.running) job.cancel = true;
}

/**
 * @param ids     the clients to check
 * @param force   re-check even clients checked in the last 30 days
 */
export function startVerify(ids, { force = false } = {}) {
  if (job?.running) throw fail("A check is already running — wait for it to finish", "BUSY", 409);
  if (wa.state.status !== "connected") throw fail("Connect WhatsApp first — the check asks WhatsApp about each number", "NOT_CONNECTED", 409);
  const now = Date.now();
  const todo = ids
    .map((id) => contacts.get(id))
    .filter(Boolean)
    .filter((c) => force || !c.verifiedAt || now - c.verifiedAt > RECHECK_AFTER_MS)
    .slice(0, MAX_PER_RUN);

  job = { total: todo.length, done: 0, valid: 0, invalid: 0, skipped: ids.length - todo.length, running: todo.length > 0, startedAt: now, finishedAt: null, lastError: null, cancel: false };
  if (!todo.length) {
    job.finishedAt = now;
    return verifyStatus();
  }

  (async () => {
    for (const c of todo) {
      if (job.cancel) break;
      try {
        const exists = await wa.checkNumber(c.phone);
        await contacts.patch(c.id, { waStatus: exists ? "valid" : "invalid", verifiedAt: Date.now() });
        job[exists ? "valid" : "invalid"] += 1;
      } catch (err) {
        job.lastError = err.code === "NOT_CONNECTED" ? "WhatsApp disconnected — the check stopped" : err.message;
        if (err.code === "NOT_CONNECTED") break;
      }
      job.done += 1;
      await sleep(1500 + Math.random() * 2000);
    }
    job.running = false;
    job.finishedAt = Date.now();
    console.log(`[verify] checked ${job.done}: ${job.valid} on WhatsApp, ${job.invalid} not`);
  })();
  return verifyStatus();
}
