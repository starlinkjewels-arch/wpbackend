/**
 * Conversations, one per number.
 *
 *   waConversations/{phone}                  summary: name, last message, unread
 *   waConversations/{phone}/messages/{id}    the messages, keyed by WhatsApp's id
 *
 * Keyed by WhatsApp's own message id so recording the same message twice —
 * our send, then the echo WhatsApp delivers back — is one message, not two.
 *
 * A campaign writes its message into each recipient's conversation, so a reply
 * arrives with the message it answers right above it. Those conversations are
 * hidden from the inbox until the client actually writes back; otherwise a
 * campaign to 800 clients is 800 inbox rows nobody needs to read.
 */
import { conversations } from "./collections.js";
import { getStore } from "../store/index.js";

const preview = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);

/**
 * Is this client waiting for a person to answer? An automatic reply or a
 * campaign message is not an answer — only something a person sent (from the
 * inbox, or typed on the phone). Conversations saved before this was tracked
 * fall back on "whose message is last".
 */
export function isWaiting(c) {
  if (!c) return false;
  if ("waitingSince" in c) return c.waitingSince != null;
  return c.lastDir === "in";
}

export function waitingSinceOf(c) {
  if (!isWaiting(c)) return null;
  return c.waitingSince ?? c.lastAt ?? null;
}

export async function logMessage({ phone, jid, dir, text, at = Date.now(), id, name, campaignId, mediaType, manual = false, auto = false }) {
  if (!phone) return;
  const msgId = id || `local-${at}-${Math.random().toString(36).slice(2, 7)}`;
  // The same message recorded again (an echo of our own send) keeps what it was:
  // an automatic reply stays automatic, and never counts as a person answering.
  if (id && dir === "out" && !auto && !campaignId) {
    const earlier = await getStore().getDoc(`waConversations/${phone}/messages/${msgId}`).catch(() => null);
    if (earlier?.auto) auto = true;
    if (earlier?.campaignId) campaignId = earlier.campaignId;
  }
  await getStore().setDoc(`waConversations/${phone}/messages/${msgId}`, {
    dir,
    text: String(text ?? "").slice(0, 8000),
    at,
    ...(campaignId ? { campaignId } : null),
    ...(mediaType ? { mediaType } : null),
    ...(auto ? { auto: true } : null),
  });

  const prev = conversations.get(phone);
  const doc = {
    // Keep what other code stored here (the auto-reply cooldown) — rebuilding
    // the summary from scratch forgot it, and every message got a new reply.
    ...prev,
    phone,
    jid: jid ?? prev?.jid ?? null,
    name: name || prev?.name || "",
    lastText: preview(text) || (mediaType ? `[${mediaType}]` : ""),
    lastDir: dir,
    lastAt: Math.max(at, prev?.lastAt ?? 0),
    unread: (prev?.unread ?? 0) + (dir === "in" ? 1 : 0),
    hasInbound: Boolean(prev?.hasInbound || dir === "in"),
    manual: Boolean(prev?.manual || manual),
  };
  const personAnswered = dir === "out" && !campaignId && !auto;
  if (dir === "in") doc.waitingSince = isWaiting(prev) ? waitingSinceOf(prev) ?? at : at;
  else if (personAnswered) doc.waitingSince = null;
  else doc.waitingSince = prev ? waitingSinceOf(prev) : null;
  // An old message arriving late (history sync) must not replace a newer preview.
  if (prev && at < (prev.lastAt ?? 0)) {
    doc.lastText = prev.lastText;
    doc.lastDir = prev.lastDir;
  }
  await conversations.put(phone, doc);
}

export function listConversations({ q = "", filter = "all" } = {}, lookupContact = () => null) {
  const query = String(q).trim().toLowerCase();
  return conversations
    .all()
    .filter((c) => c.hasInbound || c.manual)
    .filter((c) => filter !== "unread" || c.unread > 0)
    .filter((c) => filter !== "hot" || c.lead?.level === "hot")
    .filter((c) => filter !== "waiting" || isWaiting(c))
    .map((c) => {
      const contact = lookupContact(c.phone);
      return {
        ...c,
        name: contact?.name || c.name || "",
        company: contact?.company || "",
        tags: contact?.tags ?? [],
        isNew: contact?.source === "inbound",
        optedOut: Boolean(contact?.optedOut),
      };
    })
    .filter((c) => filter !== "new" || c.isNew)
    .filter((c) => !query || `${c.name} ${c.company} ${c.phone} ${c.lastText}`.toLowerCase().includes(query))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

export function unreadTotal() {
  let n = 0;
  for (const c of conversations.all()) if (c.hasInbound || c.manual) n += c.unread > 0 ? 1 : 0;
  return n;
}

export async function getMessages(phone, limit = 150) {
  const rows = await getStore().list(`waConversations/${phone}/messages`, { orderBy: "at", desc: true, limit });
  return rows.reverse();
}

export async function markRead(phone) {
  if (conversations.get(phone)?.unread) await conversations.patch(phone, { unread: 0 });
}
