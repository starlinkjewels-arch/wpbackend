/**
 * The campaign app's rules, checked without WhatsApp and without Firebase:
 * the pretend WhatsApp (DEMO_MODE) and an in-memory store stand in for both.
 *
 * Each block is a promise made to the business — a wrong number never
 * messaged, a STOP honoured mid-campaign, a restart never sending twice.
 *
 * Run: npm test
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_STORE = "memory";
process.env.DEMO_MODE = "1";
process.env.ADMIN_PASSWORD = "test-password";

const { normalizePhone, countryFromText } = await import("../src/phone.js");
const { renderMessage, varsForContact, missingVarCounts, templateVars, firstName } = await import("../src/engine/personalize.js");
const { inWindow, nextWindowOpen, randomGapMs, parseHm } = await import("../src/engine/rules.js");
const { sanitize, getSettings, updateSettings } = await import("../src/data/settings.js");
const { loadAll, contacts, campaigns } = await import("../src/data/collections.js");
const C = await import("../src/data/contacts.js");
const Camp = await import("../src/data/campaigns.js");
const R = await import("../src/engine/runner.js");
const { handleIncoming, timing } = await import("../src/engine/inbound.js");
const { default: wa } = await import("../src/wa.js");
const auth = await import("../src/auth.js");
const { createLocalFileStore } = await import("../src/store/localFileStore.js");

let passed = 0;
const failures = [];
function assert(ok, what) {
  if (ok) passed += 1;
  else failures.push(what);
}

/* ══════ Numbers from a spreadsheet ═════════════════════════════════════ */
{
  const n = (v, o) => normalizePhone(v, o);
  assert(n("+971 50 123 4567").phone === "971501234567", "a +code number is read as written");
  assert(n("00971501234567").phone === "971501234567", "00 means +");
  assert(n("0501234567", { country: "UAE" }).phone === "971501234567", "a local number takes the row's Country column");
  assert(n("9825012345", { defaultCountry: "IN" }).phone === "919825012345", "and otherwise the default country");
  assert(n(971501234567).phone === "971501234567", "a number cell is not mangled into floating point");
  assert(n("971501234567", { defaultCountry: "IN" }).phone === "971501234567", "a code written without + is not given a second one");
  assert(n("501234567", { callingCode: "+971" }).phone === "971501234567", "a separate Country code column is used");
  const sci = n("9.71501E+11");
  assert(!sci.ok && /Excel/.test(sci.error), "Excel's 9.7E+11 is refused, with the fix in words");
  const two = n("+91 98250 12345 / 98250 67890");
  assert(two.ok && two.others?.length === 1, "two numbers in a cell: the first is used and the second kept");
  assert(!n("12345").ok && !n("").ok && !n(null).ok, "junk is refused, not guessed at");
  assert(countryFromText("United Arab Emirates") === "AE" && countryFromText("hk") === "HK" && countryFromText("Antwerp") === "BE", "country names people actually write are understood");
}

/* ══════ One message, read by each client as their own ═══════════════════ */
{
  const vars = varsForContact({ name: "Mr. Arjun Shah", company: "Shah Gems", fields: { "Budget (USD)": "$200k" } }, { business_name: "Starlink" });
  assert(renderMessage("Dear {{first_name}}", vars) === "Dear Arjun", "a title is not mistaken for a first name");
  assert(renderMessage("{{Budget (USD)}} for {{company}}", vars) === "$200k for Shah Gems", "any Excel column is a variable");
  assert(renderMessage("Hi {{city|there}}", vars) === "Hi there", "a fallback fills a blank");
  assert(renderMessage("Dear {{city}}, hello", vars) === "Dear, hello", "and without one the gap is tidied, not left as 'Dear ,'");
  assert(renderMessage("{A|B|C}", {}, { random: () => 0.99 }) === "C", "random words pick one option");
  assert(renderMessage("{Hi|{Hey|Yo}} x", {}, { random: () => 0.99 }) === "Yo x", "nested options work");
  assert(renderMessage("{{company}}", { company: "A{B|C}" }) === "A{B|C}", "a client's own text is never treated as random words");
  assert(renderMessage("{ not options }", {}) === "{ not options }", "braces without | are left alone");
  assert(firstName("Dr. Sarah Levi") === "Sarah" && firstName("Mr.") === "Mr.", "first names skip titles, but a lone title stays");
  const used = templateVars("{{name|Sir}} {{company}} {{ First Name }}");
  assert(used.find((v) => v.key === "name").hasFallback && !used.find((v) => v.key === "company").hasFallback, "fallbacks are detected per variable");
  const miss = missingVarCounts("Hi {{name}} of {{company|your firm}}", [{ name: "A" }, { name: "" }, {}]);
  assert(miss.length === 1 && miss[0].missing === 2, "the composer is told how many clients would see a blank");
}

