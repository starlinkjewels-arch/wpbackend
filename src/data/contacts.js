/**
 * The client list.
 *
 * A contact's id IS its phone number (digits, country code first). That one
 * choice makes the rest simple: an import cannot create a second copy of a
 * client, a WhatsApp message arriving from a number finds its client without
 * a lookup table, and a campaign cannot message one person twice.
 */
import { contacts } from "./collections.js";
import { getSettings } from "./settings.js";
import { normalizePhone, countryFromText } from "../phone.js";
import { bump } from "./stats.js";

export const IMPORT_TARGETS = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "countryCode",
  "company",
  "email",
  "country",
  "city",
  "tags",
  "notes",
  "custom",
  "ignore",
];

export function fail(message, code = "BAD_REQUEST", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const str = (v, max = 200) => (v == null ? "" : String(v).trim().slice(0, max));

export function splitTags(value) {
  if (Array.isArray(value)) return uniqTags(value);
  return uniqTags(String(value ?? "").split(/[,;|\n]/));
}

/** Tags compare case-insensitively but keep the first spelling seen. */
export function uniqTags(list) {
  const seen = new Map();
  for (const raw of list) {
    const t = str(raw, 40);
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

function hasTag(contact, tag) {
  const t = tag.toLowerCase();
  return (contact.tags ?? []).some((x) => x.toLowerCase() === t);
}

function statusOf(c) {
  if (c.optedOut) return "optedOut";
  if (c.waStatus === "invalid") return "invalid";
  return "active";
}

/* ── Reading ─────────────────────────────────────────────────────────── */

function matchesQuery(c, q) {
  if (!q) return true;
  const hay = [c.name, c.company, c.phone, c.email, c.city, c.country, c.notes, ...(c.tags ?? []), ...Object.values(c.fields ?? {})]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const digits = q.replace(/\D/g, "");
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word) || (digits.length >= 3 && String(c.phone).includes(digits)));
}

export function filterContacts({ q = "", tag = "", status = "all", source = "" } = {}) {
  const query = String(q).trim();
  const tags = Array.isArray(tag) ? tag : tag ? [tag] : [];
  return contacts.all().filter(
    (c) =>
      matchesQuery(c, query) &&
      tags.every((t) => hasTag(c, t)) &&
      (status === "all" || statusOf(c) === status) &&
      (!source || c.source === source),
  );
}

const SORTS = {
  recent: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  name: (a, b) => (a.name || "~").localeCompare(b.name || "~"),
  company: (a, b) => (a.company || "~").localeCompare(b.company || "~"),
  country: (a, b) => (a.country || "~").localeCompare(b.country || "~"),
  activity: (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
};

export function listContacts({ page = 1, pageSize = 50, sort = "recent", ...filters } = {}) {
  const all = filterContacts(filters).sort(SORTS[sort] ?? SORTS.recent);
  const size = Math.min(500, Math.max(1, Number(pageSize) || 50));
  const p = Math.max(1, Number(page) || 1);
  return { items: all.slice((p - 1) * size, p * size), total: all.length, page: p, pageSize: size };
}

export function tagSummary() {
  const counts = new Map();
  for (const c of contacts.all()) {
    for (const t of c.tags ?? []) {
      const k = t.toLowerCase();
      const cur = counts.get(k) ?? { tag: t, count: 0 };
      cur.count += 1;
      counts.set(k, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Every custom column any client has, for the composer's variable buttons. */
export function customFields() {
  const counts = new Map();
  for (const c of contacts.all()) {
    for (const [k, v] of Object.entries(c.fields ?? {})) {
      if (v != null && String(v).trim()) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export function contactCounts() {
  let active = 0, optedOut = 0, invalid = 0, inbound = 0;
  for (const c of contacts.all()) {
    const s = statusOf(c);
    if (s === "active") active += 1;
    else if (s === "optedOut") optedOut += 1;
    else invalid += 1;
    if (c.source === "inbound") inbound += 1;
  }
  return { total: contacts.size, active, optedOut, invalid, inbound };
}

/* ── Writing one ─────────────────────────────────────────────────────── */

function cleanFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const key = str(k, 60);
    const val = str(v, 500);
    if (key && val) out[key] = val;
  }
  return out;
}

function contactFromInput(input, phone, country, now) {
  return {
    phone,
    name: str(input.name, 120),
    company: str(input.company, 120),
    email: str(input.email, 160),
    country: countryFromText(input.country) ?? country ?? "",
    city: str(input.city, 80),
    tags: splitTags(input.tags ?? []),
    notes: str(input.notes, 2000),
    fields: cleanFields(input.fields),
    optedOut: Boolean(input.optedOut),
    waStatus: "unknown",
    source: input.source ?? "manual",
    createdAt: now,
    updatedAt: now,
  };
}

export async function createContact(input) {
  const settings = getSettings();
  const parsed = normalizePhone(input.phone, { defaultCountry: input.defaultCountry || settings.defaultCountry, country: input.country });
  if (!parsed.ok) throw fail(parsed.error, "INVALID_PHONE");
  const existing = contacts.get(parsed.phone);
  if (existing) {
    throw fail(`This number is already saved as "${existing.name || "+" + existing.phone}"`, "EXISTS", 409);
  }
  const now = Date.now();
  return contacts.put(parsed.phone, contactFromInput(input, parsed.phone, parsed.country, now));
}

export async function updateContact(id, input) {
  const prev = contacts.get(id);
  if (!prev) throw fail("Client not found", "NOT_FOUND", 404);

  const patch = { updatedAt: Date.now() };
  for (const k of ["name", "company", "email", "city", "notes"]) {
    if (k in input) patch[k] = str(input[k], k === "notes" ? 2000 : 160);
  }
  if ("country" in input) patch.country = countryFromText(input.country) ?? str(input.country, 2).toUpperCase();
  if ("tags" in input) patch.tags = splitTags(input.tags);
  if ("fields" in input) patch.fields = cleanFields(input.fields);
  if ("optedOut" in input) patch.optedOut = Boolean(input.optedOut);

  if ("phone" in input && String(input.phone ?? "").replace(/\D/g, "") !== prev.phone) {
    const parsed = normalizePhone(input.phone, { defaultCountry: getSettings().defaultCountry });
    if (!parsed.ok) throw fail(parsed.error, "INVALID_PHONE");
    if (parsed.phone !== prev.phone) {
      if (contacts.has(parsed.phone)) throw fail("Another client already has this number", "EXISTS", 409);
      // The phone is the id, so a new number is a new record.
      const moved = { ...prev, ...patch, phone: parsed.phone, waStatus: "unknown" };
      await contacts.put(parsed.phone, moved);
      await contacts.remove(prev.phone);
      return contacts.get(parsed.phone);
    }
  }
  return contacts.patch(id, patch);
}

/* ── Writing many ────────────────────────────────────────────────────── */

export async function deleteContacts(ids) {
  const live = ids.map(String).filter((id) => contacts.has(id));
  await contacts.removeMany(live);
  return live.length;
}

export async function tagContacts(ids, { add = [], remove = [] }) {
  const addT = splitTags(add);
  const removeT = new Set(splitTags(remove).map((t) => t.toLowerCase()));
  const now = Date.now();
  const patches = [];
  for (const id of ids) {
    const c = contacts.get(id);
    if (!c) continue;
    const tags = uniqTags([...(c.tags ?? []).filter((t) => !removeT.has(t.toLowerCase())), ...addT]);
    patches.push({ id: c.id, patch: { tags, updatedAt: now } });
  }
  await contacts.patchMany(patches);
  return patches.length;
}

export async function setOptedOut(ids, optedOut) {
  const now = Date.now();
  const patches = ids.filter((id) => contacts.has(id)).map((id) => ({ id, patch: { optedOut, updatedAt: now } }));
  await contacts.patchMany(patches);
  return patches.length;
}

/** A tag renamed or removed everywhere at once. */
export async function renameTag(from, to) {
  const f = from.toLowerCase();
  const patches = [];
  for (const c of contacts.all()) {
    if (!hasTag(c, from)) continue;
    const kept = c.tags.filter((t) => t.toLowerCase() !== f);
    patches.push({ id: c.id, patch: { tags: uniqTags(to ? [...kept, to] : kept), updatedAt: Date.now() } });
  }
  await contacts.patchMany(patches);
  return patches.length;
}

/* ── Import ──────────────────────────────────────────────────────────── */

/**
 * Check a spreadsheet before anything is saved.
 *
 * @param rows     [{ [columnHeader]: cellValue }] — the sheet, as parsed in the browser
 * @param mapping  { [columnHeader]: one of IMPORT_TARGETS }
 * @param options  { defaultCountry, tags: string[], onDuplicate: "update" | "skip" }
 *
 * Each row comes back with a status the review screen shows as-is:
 *   new        will be added
 *   update     already saved — will be updated with this row's details
 *   skip       already saved — left alone (onDuplicate: "skip")
 *   duplicate  the same number appeared higher up in this same file
 *   invalid    no usable number; `message` says why in words
 *   empty      a blank row, ignored and not shown
 */
export function analyzeImport(rows, mapping, options = {}) {
  if (!Array.isArray(rows)) throw fail("No rows to import");
  if (rows.length > 20000) throw fail("That file has more than 20,000 rows — split it into smaller files");
  const cols = Object.entries(mapping ?? {});
  if (!cols.some(([, t]) => t === "phone")) throw fail("Choose which column has the phone number", "NO_PHONE_COLUMN");

  const settings = getSettings();
  const defaultCountry = options.defaultCountry || settings.defaultCountry;
  const extraTags = splitTags(options.tags ?? []);
  const onDuplicate = options.onDuplicate === "skip" ? "skip" : "update";

  const seen = new Map();
  const out = [];
  const summary = { total: 0, new: 0, update: 0, skip: 0, duplicate: 0, invalid: 0, empty: 0, warnings: 0 };

  rows.forEach((row, i) => {
    const excelRow = (options.headerRowOffset ?? 2) + i;
    const pick = (target) => cols.filter(([, t]) => t === target).map(([h]) => row?.[h]).filter((v) => v != null && String(v).trim() !== "");
    const joined = (target) => pick(target).map((v) => String(v).trim()).join(" ");

    const phoneCells = pick("phone");
    const isEmpty = !Object.values(row ?? {}).some((v) => v != null && String(v).trim() !== "");
    if (isEmpty) {
      summary.empty += 1;
      return;
    }
    summary.total += 1;

    const name = joined("name") || [joined("firstName"), joined("lastName")].filter(Boolean).join(" ");
    const countryText = pick("country")[0];
    const parsed = normalizePhone(phoneCells[0], {
      defaultCountry,
      country: countryText,
      callingCode: pick("countryCode")[0],
    });

    const base = { row: excelRow, name: str(name, 120), company: str(joined("company"), 120) };

    if (!parsed.ok) {
      summary.invalid += 1;
      out.push({ ...base, raw: str(phoneCells[0], 40), status: "invalid", message: parsed.error });
      return;
    }

    if (seen.has(parsed.phone)) {
      summary.duplicate += 1;
      out.push({ ...base, phone: parsed.phone, status: "duplicate", message: `Same number as row ${seen.get(parsed.phone)}` });
      return;
    }
    seen.set(parsed.phone, excelRow);

    const fields = {};
    for (const [h, t] of cols) {
      if (t === "custom" && row?.[h] != null && String(row[h]).trim() !== "") fields[h] = row[h];
    }
    const notes = [joined("notes"), parsed.others?.length ? `Other number: ${parsed.others.join(", ")}` : ""].filter(Boolean).join("\n");

    const record = {
      ...base,
      phone: parsed.phone,
      country: countryFromText(countryText) ?? parsed.country ?? "",
      email: str(joined("email"), 160),
      city: str(joined("city"), 80),
      tags: uniqTags([...pick("tags").flatMap(splitTags), ...extraTags]),
      notes,
      fields: cleanFields(fields),
    };

    const exists = contacts.has(parsed.phone);
    const status = exists ? onDuplicate : "new";
    summary[status] += 1;
    const warning = parsed.warning ?? (parsed.others ? "Cell had more than one number — the first one is used" : undefined);
    if (warning) summary.warnings += 1;
    out.push({ ...record, status, message: exists ? `Already saved as "${contacts.get(parsed.phone).name || "no name"}"` : warning });
  });

  return { summary, rows: out };
}

/** Merge an imported row into an existing client: new values win, blanks never erase. */
function mergeImported(prev, rec, now) {
  const next = { ...prev, updatedAt: now };
  for (const k of ["name", "company", "email", "city", "country"]) if (rec[k]) next[k] = rec[k];
  next.tags = uniqTags([...(prev.tags ?? []), ...rec.tags]);
  next.fields = { ...(prev.fields ?? {}), ...rec.fields };
  if (rec.notes && !String(prev.notes ?? "").includes(rec.notes)) {
    next.notes = [prev.notes, rec.notes].filter(Boolean).join("\n");
  }
  return next;
}

export async function commitImport(rows, mapping, options = {}) {
  const { summary, rows: checked } = analyzeImport(rows, mapping, options);
  const now = Date.now();
  const writes = [];
  for (const r of checked) {
    if (r.status === "new") {
      writes.push({ ...contactFromInput({ ...r, source: "import" }, r.phone, r.country, now), id: r.phone });
    } else if (r.status === "update") {
      writes.push({ ...mergeImported(contacts.get(r.phone), r, now), id: r.phone });
    }
  }
  await contacts.putMany(writes);
  if (summary.new) await bump("newContacts", summary.new).catch(() => {});
  return { summary, saved: writes.length };
}

/* ── Who a campaign goes to ──────────────────────────────────────────── */

/**
 * @param audience {mode: "all" | "tags" | "contacts", tags?, tagMatch?: "any" | "all",
 *                  contactIds?, excludeTags?}
 * @returns eligible contacts, and how many were held back and why — the
 *          composer shows those numbers so nobody wonders where 12 clients went.
 */
export function resolveAudience(audience = {}) {
  const mode = audience.mode ?? "all";
  let pool;
  if (mode === "contacts") {
    pool = (audience.contactIds ?? []).map((id) => contacts.get(id)).filter(Boolean);
  } else if (mode === "tags") {
    const tags = splitTags(audience.tags ?? []);
    const all = audience.tagMatch === "all";
    pool = tags.length
      ? contacts.all().filter((c) => (all ? tags.every((t) => hasTag(c, t)) : tags.some((t) => hasTag(c, t))))
      : [];
  } else {
    pool = contacts.all();
  }

  const exclude = splitTags(audience.excludeTags ?? []);
  const excluded = { optedOut: 0, invalid: 0, excludedTag: 0 };
  const eligible = [];
  const seen = new Set();
  for (const c of pool) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (exclude.some((t) => hasTag(c, t))) excluded.excludedTag += 1;
    else if (c.optedOut) excluded.optedOut += 1;
    else if (c.waStatus === "invalid") excluded.invalid += 1;
    else eligible.push(c);
  }
  return { eligible, excluded };
}

/* ── Clients who write in first ──────────────────────────────────────── */

/**
 * A message arrived. If this number is not a client yet, it becomes one —
 * tagged so the business can find today's new enquiries — using the name the
 * sender set on their own WhatsApp profile.
 *
 * @returns {{contact: object|null, created: boolean}}
 */
export async function upsertInbound({ phone, pushName, at = Date.now() }) {
  const existing = contacts.get(phone);
  if (existing) {
    const patch = { lastMessageAt: at, lastInboundAt: at };
    if (!existing.name && pushName) patch.name = str(pushName, 120);
    // They wrote to us, so they are on WhatsApp whatever an earlier check said.
    if (existing.waStatus !== "valid") patch.waStatus = "valid";
    return { contact: await contacts.patch(phone, patch), created: false };
  }
  const settings = getSettings();
  if (!settings.autoAddInbound) return { contact: null, created: false };
  const doc = {
    ...contactFromInput(
      { name: pushName, tags: settings.inboundTag ? [settings.inboundTag] : [], source: "inbound" },
      phone,
      normalizePhone("+" + phone).country ?? "",
      at,
    ),
    waStatus: "valid",
    lastMessageAt: at,
    lastInboundAt: at,
  };
  const contact = await contacts.put(phone, doc);
  await bump("newContacts").catch(() => {});
  return { contact, created: true };
}
