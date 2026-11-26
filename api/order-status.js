// POST /api/order-status  { orderId, email }  or  { orderId, token }
// Customer order lookup. The order id alone is never enough: the caller must also prove
// ownership with the order email or the lookup token returned at checkout. Wrong proof and
// unknown orders get the same 404, so the endpoint does not reveal which order ids exist.
// POST (not GET) keeps the email and token out of URLs, browser history and access logs.
import { json, readJson, ipHash, originAllowed, sha256, secretsEqual, safeLog } from "../lib/http.js";
import { rateLimit } from "../lib/ratelimit.js";
import { getOrder, validOrderId, customerView } from "../lib/orders.js";
import { storeConfigured } from "../lib/store.js";

export const LOOKUP_RATE = { max: 10, windowMs: 15 * 60 * 1000 };
const NOT_FOUND = { ok: false, error: "We could not find an order with those details." };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed." });
  }
  if (!originAllowed(req)) return json(res, 403, { ok: false, error: "Forbidden." });
  let data;
  try {
    data = await readJson(req, 2000);
  } catch {
    return json(res, 400, { ok: false, error: "Invalid request." });
  }
  const allowed = new Set(["orderId", "email", "token"]);
  for (const k of Object.keys(data)) if (!allowed.has(k)) return json(res, 400, { ok: false, error: "Invalid request." });
  const orderId = typeof data.orderId === "string" ? data.orderId.trim().toUpperCase() : "";
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const token = typeof data.token === "string" ? data.token.trim() : "";
  if (!validOrderId(orderId)) return json(res, 400, { ok: false, error: "Please enter a valid order number." });
  if (!email && !token) return json(res, 403, { ok: false, error: "Enter the email used for the order." });
  if (email.length > 120 || token.length > 64) return json(res, 400, { ok: false, error: "Invalid request." });
  if (!storeConfigured()) return json(res, 503, { ok: false, error: "Order lookup is not configured.", status: "Not configured" });

  const rl = await rateLimit({ scope: "order-lookup", id: ipHash(req), ...LOOKUP_RATE, failOpen: false });
  if (!rl.ok) return json(res, 429, { ok: false, error: "Too many lookups. Please try again later." }, { "Retry-After": "900" });

  let order;
  try {
    order = await getOrder(orderId);
  } catch (err) {
    safeLog("order-lookup-failed", { code: err && err.name });
    return json(res, 503, { ok: false, error: "Order lookup is temporarily unavailable." });
  }
  if (!order) return json(res, 404, NOT_FOUND);
  const emailOk = Boolean(email) && secretsEqual(email, order.customer && order.customer.email);
  const tokenOk = Boolean(token) && Boolean(order.lookupTokenHash) && secretsEqual(sha256(token), order.lookupTokenHash);
  if (!emailOk && !tokenOk) return json(res, 404, NOT_FOUND);
  return json(res, 200, { ok: true, order: customerView(order) });
}