/* ══════ When a message may go out ══════════════════════════════════════ */
{
  // 2026-09-25 03:30 UTC = 09:00 in India.
  const nineIST = Date.UTC(2026, 8, 25, 3, 30);
  const w = { enabled: true, start: "09:00", end: "21:00" };
  assert(inWindow(nineIST, w, "Asia/Kolkata"), "09:00 is inside 09:00–21:00");
  assert(!inWindow(nineIST - 60000, w, "Asia/Kolkata"), "08:59 is not");
  assert(nextWindowOpen(nineIST - 3600000, w, "Asia/Kolkata") === nineIST, "and the window reopens at exactly 09:00");
  const night = { enabled: true, start: "22:00", end: "02:00" };
  assert(inWindow(Date.UTC(2026, 8, 25, 19, 30), night, "Asia/Kolkata"), "a window across midnight is honoured (01:00)");
  assert(inWindow(nineIST, { enabled: false }, "Asia/Kolkata"), "a switched-off window never blocks");
  assert(inWindow(nineIST, { enabled: true, start: "junk", end: "21:00" }, "Asia/Kolkata"), "a broken window fails open rather than stopping every campaign");
  const g = randomGapMs(30, 10, () => 0);
  assert(g === 10000, "a gap entered backwards is repaired");
  assert(parseHm("24:00") === 1440 && parseHm("9:5") === null, "times are parsed strictly");
}

/* ══════ Settings cannot be saved into something dangerous ══════════════ */
{
  const s = sanitize({ minDelay: 0, maxDelay: -5, dailyLimit: 999999, timezone: "Mars/Base", defaultCountry: "xx" });
  assert(s.minDelay >= 3 && s.maxDelay >= 3, "the gap between messages can never be zero");
  assert(s.dailyLimit === 5000, "the daily limit is capped");
  assert(s.timezone === "Asia/Kolkata" && s.defaultCountry === "IN", "unknown time zones and countries fall back");
}

/* ══════ Data: import, audience, campaigns ═════════════════════════════ */
await loadAll();
await updateSettings({ window: { enabled: false }, dailyLimit: 1000, autoReply: { enabled: false } });
timing.replyDelayMs = () => 0;
wa.state.status = "connected";
wa.state.phone = "919876543210";

