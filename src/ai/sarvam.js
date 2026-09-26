/**
 * Talking to Sarvam AI's chat-completion API.
 *
 *   POST https://api.sarvam.ai/v1/chat/completions
 *   header api-subscription-key: <key>
 *   { model, messages, temperature, max_tokens, reasoning_effort }
 *
 * Thinking ("reasoning") is on by default at Sarvam and makes every call
 * slower and dearer; a WhatsApp message does not need it, so it is sent as
 * null unless the admin turns it up in Settings.
 *
 * Every call goes through one small queue: a campaign writing 800 messages
 * must not fire 800 requests at once and be rate-limited into failing.
 */
import { DEMO_MODE } from "../store/index.js";

const API_URL = process.env.SARVAM_API_URL || "https://api.sarvam.ai/v1/chat/completions";
const MAX_IN_FLIGHT = 3;
const RETRIES = 3;

export class AiError extends Error {
  constructor(message, code = "AI_ERROR", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ── A tiny concurrency limit ───────────────────────────────────────── */

let inFlight = 0;
const waiting = [];

async function slot() {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function release() {
  inFlight -= 1;
  waiting.shift()?.();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Transport (swappable, for tests and for the demo without a key) ── */

let transport = null;

/** Tests hand in a fake: (body) => ({ text, usage }). */
export function setTransport(fn) {
  transport = fn;
}

/**
 * Demo mode with no key: plausible text, so every AI button can be tried.
 * It reads the last line of the request and dresses it up — clearly canned,
 * never mistaken for the real model once a key is set.
 */
function demoTransport(body) {
  const ask = body.messages.at(-1)?.content ?? "";
  const client = /Name: ([^\n(]+)/.exec(ask)?.[1]?.trim().split(/\s+/)[0];
  const quoted = /<<<\n([\s\S]*?)\n>>>/.exec(ask)?.[1];
  let text;
  if (quoted && client) text = quoted.replace(/^(Hello|Hi|Dear)[^,\n]*,/i, `Dear ${client},`);
  else if (quoted) text = quoted;
  else if (/next reply/i.test(ask)) text = "Thank you for your message. I will share the details with you shortly — could you tell me the quantity and the carat range you are looking for?";
  else {
    const brief = /What to say: (.+)/.exec(ask)?.[1] ?? "our latest collection";
    text = `Dear {{first_name|Sir/Madam}},\n\nWe are pleased to share ${brief.replace(/\.$/, "")} with {{company|your business}}. Our team would be happy to send the full details and B2B prices.\n\nPlease reply to this message and we will get back to you right away.\n\n— {{business_name}}`;
  }
  return { text, usage: { total_tokens: 0 }, demo: true };
}

/* ── The call ───────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{text: string, usage: object, model: string, ms: number}>}
 */
export async function chat({ apiKey, model, messages, temperature = 0.6, maxTokens = 900, reasoning = "off", timeoutMs = 60000 }) {
  const body = {
    model,
    messages,
    temperature,
    // Thinking tokens count against max_tokens; leave it room to think AND answer.
    max_tokens: reasoning === "off" ? maxTokens : maxTokens + 3000,
    reasoning_effort: reasoning === "off" ? null : reasoning,
  };
  const started = Date.now();

  if (transport) {
    const out = await transport(body);
    return { ...out, model, ms: Date.now() - started };
  }
  if (!apiKey) {
    if (DEMO_MODE) return { ...demoTransport(body), model: "demo", ms: 400 };
    throw new AiError("Add your Sarvam API key in Settings → AI writer to use AI.", "AI_NOT_CONFIGURED", 409);
  }

  await slot();
  try {
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(API_URL, {
          method: "POST",
          headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        lastErr = new AiError(
          err.name === "AbortError" ? "Sarvam AI took too long to answer" : "Could not reach Sarvam AI",
          "AI_UNREACHABLE",
        );
        clearTimeout(timer);
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      clearTimeout(timer);

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? "";
        if (!text.trim()) {
          throw new AiError(
            choice?.finish_reason === "length"
              ? "The AI ran out of room before answering — lower Thinking in Settings → AI writer"
              : "The AI returned an empty answer — try again",
            "AI_EMPTY",
          );
        }
        return { text, usage: data.usage ?? {}, model: data.model ?? model, ms: Date.now() - started };
      }

      const detail = data.error?.message ?? data.message ?? "";
      if (res.status === 401 || res.status === 403) {
        throw new AiError("Sarvam refused the API key — check it in Settings → AI writer", "AI_BAD_KEY", 409);
      }
      if (res.status === 400) {
        throw new AiError(`Sarvam rejected the request: ${detail || "bad request"}`, "AI_BAD_REQUEST", 400);
      }
      // 429 and 5xx: wait and try again, honouring Retry-After when given.
      lastErr = new AiError(
        res.status === 429 ? "Sarvam AI is busy (rate limit) — try again in a minute" : `Sarvam AI error (${res.status})`,
        res.status === 429 ? "AI_RATE_LIMITED" : "AI_ERROR",
        res.status === 429 ? 429 : 502,
      );
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1500 * 2 ** attempt);
    }
    throw lastErr;
  } finally {
    release();
  }
}
