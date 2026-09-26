/**
 * What happens when a message arrives.
 *
 *   1. An unknown number becomes a client, named from their WhatsApp profile and
 *      tagged (default "Inquiry") so new enquiries are one filter away.
 *   2. It is written into that client's conversation in the inbox.
 *   3. "STOP" (or any opt-out word the business set) takes them off every
 *      future campaign — including the one sending right now. "START" undoes it.
 *   4. Optionally, an automatic first reply, at most once per cooldown.
 */
import wa from "../wa.js";
import { conversations, contacts, dataState } from "../data/collections.js";
import { upsertInbound, setOptedOut } from "../data/contacts.js";
import { logMessage } from "../data/inbox.js";
import { getSettings } from "../data/settings.js";
import { bump } from "../data/stats.js";
import { renderMessage, varsForContact } from "./personalize.js";
import { noteReply } from "./tracking.js";

const OPT_IN_WORDS = ["START", "SUBSCRIBE", "UNSTOP"];

/** "Stop.", " stop ", "STOP!!" all mean STOP. A sentence containing "stop" does not. */
export function keyword(text) {
  return String(text ?? "").trim().toUpperCase().replace(/[^A-Z ]+/g, "").replace(/\s+/g, " ").trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A reply that lands the same instant as the message reads as a bot. Tests shorten it. */
export const timing = { replyDelayMs: () => 2500 + Math.random() * 3000 };

async function reply(key, jid, phone, text) {
  if (!text?.trim() || wa.state.status !== "connected") return;
  await sleep(timing.replyDelayMs());
  const res = await wa.sendMessage({ phone, jid, message: text });
  await logMessage({ phone: key, jid, dir: "out", text, id: res.messageId ?? undefined, at: Date.now() });
  await bump("sent");
}

export async function handleIncoming(m) {
  if (!dataState.ready) return;

  /* Typed by the owner on the phone. Recorded where a conversation exists so
     the inbox shows both sides; never creates a client. */
  if (m.fromMe) {
    if (m.phone && (conversations.has(m.phone) || contacts.has(m.phone))) {
      await logMessage({ phone: m.phone, jid: m.jid, dir: "out", text: m.text, at: m.timestamp, id: m.id, mediaType: m.mediaType });
    }
    return;
  }

  const settings = getSettings();
  // A sender with a hidden number still gets a conversation, keyed by its chat id.
  const key = m.phone ?? `lid${String(m.jid).split("@")[0].replace(/\D/g, "")}`;
  const firstTime = !conversations.get(key)?.hasInbound;

  let contact = null;
  if (m.phone) ({ contact } = await upsertInbound({ phone: m.phone, pushName: m.pushName, at: m.timestamp }));

  await logMessage({
    phone: key, jid: m.jid, dir: "in", text: m.text, at: m.timestamp, id: m.id,
    name: contact?.name || m.pushName || "", mediaType: m.mediaType,
  });
  await bump("inbound");

  const word = keyword(m.text);
  const stopping = Boolean(contact && settings.optOut.enabled && settings.optOut.keywords.includes(word));
  // Credit the reply (or the opt-out) to the campaign they last received.
  await noteReply(contact, m.timestamp, { optedOut: stopping }).catch((err) => console.error("[inbound] reply not tracked:", err.message));

  if (stopping) {
    if (!contact.optedOut) {
      await setOptedOut([contact.id], true);
      console.log("[inbound] a client opted out");
      await reply(key, m.jid, m.phone, settings.optOut.reply);
    }
    return;
  }
  if (contact?.optedOut && OPT_IN_WORDS.includes(word)) {
    await setOptedOut([contact.id], false);
    await reply(key, m.jid, m.phone, "You are subscribed again. Thank you!");
    return;
  }

  const ar = settings.autoReply;
  if (!ar.enabled || !ar.text.trim()) return;
  if (ar.onlyNewContacts && !firstTime) return;
  const last = conversations.get(key)?.lastAutoReplyAt ?? 0;
  if (Date.now() - last < ar.cooldownHours * 3600000) return;
  await conversations.patch(key, { lastAutoReplyAt: Date.now() });
  const text = renderMessage(ar.text, varsForContact(contact ?? { name: m.pushName }, { business_name: settings.businessName }));
  await reply(key, m.jid, m.phone, text);
}

export function startInbound() {
  wa.onIncoming((m) =>
    handleIncoming(m).catch((err) => console.error("[inbound] could not handle a message:", err.message)),
  );
}
