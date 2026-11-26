// Two-layer fixed-window rate limiter.
// Layer 1: per-instance memory (fast, but each serverless instance has its own copy).
// Layer 2: a counter in private Blob storage shared by every instance. Blob has no atomic
// increment, so concurrent requests can slightly overshoot the limit; it is a best-effort
// shared limit, not a strict one. (The Studio's Supabase quota store could replace layer 2.)
import { getStore } from "./store.js";
import { safeLog } from "./http.js";

const memory = new Map();

export function resetRateLimitsForTests() {
  memory.clear();
}

function memoryHit(key, max, windowMs, now) {
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (now - v.start > windowMs) memory.delete(k);
  }
  const rec = memory.get(key);
  if (!rec || now - rec.start > windowMs) {
    memory.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= max;
}

/**
 * @returns {Promise<{ok:boolean, reason?:string}>}
 * failOpen=true: a storage error lets the request through (checkout must not break).
 * failOpen=false: a storage error denies the request (admin login fails closed).
 */
export async function rateLimit({ scope, id, max, windowMs, failOpen = true, now = Date.now() }) {
  const key = `${scope}:${id}`;
  if (!memoryHit(key, max, windowMs, now)) return { ok: false, reason: "instance" };
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const pathname = `ratelimit/${scope}/${id}/${windowStart}.json`;
  try {
    const store = getStore();
    const rec = (await store.getJSON(pathname)) || { count: 0 };
    if (rec.count >= max) return { ok: false, reason: "shared" };
    await store.putJSON(pathname, { count: rec.count + 1 }, { overwrite: true });
    return { ok: true };
  } catch (err) {
    safeLog("ratelimit-store-error", { component: scope, code: err && err.code });
    return failOpen ? { ok: true, reason: "store-unavailable" } : { ok: false, reason: "store-unavailable" };
  }
}

/** Count without incrementing (used for login failure lockout). */
export async function peekCount({ scope, id, windowMs, now = Date.now() }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const rec = await getStore().getJSON(`ratelimit/${scope}/${id}/${windowStart}.json`);
  return rec ? Number(rec.count) || 0 : 0;
}

export async function bump({ scope, id, windowMs, now = Date.now() }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const pathname = `ratelimit/${scope}/${id}/${windowStart}.json`;
  const store = getStore();
  const rec = (await store.getJSON(pathname)) || { count: 0 };
  await store.putJSON(pathname, { count: rec.count + 1 }, { overwrite: true });
  return rec.count + 1;
}
