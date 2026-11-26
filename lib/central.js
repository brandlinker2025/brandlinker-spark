// Optional mirror of order summaries to the central BrandLinker DB via bl_enqueue_job.
// Only runs when SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, BL_CLIENT_ID and BL_CLIENT_SECRET are all set.
// The payload contains no customer PII (no name, email, phone or address).
import { safeLog } from "./http.js";

const NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "BL_CLIENT_ID", "BL_CLIENT_SECRET"];

export function centralConfigured() {
  return NAMES.every((k) => Boolean((process.env[k] || "").trim()));
}

export function orderSummary(order) {
  return {
    kind: "spark_order_summary",
    orderId: order.id,
    type: order.type,
    status: order.status,
    country: order.customer && order.customer.country,
    currency: order.currency,
    totalMinor: order.totalMinor ?? null,
    itemCount: (order.items || []).reduce((n, i) => n + i.qty, 0),
    productIds: (order.items || []).map((i) => i.id),
    isTest: Boolean(order.isTest),
    createdAt: order.createdAt,
  };
}

export async function rpc(fn, args, fetchImpl = fetch) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fn}`;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_client: process.env.BL_CLIENT_ID, p_secret: process.env.BL_CLIENT_SECRET, ...args }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body };
}

export async function mirrorOrder(order, fetchImpl = fetch) {
  if (!centralConfigured()) return { mirrored: false, status: "Not configured" };
  try {
    const r = await rpc(
      "bl_enqueue_job",
      {
        p_idempotency_key: `spark-order-${order.id}`,
        p_agent_id: "spark-orders",
        p_payload: orderSummary(order),
        p_requires_approval: true,
        p_target_platform: null,
        p_correlation_id: order.id,
      },
      fetchImpl,
    );
    if (!r.ok) {
      safeLog("central-mirror-failed", { status: r.status, orderId: order.id });
      return { mirrored: false, status: "Failed" };
    }
    return { mirrored: true, status: "Configured but not verified" };
  } catch (err) {
    safeLog("central-mirror-error", { code: err && err.name, orderId: order.id });
    return { mirrored: false, status: "Unavailable" };
  }
}
