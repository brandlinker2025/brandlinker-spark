import { test } from "node:test";
import assert from "node:assert/strict";
import { landedCost, margin, usdCentsToBdtPaisa, percentOf, toMinor } from "../lib/money.js";
import { supplierStatus, cjProductLookup } from "../lib/suppliers.js";
import { centralConfigured, mirrorOrder, orderSummary } from "../lib/central.js";

test("money math stays in integers", () => {
  assert.equal(toMinor(24.99), 2499);
  assert.equal(toMinor(0.1 + 0.2), 30);
  assert.equal(landedCost({ productCost: 1, shipping: 2, duties: 3, fees: 4 }), 10);
  assert.throws(() => landedCost({ productCost: -1 }));
  assert.equal(percentOf(4998, 10), 500);
  assert.equal(usdCentsToBdtPaisa(100, 124.75), 12475);
  assert.deepEqual(margin({ salePrice: 1000, landed: 1200 }), { salePrice: 1000, landed: 1200, marginMinor: -200, marginBps: -2000, profitable: false });
});

test("suppliers report Not configured without env credentials and never claim verification", async () => {
  delete process.env.CJ_API_KEY;
  const cj = supplierStatus("cj");
  assert.equal(cj.status, "Not configured");
  assert.equal(cj.stockVerified || cj.shippingVerified || cj.deliveryVerified, false);
  let called = false;
  const r = await cjProductLookup("ABCD-1234", async () => {
    called = true;
  });
  assert.equal(r.status, 503);
  assert.equal(called, false, "no network call without credentials");
});

test("central mirror is skipped unless all BL_* env vars are set, and carries no PII", async () => {
  for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "BL_CLIENT_ID", "BL_CLIENT_SECRET"]) delete process.env[k];
  assert.equal(centralConfigured(), false);
  const order = { id: "BLS-20261126-AAAAAAAAAA", type: "order", status: "pending", customer: { name: "Jane", email: "j@example.com", phone: "+1 415", address: "1 St", country: "United States" }, items: [{ id: "t01", qty: 2 }], currency: "USD", totalMinor: 4998, createdAt: "x" };
  assert.deepEqual(await mirrorOrder(order), { mirrored: false, status: "Not configured" });
  const s = JSON.stringify(orderSummary(order));
  for (const pii of ["Jane", "j@example.com", "+1 415", "1 St"]) assert.ok(!s.includes(pii));
  Object.assign(process.env, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "pk", BL_CLIENT_ID: "c", BL_CLIENT_SECRET: "s" });
  let sent;
  const res = await mirrorOrder(order, async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "job" }), { status: 200 });
  });
  assert.equal(res.mirrored, true);
  assert.match(sent.url, /\/rest\/v1\/rpc\/bl_enqueue_job$/);
  assert.equal(sent.body.p_idempotency_key, "spark-order-BLS-20261126-AAAAAAAAAA");
  const failed = await mirrorOrder(order, async () => new Response("{}", { status: 401 }));
  assert.equal(failed.status, "Failed");
  for (const k of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "BL_CLIENT_ID", "BL_CLIENT_SECRET"]) delete process.env[k];
});
