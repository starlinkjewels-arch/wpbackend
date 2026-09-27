/**
 * Lead Radar — every message a client sends is read and sorted:
 *
 *   hot    asks for a price, quote, stock, catalogue, samples, a meeting; says yes
 *   warm   engaged, asking something general
 *   cold   not interested, not now
 *   none   "ok", "thanks", 👍 — nothing to act on
 *
 * with a one-line note of what they want ("Price for 20 pcs 1ct+ GIA ovals").
 * A buyer who asks for a price and waits a day buys from someone else; this is
 * what puts that message at the top of the list instead of under forty "thanks".
 *
 * Rules answer instantly and work with no AI at all. When a Sarvam key is set,
 * the AI then reads the conversation and refines the verdict and the note.
 */
import { conversations, contacts } from "../data/collections.js";
import { getMessages, isWaiting, waitingSinceOf } from "../data/inbox.js";
import { getSettings, aiKey } from "../data/settings.js";
import { bump } from "../data/stats.js";
import { classifyLead } from "../ai/writer.js";

export const LEVELS = ["hot", "warm", "cold", "none"];
export const INTENTS = ["order", "price", "catalogue", "stock", "meeting", "question", "not_interested", "thanks", "link", "other"];

const RULES = [
  // Order before price: "confirm the order at this price" is an order.
  ["hot", "order", /\b(order|purchase|buy|booking|book it|confirm(ed)?|proceed|invoice|proforma|payment|advance|p\.?o\.?)\b|اطلب|订单|下单/i],
  ["cold", "not_interested", /\b(not interested|no thanks|no thank you|not now|maybe later|next time|don'?t (need|want|send)|no need|not required|already have|busy right now)\b/i],
  ["hot", "price", /\b(price|prices|pricing|rate|rates|quote|quotation|cost|how much|best price|discount|moq|per ct|per carat|\$\/ct)\b|سعر|الأسعار|价格|多少钱|报价/i],
  ["hot", "stock", /\b(available|availability|in stock|stock|ready stock|pcs|pieces|qty|quantity|\d+(\.\d+)?\s?(ct|cts|carat|carats)|vvs\d?|vs\d|gia|igi|hrd|solitaires?|parcels?)\b/i],
  ["hot", "catalogue", /\b(catalog(ue)?|brochure|photos?|pics?|pictures?|images?|videos?|price list|designs?|samples?|send (me|us|details)|share (details|more))\b|كتالوج|目录/i],
  ["hot", "meeting", /\b(meet|meeting|visit|booth|stand|appointment|showroom|call me|video call|zoom|come to)\b/i],
  ["hot", "order", /^(yes|yes please|yes pls|yeah|yep|sure|interested|i am interested|i'?m interested|please send|pls send|send|ok send|haan|ji)\b/i],
];
const ACK = /^(ok|okay|k|kk|thanks|thank you|thank u|thx|ty|noted|received|got it|fine|good|great|nice|welcome|hi|hello|hey|good (morning|evening|afternoon))[\s.!,]*(\p{Extended_Pictographic}|\s)*$/iu;
const ONLY_EMOJI = /^[\s\p{Extended_Pictographic}‍️]+$/u;

/** The instant verdict from wording alone. */
export function quickRead(text) {
  const t = String(text ?? "").trim();
  if (!t) return { level: "none", intent: "other", summary: "" };
  if (ACK.test(t) || ONLY_EMOJI.test(t)) return { level: "none", intent: "thanks", summary: "" };
  for (const [level, intent, re] of RULES) if (re.test(t)) return { level, intent, summary: firstLine(t) };
  const question = /\?|^(what|when|where|which|how|who|why|do you|can you|could you|is it|are you|does)\b/i.test(t);
  if (question) return { level: "warm", intent: "question", summary: firstLine(t) };
  return { level: t.split(/\s+/).length >= 4 ? "warm" : "none", intent: "other", summary: firstLine(t) };
}

function firstLine(t) {
  const line = t.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 87).trimEnd()}…` : line;
}

/**
 * Sort one incoming message and store the verdict on the conversation (and
 * the client). "Thanks" after a hot enquiry does not cool the lead: only a
 * message that says something new replaces what we knew.
 */
export async function scoreInbound({ key, contact, text, at = Date.now(), fromLink = null }) {
  const settings = getSettings();
  if (!settings.leadRadar.enabled) return null;
  let verdict = quickRead(text);
  if (fromLink && verdict.level !== "hot") verdict = { level: "warm", intent: "link", summary: `Came from "${fromLink}"` };
  const saved = await save(key, contact, { ...verdict, by: "rules" }, at);

  if (settings.leadRadar.useAi && settings.ai.enabled && aiKey(settings) && verdict.level !== "none") {
    refine(key, contact, at).catch((err) => console.error("[leads] AI could not sort a message:", err.message));
  }
  return saved;
}

async function refine(key, contact, at) {
  const messages = await getMessages(key, 12);
  const out = await classifyLead({ messages, contact });
  if (!out || !LEVELS.includes(out.level)) return;
  // A newer message may have arrived while the AI was thinking.
  if ((conversations.get(key)?.lead?.at ?? 0) > at) return;
  await save(key, contact, {
    level: out.level,
    intent: INTENTS.includes(out.intent) ? out.intent : "other",
    summary: out.summary.slice(0, 120) || conversations.get(key)?.lead?.summary || "",
    by: "ai",
  }, at, { refining: true });
}

async function save(key, contact, verdict, at, { refining = false } = {}) {
  const prev = conversations.get(key)?.lead;
  if (!refining && verdict.level === "none" && prev && prev.level !== "none") {
    // Keep the lead; just note they wrote again.
    return prev;
  }
  const lead = { ...verdict, at, ...(prev?.level === "hot" ? { firstHotAt: prev.firstHotAt ?? prev.at } : verdict.level === "hot" ? { firstHotAt: at } : null) };
  if (!conversations.has(key)) return null;
  await conversations.patch(key, { lead });
  if (contact?.id && contacts.has(contact.id)) await contacts.patch(contact.id, { lead: { level: lead.level, intent: lead.intent, summary: lead.summary, at } });
  if (!refining && verdict.level === "hot" && prev?.level !== "hot") bump("hotLeads").catch(() => {});
  return lead;
}

/** The team changes the verdict by hand ("done", "not a lead", "hot"). */
export async function setLead(key, { level, summary }) {
  if (!conversations.has(key)) {
    const err = new Error("Conversation not found");
    err.status = 404;
    throw err;
  }
  const prev = conversations.get(key).lead ?? {};
  const lead = {
    ...prev,
    level: LEVELS.includes(level) ? level : prev.level ?? "none",
    ...(summary !== undefined ? { summary: String(summary).slice(0, 120) } : null),
    by: "you",
    at: prev.at ?? Date.now(),
  };
  await conversations.patch(key, { lead });
  if (contacts.has(key)) await contacts.patch(key, { lead: { level: lead.level, intent: lead.intent, summary: lead.summary, at: lead.at } });
  return lead;
}

/**
 * Who is waiting on us: their message is the last one in the chat.
 * Hot first, then longest waiting.
 */
export function leadBoard({ limit = 50 } = {}) {
  const rank = { hot: 0, warm: 1, cold: 2, none: 3 };
  const rows = conversations
    .all()
    .filter((c) => c.hasInbound && c.lead && ["hot", "warm"].includes(c.lead.level) && !contacts.get(c.phone)?.optedOut)
    .map((c) => {
      const contact = contacts.get(c.phone);
      return {
        key: c.phone,
        name: contact?.name || c.name || "",
        company: contact?.company || "",
        country: contact?.country || "",
        lead: c.lead,
        lastText: c.lastText,
        lastAt: c.lastAt,
        waiting: isWaiting(c),
        waitingSince: waitingSinceOf(c),
      };
    })
    .sort((a, b) =>
      Number(b.waiting) - Number(a.waiting) ||
      rank[a.lead.level] - rank[b.lead.level] ||
      // Waiting: longest wait first. Answered: most recent first.
      (a.waiting ? a.waitingSince - b.waitingSince : b.lastAt - a.lastAt),
    );
  const counts = { hot: 0, warm: 0, waiting: 0, hotWaiting: 0 };
  for (const r of rows) {
    counts[r.lead.level] += 1;
    if (r.waiting) counts.waiting += 1;
    if (r.waiting && r.lead.level === "hot") counts.hotWaiting += 1;
  }
  return { items: rows.slice(0, limit), counts };
}