{
  const rows = [
    { Name: "Ahmed", Phone: "+971 50 123 4567", Tags: "VIP, Dubai", Budget: "$100k" },
    { Name: "Ahmed again", Phone: "00971501234567" },
    { Name: "Linda", Phone: "9123 4567", Country: "Hong Kong", Tags: "HK" },
    { Name: "Ghost", Phone: "+971509998000", Tags: "VIP" },
    { Name: "Broken", Phone: "9.7E+11" },
    {},
  ];
  const mapping = { Name: "name", Phone: "phone", Tags: "tags", Country: "country", Budget: "custom" };
  const pre = C.analyzeImport(rows, mapping, { tags: ["Expo"] });
  assert(pre.summary.new === 3 && pre.summary.duplicate === 1 && pre.summary.invalid === 1 && pre.summary.empty === 1, "import review counts each kind of row — got " + JSON.stringify(pre.summary));
  assert(pre.rows.find((r) => r.status === "duplicate").message.includes("row 2"), "a repeat says which row it repeats");
  assert(contacts.size === 0, "checking an import saves nothing");

  await C.commitImport(rows, mapping, { tags: ["Expo"] });
  const ahmed = contacts.get("971501234567");
  assert(ahmed && ahmed.tags.includes("VIP") && ahmed.tags.includes("Expo") && ahmed.fields.Budget === "$100k", "imported rows keep tags, the file's tag, and extra columns");

  await C.commitImport([{ Name: "", Phone: "+971501234567", Tags: "Retailer" }], { Name: "name", Phone: "phone", Tags: "tags" });
  const again = contacts.get("971501234567");
  assert(again.name === "Ahmed" && again.tags.includes("VIP") && again.tags.includes("Retailer"), "re-importing a client adds to them and never erases with blanks");

  await contacts.patch("971509998000", { optedOut: true });
  const { eligible, excluded } = C.resolveAudience({ mode: "tags", tags: ["vip"] });
  assert(eligible.length === 1 && excluded.optedOut === 1, "tags match case-insensitively, and opted-out clients are left out");
  await contacts.patch("971509998000", { optedOut: false });

  await assertRejects(() => C.createContact({ phone: "+971 50 123 4567" }), "EXISTS", "the same number cannot be saved twice");
}

async function assertRejects(fn, code, what) {
  try {
    await fn();
    assert(false, what + " (no error)");
  } catch (err) {
    assert(err.code === code, what + ` (got ${err.code})`);
  }
}

async function drain(id, max = 50) {
  for (let i = 0; i < max; i += 1) {
    R.runner.nextSendAt = 0;
    await R.runOnce();
    const c = campaigns.get(id);
    if (["completed", "paused", "cancelled"].includes(c.status)) return c;
  }
  return campaigns.get(id);
}

{
  await assertRejects(() => Camp.createCampaign({ message: "", audience: { mode: "all" }, action: "schedule" }), "BAD_REQUEST", "an empty message cannot be scheduled");
  await assertRejects(() => Camp.createCampaign({ message: "Hi", audience: { mode: "tags", tags: ["nobody"] }, action: "schedule" }), "NO_AUDIENCE", "nor a campaign to nobody");
  await assertRejects(() => Camp.createCampaign({ message: "Hi", action: "schedule", sendAt: Date.now() - 3600000 }), "BAD_REQUEST", "nor one in the past");

  const later = await Camp.createCampaign({ message: "Later", action: "schedule", sendAt: Date.now() + 3600000 });
  await R.runOnce();
  assert(campaigns.get(later.id).status === "scheduled", "a scheduled campaign waits for its time");
  await Camp.deleteCampaign(later.id);

  const c = await Camp.createCampaign({ name: "Test", message: "{{first_name|Sir}}, hello", action: "schedule", minDelay: 3, maxDelay: 3 });
  const done = await drain(c.id);
  assert(done.status === "completed", "a campaign runs to completion — got " + done.status);
  assert(done.stats.sent === 2 && done.stats.failed === 1, "sent to the reachable, failed on the number not on WhatsApp — " + JSON.stringify(done.stats));
  assert(contacts.get("971509998000").waStatus === "invalid", "and that number is remembered as not on WhatsApp");
  const { items } = await R.getRecipients(c.id, { status: "failed" });
  assert(items[0]?.error === "Not on WhatsApp", "the failure says why in words");

  const second = await Camp.createCampaign({ message: "Again", action: "schedule" });
  await drain(second.id);
  const s2 = campaigns.get(second.id).stats;
  assert(s2.total === 2 && s2.failed === 0, "the next campaign never tries a known-bad number again");

  await assertRejects(() => R.retryFailed(second.id), "NOTHING", "nothing to retry is said, not silently done");
}

