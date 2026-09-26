/**
 * What the AI is asked to write, and how its answer is cleaned up.
 *
 * Four jobs:
 *   compose      a campaign message from a short brief, with {{variables}}
 *   rewrite      polish / shorten / formalise / translate an existing message
 *   personalize  one campaign message, rewritten for one particular client
 *   suggestReply the next reply in an inbox conversation
 *
 * The rules that matter most, repeated in every prompt: use only the facts
 * the business gave (a model that invents a 20% discount has just made the
 * business an offer it never made), never leave a "[Client Name]" placeholder
 * in a message a real buyer will read, and output only the message.
 */
import { chat, AiError } from "./sarvam.js";
import { getSettings, aiKey } from "../data/settings.js";
import { bump } from "../data/stats.js";
import { renderMessage, varsForContact, firstName } from "../engine/personalize.js";
import { countryName } from "./countries.js";

const TONES = {
  professional: "professional, clear and respectful — a trusted supplier writing to a business partner",
  warm: "warm and personal, like a long-standing relationship manager, still professional",
  luxury: "elegant and refined, evoking craftsmanship and exclusivity, never over the top",
  friendly: "friendly and approachable, conversational, still business-appropriate",
  concise: "very concise and direct — every sentence earns its place",
};

const LENGTHS = {
  short: "2–4 short lines, under 350 characters",
  medium: "a short paragraph or two, under 600 characters",
  detailed: "up to three short paragraphs, under 900 characters",
};

export const REWRITE_ACTIONS = {
  improve: "Make it more polished, clear and persuasive. Keep every fact and the call to action.",
  shorter: "Make it about half as long. Keep the greeting, the key fact and the call to action.",
  formal: "Make it more formal and respectful.",
  warmer: "Make it warmer and more personal, still professional.",
  grammar: "Fix only spelling, grammar and punctuation. Change nothing else.",
  translate: "Translate it.",
};

