/**
 * Posting to WhatsApp Status — the 24-hour stories jewellers use to show new
 * pieces.
 *
 * A status goes to a list of people the app names: the clients on WhatsApp
 * (all, or some tags), opted-out clients never included. WhatsApp then shows
 * it only to those who also have this number saved in their phone — it is
 * their phone, not the app, that decides.
 */
import wa from "../wa.js";
import { statusPosts, contacts, newId } from "./collections.js";
import { fail, splitTags } from "./contacts.js";
import { getMedia, mediaKind } from "./media.js";

const MAX_VIEWERS = 5000;

function viewers(audience = {}) {
  const tags = splitTags(audience.tags ?? []).map((t) => t.toLowerCase());
  return contacts
    .all()
    .filter((c) => !c.optedOut && c.waStatus !== "invalid")
    .filter((c) => audience.mode !== "tags" || (c.tags ?? []).some((t) => tags.includes(t.toLowerCase())))
    .slice(0, MAX_VIEWERS);
}

export function statusAudienceCount(audience) {
  return viewers(audience).length;
}

export async function postToStatus({ text, caption, mediaId, audience, backgroundColor }) {
  const people = viewers(audience);
  if (!people.length) throw fail("No clients to show it to — pick another tag or add clients", "NO_AUDIENCE");
  let media;
  if (mediaId) {
    const m = await getMedia(mediaId);
    if (!m) throw fail("The attached file is missing — attach it again");
    if (mediaKind(m.meta.mimetype) === "document") throw fail("Status can show a photo or a video, not a document");
    media = { buffer: m.buffer, mimetype: m.meta.mimetype };
  } else if (!String(text ?? "").trim()) {
    throw fail("Write a text or attach a photo or video");
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(backgroundColor)) ? backgroundColor : "#6d4aff";
  const res = await wa.postStatus({
    text: String(text ?? "").slice(0, 700),
    caption: String(caption ?? "").slice(0, 1000),
    media,
    jids: people.map((c) => `${c.phone}@s.whatsapp.net`),
    backgroundColor: color,
  });
  const now = Date.now();
  return statusPosts.put(newId("s"), {
    kind: media ? mediaKind(media.mimetype) : "text",
    text: media ? "" : String(text).slice(0, 700),
    caption: media ? String(caption ?? "").slice(0, 1000) : "",
    mediaId: mediaId || null,
    backgroundColor: color,
    audience: { mode: audience?.mode === "tags" ? "tags" : "all", tags: splitTags(audience?.tags ?? []) },
    viewers: people.length,
    messageId: res.messageId,
    postedAt: now,
    expiresAt: now + 24 * 3600 * 1000,
  });
}

export function listStatusPosts() {
  return statusPosts.all().sort((a, b) => b.postedAt - a.postedAt).slice(0, 50);
}