/* A STOP halfway through: the rest of the campaign must respect it. */
{
  for (let i = 0; i < 4; i += 1) await C.createContact({ phone: `+44791112345${i}`, name: `Buyer ${i}`, tags: ["UK"] });
  const c = await Camp.createCampaign({ message: "UK offer", audience: { mode: "tags", tags: ["UK"] }, action: "schedule" });
  R.runner.nextSendAt = 0;
  await R.runOnce(); // starts, freezes the list
  R.runner.nextSendAt = 0;
  await R.runOnce(); // first send
  await handleIncoming({ jid: "447911123453@s.whatsapp.net", phone: "447911123453", id: "IN1", fromMe: false, pushName: null, text: "Stop!", timestamp: Date.now() });
  assert(contacts.get("447911123453").optedOut, "STOP opts a client out");
  const done = await drain(c.id);
  assert(done.stats.skipped === 1 && done.stats.sent === 3, "and they are skipped by the campaign already running — " + JSON.stringify(done.stats));
  await handleIncoming({ jid: "447911123453@s.whatsapp.net", phone: "447911123453", id: "IN2", fromMe: false, text: "START", timestamp: Date.now() });
  assert(!contacts.get("447911123453").optedOut, "START brings them back");
}

/* Pause, resume, and a restart that must not start again from the top. */
{
  const c = await Camp.createCampaign({ message: "Paused one", audience: { mode: "tags", tags: ["UK"] }, action: "schedule" });
  R.runner.nextSendAt = 0;
  await R.runOnce();
  R.runner.nextSendAt = 0;
  await R.runOnce();
  await R.pauseCampaign(c.id);
  const before = campaigns.get(c.id).stats.sent;
  R.runner.nextSendAt = 0;
  await R.runOnce();
  assert(campaigns.get(c.id).stats.sent === before, "a paused campaign sends nothing");
  await R.resumeCampaign(c.id);
  const done = await drain(c.id);
  assert(done.stats.sent === 4 && done.stats.total === 4, "resuming finishes it without resending anyone — " + JSON.stringify(done.stats));

  const d = await Camp.createCampaign({ message: "Disconnected", audience: { mode: "tags", tags: ["UK"] }, action: "schedule" });
  wa.state.status = "disconnected";
  R.runner.nextSendAt = 0;
  await R.runOnce();
  await R.runOnce();
  assert(campaigns.get(d.id).stats.sent === 0 && R.runner.waiting?.code === "disconnected", "no connection: it waits, nothing is marked failed");
  wa.state.status = "connected";
  const d2 = await drain(d.id);
  assert(d2.status === "completed" && d2.stats.sent === 4, "and carries on when WhatsApp is back");
}

/* The daily cap. */
{
  await updateSettings({ dailyLimit: 1 });
  const c = await Camp.createCampaign({ message: "Capped", audience: { mode: "tags", tags: ["UK"] }, action: "schedule" });
  R.runner.nextSendAt = 0;
  await R.runOnce();
  assert(R.runner.waiting?.code === "limit" && campaigns.get(c.id).stats.sent === 0, "past the daily limit, nothing more goes out today");
  await R.cancelCampaign(c.id);
  await updateSettings({ dailyLimit: 1000 });
}

