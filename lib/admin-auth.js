// Admin authentication for orders-admin.
// - Login with ORDER_ADMIN_SECRET (env only). Missing or short secret => fail closed (503).
// - Server-side sessions stored in private Blob: the cookie holds a random token, the store
//   holds only its SHA-256 hash, with an absolute expiry. Logout deletes the record.
// - Cookie: __Host- prefix, HttpOnly, Secure, SameSite=Strict, Path=/.
// - Brute force: failed logins are counted per IP and globally in the shared store;
//   if the store is unavailable the login is refused (fail closed).
import { randomBytes } from "node:crypto";
import { getStore, storeConfigured } from "./store.js";
import { parseCookies, sha256, secretsEqual, ipHash, originAllowed, header } from "./http.js";
import { peekCount, bump } from "./ratelimit.js";

export const COOKIE = "__Host-spark_admin";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 12;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILS_PER_IP = 5;
export const LOGIN_MAX_FAILS_GLOBAL = 30;

export function adminConfigured() {
  const s = process.env.ORDER_ADMIN_SECRET || "";
  return s.length >= MIN_SECRET_LENGTH && storeConfigured();
}

function sessionPath(token) {
  return `admin-sessions/${sha256(token)}.json`;
}

export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** @returns {Promise<{status:number, body:object, cookie?:string}>} */
export async function login(req, secret, now = Date.now()) {
  if (!adminConfigured()) return { status: 503, body: { ok: false, error: "Admin login is not configured.", status: "Not configured" } };
  if (!originAllowed(req, { requireOrigin: true })) return { status: 403, body: { ok: false, error: "Forbidden." } };
  const id = ipHash(req);
  let ipFails, globalFails;
  try {
    ipFails = await peekCount({ scope: "admin-login-fail", id, windowMs: LOGIN_WINDOW_MS, now });
    globalFails = await peekCount({ scope: "admin-login-fail", id: "global", windowMs: LOGIN_WINDOW_MS, now });
  } catch {
    return { status: 503, body: { ok: false, error: "Login is temporarily unavailable." } };
  }
  if (ipFails >= LOGIN_MAX_FAILS_PER_IP || globalFails >= LOGIN_MAX_FAILS_GLOBAL) {
    return { status: 429, body: { ok: false, error: "Too many failed attempts. Try again later." } };
  }
  if (typeof secret !== "string" || !secretsEqual(secret, process.env.ORDER_ADMIN_SECRET)) {
    try {
      await bump({ scope: "admin-login-fail", id, windowMs: LOGIN_WINDOW_MS, now });
      await bump({ scope: "admin-login-fail", id: "global", windowMs: LOGIN_WINDOW_MS, now });
    } catch {
      /* counted best effort; the request is refused either way */
    }
    return { status: 401, body: { ok: false, error: "Unauthorized." } };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  try {
    await getStore().putJSON(sessionPath(token), { createdAt: now, expiresAt, ipHash: id });
  } catch {
    return { status: 503, body: { ok: false, error: "Login is temporarily unavailable." } };
  }
  return {
    status: 200,
    body: { ok: true, expiresAt: new Date(expiresAt).toISOString() },
    cookie: sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

/** Returns the session record or null. Never throws: any failure means "not authenticated". */
export async function currentSession(req, now = Date.now()) {
  if (!adminConfigured()) return null;
  const token = parseCookies(req)[COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  try {
    const rec = await getStore().getJSON(sessionPath(token));
    if (!rec || !Number.isFinite(rec.expiresAt) || rec.expiresAt <= now) return null;
    return { ...rec, token };
  } catch {
    return null;
  }
}

export async function logout(req) {
  const token = parseCookies(req)[COOKIE];
  if (token && /^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    try {
      await getStore().remove(sessionPath(token));
    } catch {
      /* cookie is cleared regardless */
    }
  }
  return clearCookie();
}

/** Guard for admin endpoints. State-changing methods also require a same-site Origin. */
export async function requireAdmin(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && !originAllowed(req, { requireOrigin: true })) return { ok: false, status: 403, error: "Forbidden." };
  const s = await currentSession(req);
  if (!s) return { ok: false, status: 401, error: "Unauthorized." };
  return { ok: true, session: s };
}

export { header };
