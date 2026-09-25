/**
 * Who may use the app.
 *
 * Two ways in, for two kinds of caller:
 *   - People, through the web app: a password (ADMIN_PASSWORD) exchanged for a
 *     signed session token, sent back as `Authorization: Bearer <token>`.
 *   - Other servers (the AIM billing app): the existing `x-api-key` header.
 *
 * A token rather than a cookie because the web app is hosted on a different
 * site (Vercel) from this API (Render). A cookie crossing sites needs
 * SameSite=None, and browsers increasingly refuse those outright — Safari
 * already does. A header is sent because the app's own code sends it, which
 * also means another site cannot make the browser send it for them (no CSRF).
 *
 * What is being protected is not the client list — it is the business's
 * WhatsApp account. Anyone signed in here can send as them, and the QR code on
 * the Connect page IS a login to that account.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { DEMO_MODE } from "./store/index.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Constant-time, and length-safe: timingSafeEqual throws on a length
 *  mismatch, which would otherwise leak the key's length through a 500. */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The password people sign in with. Falls back to API_KEY so an existing
 *  deployment has a way in on day one; demo mode uses "demo". */
export function adminPassword() {
  return process.env.ADMIN_PASSWORD || process.env.API_KEY || (DEMO_MODE ? "demo" : "");
}

/* Derived from the password, so changing ADMIN_PASSWORD signs everyone out —
   which is exactly what someone changing a leaked password wants. */
function secret() {
  return process.env.SESSION_SECRET || createHash("sha256").update(`sl-session:${adminPassword()}:${process.env.API_KEY ?? ""}`).digest("hex");
}

export function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyPayload(token) {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  if (!sameSecret(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/**
 * A link to one attachment that works without the session header — an <img>
 * or <video> tag cannot send one. Scoped to that file and short-lived, so a
 * link that ends up in a log or a screenshot opens nothing else.
 */
export function signedMediaQuery(id, ttlMs = 6 * 60 * 60 * 1000) {
  return `sig=${encodeURIComponent(signPayload({ media: id, exp: Date.now() + ttlMs }))}`;
}

export function mediaSignatureValid(id, sig) {
  return verifyPayload(sig)?.media === id;
}

/* Ten wrong passwords in 15 minutes from one address, then a pause. Enough
   for someone who mistyped; useless to someone guessing. */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;

function limited(ip) {
  const a = attempts.get(ip);
  return Boolean(a && a.resetAt > Date.now() && a.count >= 10);
}

function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else a.count += 1;
  if (attempts.size > 5000) attempts.clear();
}

export function login(req, res) {
  const ip = req.ip ?? "unknown";
  if (limited(ip)) {
    return res.status(429).json({ error: "Too many wrong attempts. Wait 15 minutes and try again.", code: "RATE_LIMITED" });
  }
  const configured = adminPassword();
  if (!configured) {
    return res.status(500).json({ error: "Set ADMIN_PASSWORD on the server before signing in", code: "NOT_CONFIGURED" });
  }
  if (!sameSecret(req.body?.password, configured)) {
    recordFailure(ip);
    return res.status(401).json({ error: "Wrong password", code: "WRONG_PASSWORD" });
  }
  attempts.delete(ip);
  const exp = Date.now() + SESSION_MS;
  res.json({ ok: true, token: signPayload({ sub: "admin", exp }), expiresAt: exp });
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
  return m ? m[1].trim() : null;
}

export function isSignedIn(req) {
  return verifyPayload(bearer(req))?.sub === "admin";
}

/** For /api: a signed-in person, or a server with the API key. */
export function requireUser(req, res, next) {
  const key = process.env.API_KEY;
  if (key && req.get("x-api-key") && sameSecret(req.get("x-api-key"), key)) return next();
  if (!isSignedIn(req)) return res.status(401).json({ error: "Please sign in", code: "UNAUTHENTICATED" });
  next();
}

/**
 * Cross-origin access for the web app on its own domain.
 *
 * FRONTEND_ORIGIN lists the sites allowed to call this API, comma-separated
 * (https://starlink-wa.vercel.app,http://localhost:5173). An entry may use one
 * leading wildcard for Vercel's preview deployments: https://*.vercel.app.
 * Anything not listed gets no CORS headers, and the browser blocks it.
 */
export function cors(req, res, next) {
  const origin = req.get("origin");
  if (origin && originAllowed(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-File-Name,X-Api-Key",
      "Access-Control-Max-Age": "600",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(origin && originAllowed(origin) ? 204 : 403);
  next();
}

function originAllowed(origin) {
  const list = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return list.some((allowed) => {
    if (allowed === "*") return true;
    if (!allowed.includes("*")) return allowed === origin;
    const [scheme, host] = allowed.split("://");
    const suffix = host.replace(/^\*/, "");
    return origin.startsWith(scheme + "://") && origin.endsWith(suffix) && !origin.slice(scheme.length + 3, -suffix.length).includes("/");
  });
}