/* ══════ Someone new writes in ═════════════════════════════════════════ */
{
  await updateSettings({ autoReply: { enabled: true, onlyNewContacts: true, text: "Thanks {{first_name|there}}!" } });
  await handleIncoming({ jid: "85261234567@s.whatsapp.net", phone: "85261234567", id: "N1", fromMe: false, pushName: "Mandy Lau", text: "Catalogue please", timestamp: Date.now() });
  const mandy = contacts.get("85261234567");
  assert(mandy && mandy.name === "Mandy Lau" && mandy.tags.includes("Inquiry") && mandy.source === "inbound", "an unknown number becomes a client, named and tagged");
  const { conversations } = await import("../src/data/collections.js");
  assert(conversations.get("85261234567")?.lastAutoReplyAt, "the first message gets the automatic reply");
  const firstReply = conversations.get("85261234567").lastAutoReplyAt;
  await handleIncoming({ jid: "85261234567@s.whatsapp.net", phone: "85261234567", id: "N2", fromMe: false, pushName: "Mandy Lau", text: "Hello?", timestamp: Date.now() });
  assert(conversations.get("85261234567").lastAutoReplyAt === firstReply, "the second does not");
  await updateSettings({ autoReply: { onlyNewContacts: false, cooldownHours: 24 } });
  await handleIncoming({ jid: "85261234567@s.whatsapp.net", phone: "85261234567", id: "N2b", fromMe: false, text: "Anyone?", timestamp: Date.now() });
  assert(conversations.get("85261234567").lastAutoReplyAt === firstReply, "with a cooldown, a client is not auto-replied to on every message");
  await handleIncoming({ jid: "999@lid", phone: null, id: "N3", fromMe: false, pushName: "Hidden", text: "hi", timestamp: Date.now() });
  assert(conversations.has("lid999") && !contacts.has("999"), "a hidden-number sender gets a chat but no fake client");
}

/* ══════ Signing in ═════════════════════════════════════════════════════ */
{
  const token = auth.signPayload({ sub: "admin", exp: Date.now() + 60000 });
  assert(auth.verifyPayload(token)?.sub === "admin", "a session token verifies");
  assert(!auth.verifyPayload(token.slice(0, -2) + "xx"), "a tampered one does not");
  assert(!auth.verifyPayload(auth.signPayload({ sub: "admin", exp: Date.now() - 1 })), "nor an expired one");
  const q = auth.signedMediaQuery("m1");
  const sig = decodeURIComponent(q.replace("sig=", ""));
  assert(auth.mediaSignatureValid("m1", sig) && !auth.mediaSignatureValid("m2", sig), "a file link opens that file and no other");
  const res = { headers: {}, set(h) { Object.assign(this.headers, h); }, sendStatus(c) { this.code = c; } };
  process.env.FRONTEND_ORIGIN = "https://*.vercel.app,http://localhost:5173";
  const req = (origin) => ({ method: "OPTIONS", get: (h) => (h === "origin" ? origin : undefined) });
  auth.cors(req("https://starlink-wa.vercel.app"), res, () => {});
  assert(res.code === 204 && res.headers["Access-Control-Allow-Origin"] === "https://starlink-wa.vercel.app", "the Vercel site may call the API");
  const res2 = { headers: {}, set(h) { Object.assign(this.headers, h); }, sendStatus(c) { this.code = c; } };
  auth.cors(req("https://evil.example.com"), res2, () => {});
  assert(res2.code === 403 && !res2.headers["Access-Control-Allow-Origin"], "another site may not");
  const res3 = { headers: {}, set(h) { Object.assign(this.headers, h); }, sendStatus(c) { this.code = c; } };
  auth.cors(req("https://evil.com/.vercel.app"), res3, () => {});
  assert(res3.code === 403, "and a look-alike address is not fooled into it");
}

/* ══════ Local files survive a restart ════════════════════════════════ */
{
  const dir = mkdtempSync(path.join(tmpdir(), "sl-store-"));
  const a = createLocalFileStore(dir);
  await a.setDoc("waContacts/1", { name: "One" });
  await a.setDoc("waMedia/m1/chunks/0", { data: Buffer.from("diamond") });
  await a.setDoc("waCampaigns/c1/chunks/0", { items: [{ p: "1", s: "sent" }] });
  a.flush();
  const files = readdirSync(dir).sort();
  assert(files.includes("waContacts.json") && files.includes("waMedia__m1.json") && files.includes("waCampaigns__c1.json"), "records are grouped into small files — " + files.join(","));
  const b = createLocalFileStore(dir);
  assert((await b.getDoc("waContacts/1"))?.name === "One", "and read back after a restart");
  const media = await b.getDoc("waMedia/m1/chunks/0");
  assert(Buffer.from(media.data).toString() === "diamond", "attachments come back byte for byte");
  assert((await b.list("waContacts")).length === 1, "lists work on reloaded data");
  await b.deleteDoc("waContacts/1");
  b.flush();
  assert(!readdirSync(dir).includes("waContacts.json"), "an emptied group's file is removed");
  rmSync(dir, { recursive: true, force: true });
}

