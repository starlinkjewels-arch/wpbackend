/**
 * Writing every client's message for a campaign, in the background.
 *
 * The admin presses "Write all with AI" and watches a progress bar; the page
 * polls jobStatus(). One job per campaign, three messages in flight at a time.
 * A problem that will fail every message (no key, a refused key, AI switched
 * off) stops the job at once instead of failing 800 times.
 */
import { campaigns, contacts } from "../data/collections.js";
import { resolveAudience, fail } from "../data/contacts.js";
import * as R from "../data/recipients.js";
import { loadDrafts, setDraft, messageHash, draftUsable } from "../data/aiDrafts.js";
import { personalize } from "./writer.js";

const WORKERS = 3;
const FATAL = new Set(["AI_NOT_CONFIGURED", "AI_BAD_KEY", "AI_DISABLED"]);
const jobs = new Map();

/** Who this campaign goes to: its frozen list once started, else who it would reach now. */
export async function campaignContacts(c) {
  if (c.materialized) {
    const entry = await R.loadRecipients(c.id, c.chunkCount);
    return R.allRecipients(entry)
      .map((r) => contacts.get(r.p) ?? { id: r.p, phone: r.p, name: r.n })
      .filter(Boolean);
  }
  return resolveAudience(c.audience).eligible;
}

export function jobStatus(campaignId) {
  const j = jobs.get(campaignId);
  if (!j) return null;
  const { cancel: _c, ...pub } = j;
  return pub;
}

export function cancelJob(campaignId) {
  const j = jobs.get(campaignId);
  if (j?.running) j.cancel = true;
}

/**
 * @param mode "missing"  write only clients without a usable draft (default)
 *             "all"      rewrite everyone except drafts the admin edited by hand
 */
export async function startJob(campaignId, { mode = "missing" } = {}) {
  const c = campaigns.get(campaignId);
  if (!c) throw fail("Campaign not found", "NOT_FOUND", 404);
  if (!String(c.message ?? "").trim()) throw fail("Write the campaign message first — the AI uses it as the guide");
  if (jobs.get(campaignId)?.running) return jobStatus(campaignId);

  const hash = messageHash(c.message);
  const drafts = await loadDrafts(campaignId);
  const people = await campaignContacts(c);
  const todo = people.filter((p) => {
    const d = drafts.get(p.id ?? p.phone);
    if (d?.edited) return false;
    return mode === "all" || !draftUsable(d, hash);
  });

  const job = { campaignId, mode, total: todo.length, done: 0, failed: 0, running: todo.length > 0, startedAt: Date.now(), finishedAt: null, lastError: null, cancel: false };
  jobs.set(campaignId, job);
  if (!todo.length) {
    job.finishedAt = Date.now();
    return jobStatus(campaignId);
  }

  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !job.cancel) {
      const contact = queue.shift();
      try {
        const { text } = await personalize({ message: c.message, contact });
        await setDraft(campaignId, contact.id ?? contact.phone, { text, hash });
        job.done += 1;
      } catch (err) {
        job.failed += 1;
        job.lastError = err.message;
        if (FATAL.has(err.code)) job.cancel = true;
      }
    }
  };
  Promise.all(Array.from({ length: WORKERS }, worker)).finally(() => {
    job.running = false;
    job.finishedAt = Date.now();
    console.log(`[ai] campaign drafts: ${job.done} written, ${job.failed} failed${job.cancel ? " (stopped)" : ""}`);
  });
  return jobStatus(campaignId);
}
