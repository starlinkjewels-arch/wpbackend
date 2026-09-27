/**
 * Lead links & QR codes — for trade-show booths, business cards, the website,
 * Instagram bio, a catalogue PDF.
 *
 * Each one is a wa.me link to the business's number with a message already
 * typed in, ending in a short reference: "… (Ref: HKFAIR)". The buyer only
 * presses send. When that message arrives the reference says where they came
 * from, and the link does the rest on its own:
 *
 *   - the sender becomes a client (as every enquiry does), tagged as set here
 *   - they are added to the chosen batch, ready for the follow-up broadcast
 *   - they get this link's own welcome reply, straight away
 *   - the link counts them, so the business sees which show or post worked
 *
 *   waLeadLinks/{id}   { name, code, source, prefill, tags, batchId, welcome,
 *                        active, leads, lastLeadAt, createdAt, updatedAt }
 */
import QRCode from "qrcode";
import { leadLinks, batches, contacts, newId } from "./collections.js";
import { fail, splitTags, tagContacts } from "./contacts.js";
import { addMembers } from "./batches.js";

export const SOURCES = ["event", "card", "website", "instagram", "catalogue", "other"];

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

/** "Hong Kong Fair Sept" → "HKFAIR"-ish: letters and digits, 4–12 long, unique. */
export function suggestCode(name) {
  const words = clean(name, 80).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => (/\d/.test(w) ? w : w[0])).join("") : words[0] ?? "LEAD";
  if (base.length < 4) base = (words.join("") || "LEAD").slice(0, 8);
  base = base.slice(0, 10);
  if (base.length < 4) base = base.padEnd(4, "X");
  let code = base;
  for (let i = 2; codeTaken(code); i += 1) code = `${base.slice(0, 10)}${i}`;
  return code;
}

function codeTaken(code, exceptId = null) {
  return leadLinks.all().some((l) => l.code === code && l.id !== exceptId);
}

function cleanCode(code) {
  return clean(code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The text the buyer sees typed in, ready to send. */
export function linkText(link) {
  return `${link.prefill.trim()} (Ref: ${link.code})`;
}

export function linkUrl(link, phone) {
  if (!phone) return null;
  return `https://wa.me/${phone}?text=${encodeURIComponent(linkText(link))}`;
}

function view(link, phone) {
  const batch = link.batchId ? batches.get(link.batchId) : null;
  return {
    ...link,
    batchName: batch?.name ?? null,
    batchMissing: Boolean(link.batchId && !batch),
    text: linkText(link),
    url: linkUrl(link, phone),
  };
}

export function listLinks(phone) {
  return leadLinks
    .all()
    .sort((a, b) => (b.lastLeadAt ?? b.createdAt ?? 0) - (a.lastLeadAt ?? a.createdAt ?? 0))
    .map((l) => view(l, phone));
}

export function getLink(id, phone) {
  const l = leadLinks.get(id);
  if (!l) throw fail("Lead link not found", "NOT_FOUND", 404);
  return view(l, phone);
}

function fields(input, prev = {}) {
  const name = clean(input.name ?? prev.name, 80);
  if (!name) throw fail("Give the link a name, e.g. \"Hong Kong Fair — Sept 2026\"");
  const code = input.code !== undefined ? cleanCode(input.code) : prev.code;
  const out = {
    name,
    code,
    source: SOURCES.includes(input.source) ? input.source : prev.source ?? "event",
    prefill: clean(input.prefill ?? prev.prefill, 300) || "Hello, I would like to see your latest collection and B2B prices.",
    tags: input.tags !== undefined ? splitTags(input.tags).slice(0, 10) : prev.tags ?? [],
    batchId: input.batchId !== undefined ? (input.batchId ? String(input.batchId) : null) : prev.batchId ?? null,
    welcome: clean(input.welcome ?? prev.welcome, 2000),
    active: input.active !== undefined ? Boolean(input.active) : prev.active ?? true,
  };
  if (out.batchId && !batches.has(out.batchId)) throw fail("That batch no longer exists — pick another");
  return out;
}

export async function createLink(input) {
  const f = fields({ ...input, code: input.code || suggestCode(input.name) });
  if (f.code.length < 4) throw fail("The reference code needs at least 4 letters or digits");
  if (codeTaken(f.code)) throw fail(`The code ${f.code} is already used by another link`, "EXISTS", 409);
  const id = newId("ll");
  const now = Date.now();
  return leadLinks.put(id, { ...f, leads: 0, lastLeadAt: null, createdAt: now, updatedAt: now });
}

export async function updateLink(id, input) {
  const prev = leadLinks.get(id);
  if (!prev) throw fail("Lead link not found", "NOT_FOUND", 404);
  const f = fields(input, prev);
  if (f.code.length < 4) throw fail("The reference code needs at least 4 letters or digits");
  if (codeTaken(f.code, id)) throw fail(`The code ${f.code} is already used by another link`, "EXISTS", 409);
  return leadLinks.patch(id, { ...f, updatedAt: Date.now() });
}

export async function deleteLink(id) {
  if (!leadLinks.has(id)) throw fail("Lead link not found", "NOT_FOUND", 404);
  await leadLinks.delete(id);
}

export async function qrFor(id, phone) {
  const link = getLink(id, phone);
  if (!link.url) throw fail("Connect WhatsApp once so the link knows your number", "NO_PHONE", 409);
  const opts = { errorCorrectionLevel: "M", margin: 2, color: { dark: "#1b1446", light: "#ffffff" } };
  return {
    url: link.url,
    png: await QRCode.toDataURL(link.url, { ...opts, width: 900 }),
    svg: await QRCode.toString(link.url, { ...opts, type: "svg" }),
  };
}

/* ── Matching an incoming message ───────────────────────────────────── */

/** "(Ref: HKFAIR)", "ref HKFAIR", "Ref#HKFAIR" — or the bare code, if long enough to be unmistakable. */
export function matchLink(text) {
  const t = String(text ?? "");
  const ref = /\bref\W{0,3}([A-Z0-9]{4,16})\b/i.exec(t)?.[1]?.toUpperCase();
  const all = leadLinks.all().filter((l) => l.active !== false);
  if (ref) {
    const hit = all.find((l) => l.code === ref);
    if (hit) return hit;
  }
  const words = new Set(t.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 6));
  return all.find((l) => l.code.length >= 6 && words.has(l.code)) ?? null;
}

/**
 * A message came in through a link: tag, batch, count. Returns whether this
 * person is new to this link (a second message with the same reference is
 * the same lead, not another one).
 */
export async function recordLead(link, contact, at = Date.now()) {
  if (!contact) return { first: false };
  const seen = contact.leadLinkIds ?? [];
  const first = !seen.includes(link.id);
  if (link.tags?.length) await tagContacts([contact.id], { add: link.tags });
  if (link.batchId && batches.has(link.batchId)) await addMembers(link.batchId, [contact.id]).catch(() => {});
  if (first) {
    await contacts.patch(contact.id, {
      leadLinkIds: [...seen, link.id].slice(-20),
      leadSource: link.name,
    });
    await leadLinks.patch(link.id, { leads: (leadLinks.get(link.id)?.leads ?? 0) + 1, lastLeadAt: at });
  }
  return { first };
}