/* ══════ The AI writer ═════════════════════════════════════════════════ */
{
  const { setTransport } = await import("../src/ai/sarvam.js");
  const W = await import("../src/ai/writer.js");
  const { publicSettings } = await import("../src/data/settings.js");
  const { getDraft, setDraft, messageHash } = await import("../src/data/aiDrafts.js");
  const { startJob, jobStatus } = await import("../src/ai/jobs.js");

  // The key is kept, never shown, and only replaced or removed on purpose.
  await updateSettings({ ai: { apiKey: "sk_secret_123456" } });
  const pub = publicSettings();
  assert(!("apiKey" in pub.ai) && pub.ai.hasKey && pub.ai.keyHint === "sk_se…3456", "the API key never reaches the browser — only a hint of it");
  await updateSettings({ ai: { apiKey: "", model: "sarvam-105b-conversations" } });
  assert(getSettings().ai.apiKey === "sk_secret_123456" && getSettings().ai.model === "sarvam-105b-conversations", "saving other AI settings keeps the saved key");
  await updateSettings({ ai: { clearKey: true, model: "bad model name!" } });
  assert(getSettings().ai.apiKey === "" && getSettings().ai.model === "sarvam-105b-conversations", "the key is removed only when asked; a nonsense model name keeps the last good one");
  await updateSettings({ ai: { model: "sarvam-105b" } });

  // What comes back from a model is cleaned before anyone sees it.
  assert(W.cleanOutput('Here is your message:\n\n"**New** collection"') === "*New* collection", "markdown and 'Here is' wrapping are removed");
  const fixed = W.fixTemplateVars("Dear [Client Name],\nFor {{company}} and {name}");
  assert(fixed === "Dear {{first_name|Sir/Madam}},\nFor {{company|your business}} and {{name|Sir/Madam}}", "placeholders become variables with safe fallbacks — got " + JSON.stringify(fixed));
  assert(W.fixTemplateVars("{{first_name|Sir/Madam}}\nHello") === "Dear {{first_name|Sir/Madam}},\nHello", "a greeting that is only a name gets its 'Dear'");

  let calls = 0;
  let fail = null;
  setTransport(async (body) => {
    calls += 1;
    if (fail) {
      const e = new Error(fail.message);
      e.code = fail.code;
      throw e;
    }
    const who = /greet them as (\w+)/.exec(body.messages.at(-1).content)?.[1] ?? "friend";
    return { text: `Here is the message:\n\nDear ${who}, a note written just for you.`, usage: { total_tokens: 10 } };
  });

  const p = await W.personalize({ message: "Hi {{first_name}}", contact: { name: "Mr. Ben Carter" } });
  assert(p.text === "Dear Ben, a note written just for you.", "a personal version is written and cleaned — got " + JSON.stringify(p.text));

  // A campaign where AI writes each message.
  const c = await Camp.createCampaign({ message: "New collection for {{company|you}}", audience: { mode: "tags", tags: ["UK"] }, ai: { personalize: true } });
  assert(campaigns.get(c.id).ai.personalize === true, "a campaign remembers it is AI-personalised");
  await setDraft(c.id, "447911123450", { text: "Hand-written for Buyer 0", edited: true, hash: "old" });
  await setDraft(c.id, "447911123451", { text: "Stale draft", hash: "old" });
  calls = 0;
  const job = await startJob(c.id);
  for (let i = 0; i < 50 && jobStatus(c.id)?.running; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert(job.total === 3 && jobStatus(c.id).done === 3 && calls === 3, "'write all' skips the admin's edits and rewrites missing and outdated ones — " + JSON.stringify(jobStatus(c.id)));
  assert((await getDraft(c.id, "447911123450")).text === "Hand-written for Buyer 0", "an edited message is never overwritten");
  assert((await getDraft(c.id, "447911123451")).hash === messageHash("New collection for {{company|you}}"), "the outdated one is rewritten");

  // Sending: edited drafts go as written; one missing draft is written on the spot;
  // and when the AI is down the client still gets the plain message.
  const { removeDraft } = await import("../src/data/aiDrafts.js");
  await removeDraft(c.id, "447911123452");
  await Camp.updateCampaign(c.id, { action: "schedule" });
  fail = null;
  let done = await drain(c.id);
  assert(done.stats.sent === 4, "an AI campaign sends to everyone — " + JSON.stringify(done.stats));
  const { conversations: convs } = await import("../src/data/collections.js");
  assert(convs.get("447911123450").lastText.includes("Hand-written for Buyer 0"), "the admin's edited message is exactly what was sent");
  assert((await getDraft(c.id, "447911123452"))?.text.includes("written just for you"), "a client without a draft gets one written at send time");

  const c2 = await Camp.createCampaign({ message: "Plain fallback {{first_name|there}}", audience: { mode: "tags", tags: ["UK"] }, ai: { personalize: true }, action: "schedule" });
  fail = { message: "down", code: "AI_UNREACHABLE" };
  done = await drain(c2.id);
  assert(done.stats.sent === 4, "an AI outage never stops a campaign");
  const { items } = await R.getRecipients(c2.id, { status: "sent" });
  assert(items.every((r) => /AI unavailable/.test(r.error ?? "")), "and each such message is marked as the standard text");
  assert(convs.get("447911123450").lastText.startsWith("Plain fallback"), "the standard message is what those clients got");

  fail = { message: "bad key", code: "AI_BAD_KEY" };
  const c3 = await Camp.createCampaign({ message: "x", audience: { mode: "tags", tags: ["UK"] }, ai: { personalize: true } });
  await startJob(c3.id);
  for (let i = 0; i < 50 && jobStatus(c3.id)?.running; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert(jobStatus(c3.id).failed <= 3 && jobStatus(c3.id).lastError === "bad key", "a refused key stops 'write all' at once instead of failing every client");
  setTransport(null);
}

/* ══════ Counters under load ═══════════════════════════════════════════ */
{
  const { bump, getDay, todayKey } = await import("../src/data/stats.js");
  const before = getDay(todayKey());
  await Promise.all([...Array(20)].map((_, i) => bump(i % 2 ? "aiRequests" : "aiTokens", 1)));
  const after = getDay(todayKey());
  assert(after.aiRequests - before.aiRequests === 10 && after.aiTokens - before.aiTokens === 10, "twenty counters bumped at once lose nothing — " + JSON.stringify({ before, after }));
}

/* ══════ Never twice, without Firebase ═════════════════════════════════ */
{
  const { claimsDb } = await import("../src/store/claimsDb.js");
  const { claimSend, completeSend } = await import("../src/sendOnce.js");
  const db = claimsDb();
  const [a, b] = await Promise.all([claimSend(db, "c_x_1", 1), claimSend(db, "c_x_1", 1)]);
  assert([a, b].filter((r) => r.state === "claimed").length === 1, "with local data, two simultaneous sends of one message: one wins");
  await completeSend(db, "c_x_1", { messageId: "M" }, 2);
  assert((await claimSend(db, "c_x_1", 3)).state === "done", "and a retry after it went out is answered, not resent");
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✅ all app rules held\n");
process.exit(0);