function system(settings, language) {
  const ai = settings.ai;
  return [
    `You are the WhatsApp copywriter for ${settings.businessName}, a B2B business.`,
    "",
    "About the business — use ONLY these facts. Never invent prices, discounts, stock, dates, delivery times or certifications that are not given here or in the request:",
    ai.businessProfile || `${settings.businessName} sells diamond jewellery to businesses.`,
    "",
    "Rules for every message:",
    "- It goes to a business client (jeweller, retailer, wholesaler) on WhatsApp: professional, respectful and human — never spammy or pushy.",
    `- Write in ${language}.`,
    "- Layout for a phone screen: greeting on its own line, then one to three short paragraphs separated by a blank line, then the sign-off on its own line.",
    "- Plain text only. WhatsApp formatting: *bold* for 1–3 key words at most, _italic_ rarely. No markdown headings (#), no **double asterisks**, no hashtags, no links unless one is given.",
    "- At most one or two fitting emojis (💎 ✨), and none when the tone is formal.",
    "- Never write placeholders such as [Name], [Client Name], <name>, XXX or ___.",
    "- Output ONLY the message text. No title, no quotation marks around it, no explanation, no \"Here is\".",
    ai.instructions ? `\nExtra instructions from the business:\n${ai.instructions}` : "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/* ── Cleaning the answer ────────────────────────────────────────────── */

const PLACEHOLDER_TO_VAR = [
  [/\[(?:client|customer|recipient)?\s*(?:first\s*)?name\]|<(?:client\s*)?name>/gi, "{{first_name|Sir/Madam}}"],
  [/\[(?:company|company name|business name of client|firm)\]/gi, "{{company|your business}}"],
  [/\[(?:city)\]/gi, "{{city}}"],
  [/\[(?:your|our)?\s*(?:business|company)\s*name\]|\[(?:your name|sender)\]/gi, "{{business_name}}"],
];

/** Common ways a model decorates its answer, removed. */
export function cleanOutput(raw) {
  let t = String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, "")
    .trim();
  t = t.replace(/^(here(?:'s| is)[^\n]*?:|sure[^\n]*?:)\s*\n+/i, "");
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  t = t
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // markdown bold -> WhatsApp bold
    .replace(/^#{1,6}\s*(.+)$/gm, "*$1*") // headings -> bold line
    .replace(/^\s*[-*]\s+/gm, "• ") // markdown bullets -> •
    .replace(/\n{3,}/g, "\n\n")
    // "Dear Ahmed,\n\nwe are delighted…" — a paragraph starts with a capital.
    .replace(/(^|\n\n)([a-z])/g, (_m, pre, ch) => pre + ch.toUpperCase());
  return t.trim();
}

const FALLBACKS = { first_name: "Sir/Madam", name: "Sir/Madam", company: "your business" };

/**
 * For templates: stray placeholders become real variables, {first_name} gets
 * its second brace, the common variables get a fallback so a client with no
 * name never reads "Dear ,", and a greeting that is only a name gets its "Dear".
 */
export function fixTemplateVars(text) {
  let t = text;
  for (const [re, v] of PLACEHOLDER_TO_VAR) t = t.replace(re, v);
  t = t.replace(/(?<!\{)\{\s*(first_name|name|company|city|country|business_name)\s*(\|[^{}]*)?\}(?!\})/gi, (_m, k, fb = "") => `{{${k.toLowerCase()}${fb}}}`);
  t = t.replace(/\{\{\s*(first_name|name|company)\s*\}\}/gi, (_m, k) => `{{${k.toLowerCase()}|${FALLBACKS[k.toLowerCase()]}}}`);
  t = t.replace(/^(\{\{\s*(?:first_name|name)\b[^}]*\}\})[ \t]*,?[ \t]*$/m, "Dear $1,");
  return t;
}

/** For finished messages: anything still looking like a placeholder is filled from the client. */
function fillLeftovers(text, contact, settings) {
  const vars = varsForContact(contact, { business_name: settings.businessName });
  let t = fixTemplateVars(text);
  t = renderMessage(t, vars);
  // Last resort: a placeholder we could not map is dropped rather than sent.
  return t.replace(/\[[A-Z][A-Za-z ]{1,30}\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

/* ── Calling ────────────────────────────────────────────────────────── */

async function run(messages, { maxTokens, temperature } = {}) {
  const settings = getSettings();
  const ai = settings.ai;
  if (!ai.enabled) throw new AiError("AI writing is switched off in Settings → AI writer", "AI_DISABLED", 409);
  const res = await chat({
    apiKey: aiKey(settings),
    model: ai.model,
    messages,
    temperature: temperature ?? ai.temperature,
    reasoning: ai.reasoning,
    maxTokens,
  });
  bump("aiRequests").catch(() => {});
  if (res.usage?.total_tokens) bump("aiTokens", res.usage.total_tokens).catch(() => {});
  return { ...res, settings };
}

function describeContact(c = {}) {
  const lines = [];
  lines.push(c.name ? `- Name: ${c.name} (greet them as ${firstName(c.name)})` : "- Name: unknown — greet politely without a name (e.g. \"Dear Sir/Madam\")");
  if (c.company) lines.push(`- Company: ${c.company}`);
  const where = [c.city, countryName(c.country)].filter(Boolean).join(", ");
  if (where) lines.push(`- Location: ${where}`);
  if (c.tags?.length) lines.push(`- Our labels for them: ${c.tags.join(", ")}`);
  for (const [k, v] of Object.entries(c.fields ?? {})) lines.push(`- ${k}: ${v}`);
  if (c.notes) lines.push(`- Private notes from our team (for context only, never quote them): ${c.notes.slice(0, 500)}`);
  return lines.join("\n");
}

/**
 * A campaign message from a brief, written as a template with {{variables}}
 * so one text serves every client.
 */
export async function compose({ brief, tone, language, length = "medium" }) {
  const b = String(brief ?? "").trim();
  if (b.length < 5) throw new AiError("Tell the AI what the message is about (a sentence is enough)", "BAD_REQUEST", 400);
  const s = getSettings();
  const lang = language || s.ai.language;
  const user = [
    "Write one WhatsApp message for a campaign to our business clients.",
    `What to say: ${b.slice(0, 1500)}`,
    `Tone: ${TONES[tone] ?? TONES[s.ai.tone]}.`,
    `Length: ${LENGTHS[length] ?? LENGTHS.medium}.`,
    "",
    "It goes to many clients, so personalise it with ONLY these two variables — they are filled in automatically. Copy them character for character, including the double curly brackets and the part after |:",
    "- {{first_name|Sir/Madam}}  the client's first name",
    "- {{company|your business}}  their company",
    "Use no other variable (no city, country or budget) — not every client has them.",
    "The first line must be exactly: Dear {{first_name|Sir/Madam}},",
    "End with one clear next step (for example: reply to this message) and sign off with {{business_name}}.",
  ].join("\n");
  const { text, settings } = await run([
    { role: "system", content: system(s, lang) },
    { role: "user", content: user },
  ]);
  return { text: fixTemplateVars(cleanOutput(text)), model: settings.ai.model };
}

export async function rewrite({ text, action, language }) {
  const t = String(text ?? "").trim();
  if (!t) throw new AiError("Write something first, then ask the AI to improve it", "BAD_REQUEST", 400);
  const s = getSettings();
  const lang = language || s.ai.language;
  const instruction = action === "translate" ? `Translate it into ${lang}.` : REWRITE_ACTIONS[action] ?? REWRITE_ACTIONS.improve;
  const user = [
    "Rewrite this WhatsApp message.",
    `Instruction: ${instruction}`,
    "Keep every {{variable}} and {option|option} group exactly as written — do not translate, rename or remove them. Keep *bold* markers around the same words.",
    "",
    "Message:",
    "<<<",
    t.slice(0, 4000),
    ">>>",
  ].join("\n");
  const res = await run(
    [
      { role: "system", content: system(s, action === "translate" ? lang : "the same language as the message") },
      { role: "user", content: user },
    ],
    { temperature: action === "grammar" ? 0.1 : undefined },
  );
  return { text: fixTemplateVars(cleanOutput(res.text)), model: res.settings.ai.model };
}

/**
 * One client's own version of a campaign message.
 *
 * The campaign text is first filled in for this client ({{first_name}} →
 * "Arjun"), so the model starts from a finished message and only has to make
 * it personal — it is never trusted to fill variables itself.
 */
export async function personalize({ message, contact, language }) {
  const s = getSettings();
  const base = renderMessage(message, varsForContact(contact, { business_name: s.businessName }));
  if (!base.trim()) throw new AiError("The campaign has no message to personalise", "BAD_REQUEST", 400);
  const user = [
    "Rewrite the campaign message below for ONE specific client so it reads as if written personally to them.",
    "",
    "The client:",
    describeContact(contact),
    "",
    "Rules:",
    "- Keep every fact, offer and call to action of the campaign message. Add no new offers, prices, dates or promises.",
    "- Make it clearly personal, not just a name swap: greet them by first name, and add or adapt ONE sentence that connects the message to them — their company, their city or market, or their type of business (retailer, wholesaler, bridal…).",
    "- You may use a harmless preference from the notes (a favourite cut, metal or style). Never mention budgets, payment, credit, our labels for them, or any internal opinion.",
    "- Similar length to the original (within about 20%). Keep the sign-off.",
    "- No {{variables}} and no placeholders in your answer — write the final text.",
    "",
    "Campaign message:",
    "<<<",
    base,
    ">>>",
  ].join("\n");
  const res = await run([
    { role: "system", content: system(s, language || s.ai.language) },
    { role: "user", content: user },
  ]);
  return { text: fillLeftovers(cleanOutput(res.text), contact, s), model: res.settings.ai.model };
}

/** The next reply in a conversation, for the person to check and send. */
export async function suggestReply({ messages, contact, language }) {
  const s = getSettings();
  const history = messages
    .slice(-20)
    .map((m) => `${m.dir === "in" ? "Client" : "Us"}: ${String(m.text || (m.mediaType ? `[${m.mediaType}]` : "")).slice(0, 600)}`)
    .join("\n");
  if (!history.trim()) throw new AiError("There is no conversation to reply to yet", "BAD_REQUEST", 400);
  const user = [
    `Suggest the next WhatsApp reply from ${s.businessName} (that is us, the supplier) to this client.`,
    "Their company is the client's own business — never thank them for interest in it; they are interested in OUR products.",
    "",
    "The client:",
    describeContact(contact),
    "",
    "Conversation so far (oldest first):",
    history,
    "",
    "Rules:",
    "- Answer what the client last asked or said. 1–4 short lines.",
    "- If they ask for prices, stock, weights or anything not in the business facts, do not invent it: say we will share it shortly, or ask one clarifying question (quantity, carat, metal, budget range).",
    "- Match the client's language if they wrote in another language.",
    "- Never mention our labels for them (VIP, Retailer…), their budget or our private notes.",
    "- A \"yes\" to a catalogue or offer is a request for information, NOT an order. Never thank them for an order, and never say we are preparing, reserving, producing or shipping anything, unless the client has clearly confirmed an order themselves.",
    "- Never promise stock, delivery dates or prices. Offer to share details, or ask one useful question.",
    "- Start with \"Hi <first name>,\" or \"Dear <first name>,\" and sign off with the business name.",
  ].join("\n");
  const res = await run([
    { role: "system", content: system(s, language || "the client's language (English if unsure)") },
    { role: "user", content: user },
  ]);
  return { text: fillLeftovers(cleanOutput(res.text), contact ?? {}, s), model: res.settings.ai.model };
}

/** Settings → "Test AI": a short sample, and how long it took. */
export async function testAi() {
  const s = getSettings();
  const res = await run([
    { role: "system", content: system(s, s.ai.language) },
    { role: "user", content: "Write a two-line WhatsApp greeting to a jeweller in Dubai named Ahmed, introducing our business." },
  ], { maxTokens: 300 });
  return { text: cleanOutput(res.text), model: res.model, ms: res.ms };
}
