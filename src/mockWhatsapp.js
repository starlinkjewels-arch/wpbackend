/**
 * A pretend WhatsApp, for DEMO_MODE.
 *
 * Same exports as whatsapp.js, so nothing else can tell. It exists so the app
 * can be shown, tried and developed without a phone — and, more importantly,
 * without touching the business's real number: running a second copy of the
 * real service against the live session takes that session over (440) and
 * stops production delivering messages.
 *
 * Behaviour worth knowing when demoing:
 *   - it "scans" itself: a QR shows for a few seconds, then it connects;
 *   - numbers ending in 000 are "not on WhatsApp";
 *   - now and then a client "replies" to a campaign, sometimes with STOP.
 */
import QRCode from "qrcode";

export const state = {
  sock: null,
  status: "disconnected",
  qrDataUrl: null,
  phone: null,
  receivedMessages: [],
  connectedAt: null,
  lastError: null,
  halted: false,
};

const DEMO_PHONE = "919876543210";
const listeners = new Set();
const sentIds = new Set();
let timer = null;

const statusListeners = new Set();

export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function emitStatus(entry) {
  for (const fn of statusListeners) Promise.resolve().then(() => fn(entry)).catch(() => {});
}

export async function checkNumber(phone) {
  if (state.status !== "connected") throw fail("WhatsApp not connected", "NOT_CONNECTED");
  await sleep(150);
  return !String(phone).replace(/\D/g, "").endsWith("000");
}

export function onIncoming(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function toJid(phone) {
  return `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;
}

function emit(entry) {
  for (const fn of listeners) Promise.resolve().then(() => fn(entry)).catch((e) => console.error("[demo]", e.message));
}

export async function start() {
  clearTimeout(timer);
  state.status = "qr";
  state.qrDataUrl = await QRCode.toDataURL("DEMO MODE — this code links nothing");
  timer = setTimeout(() => {
    state.status = "connected";
    state.qrDataUrl = null;
    state.phone = DEMO_PHONE;
    state.connectedAt = Date.now();
    console.log("[demo] pretend WhatsApp connected");
  }, 6000);
}

export function startSafely() {
  start().catch((err) => {
    state.lastError = err.message;
  });
}

export async function disconnect() {
  clearTimeout(timer);
  state.status = "disconnected";
  state.phone = null;
  state.qrDataUrl = null;
  state.halted = false;
  state.lastError = null;
  setTimeout(() => startSafely(), 800);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const REPLIES = [
  "Hi, please share the price list",
  "Interested. Can you send videos of the rings?",
  "What is the MOQ for the tennis bracelets?",
  "Thanks, will check and revert",
  "Do you have lab grown also?",
  "STOP",
  "Please call me tomorrow",
];

export async function sendMessage({ phone, jid, message, media, pdfBase64, clientMessageId, typingMs = 0 }) {
  if (!message && !media && !pdfBase64) throw fail("Provide `message` and/or `pdfBase64`", "BAD_REQUEST");
  if (state.status !== "connected") throw fail("WhatsApp not connected — scan the QR code first", "NOT_CONNECTED");
  if (clientMessageId && sentIds.has(clientMessageId)) return { deduped: true, acknowledged: true, messageId: null };

  await sleep(300 + Math.random() * 700);
  const digits = String(phone ?? jid ?? "").replace(/\D/g, "");
  if (digits.endsWith("000")) throw fail(`${phone} is not on WhatsApp — check the number saved for this party`, "NOT_ON_WHATSAPP");

  if (typingMs) await sleep(Math.min(typingMs, 1500));
  const messageId = "DEMO" + Math.random().toString(36).slice(2, 12).toUpperCase();
  if (clientMessageId) sentIds.add(clientMessageId);

  // Their phone receives it, and most people open it.
  const target = toJid(digits);
  setTimeout(() => emitStatus({ id: messageId, status: 3, jid: target }), 800 + Math.random() * 2500).unref?.();
  if (Math.random() < 0.7) setTimeout(() => emitStatus({ id: messageId, status: 4, jid: target }), 4000 + Math.random() * 25000).unref?.();

  // Some clients write back. Not to our own number, and not to test sends.
  if (digits !== DEMO_PHONE && clientMessageId?.startsWith("c_") && Math.random() < 0.18) {
    setTimeout(() => {
      emit({
        jid: toJid(digits),
        phone: digits,
        id: "DEMOIN" + Math.random().toString(36).slice(2, 10).toUpperCase(),
        fromMe: false,
        pushName: null,
        text: REPLIES[Math.floor(Math.random() * REPLIES.length)],
        mediaType: null,
        timestamp: Date.now(),
      });
    }, 4000 + Math.random() * 20000).unref?.();
  }
  return { deduped: false, acknowledged: true, messageId };
}

/** Demo-only: a stranger writes in, to show auto-add working. */
export function simulateIncoming({ phone, name, text }) {
  emit({
    jid: toJid(phone),
    phone: String(phone).replace(/\D/g, ""),
    id: "DEMOIN" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    fromMe: false,
    pushName: name ?? null,
    text,
    mediaType: null,
    timestamp: Date.now(),
  });
}
