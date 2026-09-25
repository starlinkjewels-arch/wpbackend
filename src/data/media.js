/**
 * Attachments: catalogue photos, price-list PDFs, short videos.
 *
 * Kept in Firestore itself, split into chunks under the 1 MiB document limit.
 * Firebase Storage would be the textbook home, but new projects only get it on
 * the paid plan, and a campaign attachment is written once and read a handful
 * of times — a few documents is a fair price for needing nothing else set up.
 */
import { mediaIndex, newId } from "./collections.js";
import { getStore } from "../store/index.js";
import { fail } from "./contacts.js";

const CHUNK = 900 * 1024;
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

const ALLOWED = [
  /^image\/(jpeg|png|webp)$/,
  /^video\/(mp4|3gpp|quicktime)$/,
  /^application\/pdf$/,
  /^application\/(vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document|presentationml\.presentation)|vnd\.ms-excel|msword|zip)$/,
  /^text\/(plain|csv)$/,
];

export function mediaKind(mimetype) {
  if (/^image\//.test(mimetype)) return "image";
  if (/^video\//.test(mimetype)) return "video";
  return "document";
}

/** Recent attachments kept in memory, so a campaign does not re-read a 10 MB
 *  catalogue from Firestore for every client. */
const cache = new Map();
const CACHE_MAX = 4;

function remember(id, value) {
  cache.delete(id);
  cache.set(id, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export async function saveMedia(buffer, { name, mimetype }) {
  if (!buffer?.length) throw fail("The file is empty");
  if (buffer.length > MAX_MEDIA_BYTES) throw fail("Files must be 15 MB or smaller for WhatsApp");
  const type = String(mimetype || "").toLowerCase().split(";")[0];
  if (!ALLOWED.some((re) => re.test(type))) {
    throw fail("Use a photo (JPG, PNG, WEBP), a video (MP4) or a document (PDF, Excel, Word)", "UNSUPPORTED");
  }
  const id = newId("m");
  const chunks = Math.ceil(buffer.length / CHUNK);
  const ops = [];
  for (let i = 0; i < chunks; i += 1) {
    ops.push({ op: "set", path: `waMedia/${id}/chunks/${i}`, data: { data: buffer.subarray(i * CHUNK, (i + 1) * CHUNK) } });
  }
  await getStore().batch(ops);
  const meta = {
    name: String(name || "file").slice(0, 120),
    mimetype: type,
    kind: mediaKind(type),
    size: buffer.length,
    chunks,
    createdAt: Date.now(),
  };
  const saved = await mediaIndex.put(id, meta);
  remember(id, { meta: saved, buffer });
  return saved;
}

export async function getMedia(id) {
  if (!id) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  const meta = mediaIndex.get(id);
  if (!meta) return null;
  const parts = [];
  for (let i = 0; i < meta.chunks; i += 1) {
    const doc = await getStore().getDoc(`waMedia/${id}/chunks/${i}`);
    if (!doc) throw fail("Part of this attachment is missing — upload it again", "MEDIA_BROKEN", 500);
    // Firestore gives back a Buffer; the memory store a Uint8Array.
    parts.push(Buffer.from(doc.data));
  }
  const value = { meta, buffer: Buffer.concat(parts) };
  remember(id, value);
  return value;
}

export async function deleteMedia(id) {
  await getStore().deleteCollection(`waMedia/${id}/chunks`);
  await mediaIndex.remove(id);
  cache.delete(id);
}
