// Supplier registry. Credentials come only from env vars; nothing here places supplier orders,
// charges cards, or claims stock/shipping/delivery has been verified.

export const SUPPLIERS = {
  cj: {
    id: "cj",
    name: "CJdropshipping",
    env: ["CJ_API_KEY"],
    docs: "https://developers.cjdropshipping.com/",
    capabilities: ["product_lookup"],
  },
  aliexpress: {
    id: "aliexpress",
    name: "AliExpress Dropshipping API",
    env: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "ALIEXPRESS_ACCESS_TOKEN"],
    docs: "https://open.aliexpress.com/",
    capabilities: [],
  },
  manual: {
    id: "manual",
    name: "Manual sourcing (owner places supplier orders by hand)",
    env: [],
    capabilities: [],
  },
};

export function supplierStatus(id) {
  const s = SUPPLIERS[id];
  if (!s) return null;
  const configured = s.env.every((k) => Boolean((process.env[k] || "").trim()));
  return {
    id: s.id,
    name: s.name,
    configured: s.env.length === 0 ? true : configured,
    status: s.env.length === 0 ? "Not applicable" : configured ? "Configured but not verified" : "Not configured",
    stockVerified: false,
    shippingVerified: false,
    deliveryVerified: false,
    capabilities: s.capabilities,
  };
}

export function registry() {
  return Object.keys(SUPPLIERS).map(supplierStatus);
}

/**
 * Read-only CJ product lookup by product id (pid). Exchanges CJ_API_KEY for an access token.
 * Never called by tests or by the checkout. NOT TESTED against the real API.
 */
export async function cjProductLookup(pid, fetchImpl = fetch) {
  const key = (process.env.CJ_API_KEY || "").trim();
  if (!key) return { ok: false, status: 503, error: "CJdropshipping is not configured." };
  if (typeof pid !== "string" || !/^[A-Za-z0-9-]{4,64}$/.test(pid)) return { ok: false, status: 400, error: "Invalid product id." };
  const base = "https://developers.cjdropshipping.com/api2.0/v1";
  const t = await fetchImpl(`${base}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: key }),
    signal: AbortSignal.timeout(8000),
  });
  const tj = await t.json().catch(() => ({}));
  const token = tj && tj.data && tj.data.accessToken;
  if (!t.ok || !token) return { ok: false, status: 502, error: "CJdropshipping authentication failed." };
  const r = await fetchImpl(`${base}/product/query?pid=${encodeURIComponent(pid)}`, {
    headers: { "CJ-Access-Token": token },
    signal: AbortSignal.timeout(8000),
  });
  const rj = await r.json().catch(() => ({}));
  if (!r.ok || !rj || !rj.data) return { ok: false, status: 502, error: "CJdropshipping lookup failed." };
  const d = rj.data;
  return {
    ok: true,
    product: {
      pid: d.pid || pid,
      name: d.productNameEn || null,
      sellPriceUsd: d.sellPrice != null ? String(d.sellPrice) : null,
      // Supplier-reported data; not verified by Spark.
      verified: false,
    },
  };
}
