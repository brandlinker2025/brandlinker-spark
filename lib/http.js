import { createHash, timingSafeEqual } from "node:crypto";

export function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function readBody(req, limit) {
  // Vercel's Node runtime may already have parsed the body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (Buffer.byteLength(req.body) > limit) return Promise.reject(Object.assign(new Error("Payload too large"), { status: 413 }));
      return Promise.resolve(req.body);
    }
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
    const s = JSON.stringify(req.body);
    if (Buffer.byteLength(s) > limit) return Promise.reject(Object.assign(new Error("Payload too large"), { status: 413 }));
    return Promise.resolve(s);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy && req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Object.assign(new Error("Invalid request."), { status: 400 });
  return data;
}

export function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] || "") : String(v || "");
}

export function clientIp(req) {
  // Vercel sets x-real-ip / x-vercel-forwarded-for itself; prefer those over a client-supplied x-forwarded-for.
  const vercelIp = header(req, "x-vercel-forwarded-for") || header(req, "x-real-ip");
  if (vercelIp.trim()) return vercelIp.split(",")[0].trim();
  const fwd = header(req, "x-forwarded-for");
  return (fwd.split(",")[0] || "").trim() || "unknown";
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function ipHash(req) {
  // Salted so stored hashes cannot be reversed by brute-forcing the IPv4 space.
  const salt = process.env.IP_HASH_SALT || process.env.ORDER_ADMIN_SECRET || "spark";
  return sha256(`${salt}:${clientIp(req)}`).slice(0, 24);
}

export function secretsEqual(a, b) {
  const A = Buffer.from(sha256(String(a || "")));
  const B = Buffer.from(sha256(String(b || "")));
  return String(a || "").length > 0 && String(b || "").length > 0 && timingSafeEqual(A, B);
}

const ALLOWED_ORIGIN_HOSTS = new Set(["brandlinkerspark.com", "www.brandlinkerspark.com"]);
// Only this project's own preview deployments, not any *.vercel.app site.
const PREVIEW_HOST_RE = /^brandlinker-spark-[a-z0-9-]+-brandlinker2025-4101s-projects\.vercel\.app$/;

export function originAllowed(req, { requireOrigin = false } = {}) {
  const origin = header(req, "origin");
  const host = header(req, "host");
  if (!origin) return !requireOrigin;
  try {
    const { host: oh } = new URL(origin);
    return oh === host || ALLOWED_ORIGIN_HOSTS.has(oh) || PREVIEW_HOST_RE.test(oh);
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of header(req, "cookie").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Logging helper: only whitelisted, non-personal fields ever reach the function logs.
export function safeLog(event, fields = {}) {
  const allowed = ["status", "code", "reason", "provider", "orderId", "count", "component"];
  const out = {};
  for (const k of allowed) if (fields[k] !== undefined) out[k] = String(fields[k]).slice(0, 120);
  console.error(`[spark] ${event}`, JSON.stringify(out));
}
