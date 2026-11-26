import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import orders from "../api/orders.js";
import session from "../api/admin/session.js";
import adminOrders from "../api/admin/orders.js";
import catalog from "../api/admin/catalog.js";
import { setup, call, validOrder, freshIp, ADMIN_SECRET } from "./helpers.js";

const ORIGIN = { origin: "https://brandlinkerspark.com" };
beforeEach(() => setup());

async function loginCookie(ip = freshIp()) {
  const r = await call(session, { body: { secret: ADMIN_SECRET }, ip, headers: ORIGIN });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = r.headers["set-cookie"];
  return c.split(";")[0];
}

test("admin endpoints return 401 without a session", async () => {
  for (const [h, method] of [[orders, "GET"], [adminOrders, "GET"], [catalog, "GET"], [session, "GET"]]) {
    const r = await call(h, { method, ip: freshIp() });
    assert.equal(r.statusCode, 401, `${method} -> ${r.statusCode}`);
  }
});

test("legacy header secret no longer grants access", async () => {
  const r = await call(orders, { method: "GET", headers: { "x-order-admin-secret": ADMIN_SECRET }, ip: freshIp() });
  assert.equal(r.statusCode, 401);
});

test("wrong secret is 401; cookie is HttpOnly Secure SameSite=Strict with expiry", async () => {
  const bad = await call(session, { body: { secret: "wrong-secret-xxxxx" }, ip: freshIp(), headers: ORIGIN });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers["set-cookie"], undefined);
  const ok = await call(session, { body: { secret: ADMIN_SECRET }, ip: freshIp(), headers: ORIGIN });
  const c = ok.headers["set-cookie"];
  assert.match(c, /^__Host-spark_admin=/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert.ok(c.includes(attr), attr);
});

test("login without a same-site Origin is refused", async () => {
  const r = await call(session, { body: { secret: ADMIN_SECRET }, ip: freshIp() });
  assert.equal(r.statusCode, 403);
});

test("brute force: after 5 failures the IP is locked out even with the right secret", async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) {
    const r = await call(session, { body: { secret: `bad-${i}-xxxxxxxxxxxx` }, ip, headers: ORIGIN });
    assert.equal(r.statusCode, 401);
  }
  const locked = await call(session, { body: { secret: ADMIN_SECRET }, ip, headers: ORIGIN });
  assert.equal(locked.statusCode, 429);
});

test("fails closed: missing or short ORDER_ADMIN_SECRET => 503 on login, 401 on data", async () => {
  process.env.ORDER_ADMIN_SECRET = "short";
  const r = await call(session, { body: { secret: "short" }, ip: freshIp(), headers: ORIGIN });
  assert.equal(r.statusCode, 503);
  delete process.env.ORDER_ADMIN_SECRET;
  const r2 = await call(session, { body: { secret: "" }, ip: freshIp(), headers: ORIGIN });
  assert.equal(r2.statusCode, 503);
  const r3 = await call(adminOrders, { method: "GET", ip: freshIp() });
  assert.equal(r3.statusCode, 401);
});

test("session works, expires and logout revokes it server-side", async () => {
  const cookie = await loginCookie();
  const s = await call(session, { method: "GET", headers: { cookie } });
  assert.equal(s.statusCode, 200);
  assert.equal(s.body.integrations.centralDb, "Not configured");
  assert.ok(s.body.integrations.suppliers.every((x) => x.stockVerified === false));
  const list = await call(adminOrders, { method: "GET", headers: { cookie } });
  assert.equal(list.statusCode, 200);
  const out = await call(session, { method: "DELETE", headers: { cookie, ...ORIGIN } });
  assert.match(out.headers["set-cookie"], /Max-Age=0/);
  const after = await call(adminOrders, { method: "GET", headers: { cookie } });
  assert.equal(after.statusCode, 401, "replaying the old cookie after logout fails");
});

test("expired session is rejected", async () => {
  const { store } = setup();
  const cookie = await loginCookie();
  for (const [k, v] of store.data) {
    if (k.startsWith("admin-sessions/")) {
      const rec = JSON.parse(v.v);
      rec.expiresAt = Date.now() - 1;
      store.data.set(k, { ...v, v: JSON.stringify(rec) });
    }
  }
  const r = await call(adminOrders, { method: "GET", headers: { cookie } });
  assert.equal(r.statusCode, 401);
});

test("admin updates enforce the order lifecycle, tracking and refund rules", async () => {
  const created = await call(orders, { body: validOrder(), ip: freshIp() });
  const orderId = created.body.orderId;
  const cookie = await loginCookie();
  const post = (body, headers = ORIGIN) => call(adminOrders, { body: { orderId, ...body }, headers: { cookie, ...headers } });
  assert.equal((await post({ status: "shipped" })).statusCode, 409, "pending -> shipped not allowed");
  assert.equal((await post({ status: "confirmed" }, {})).statusCode, 403, "state change without Origin refused (CSRF)");
  assert.equal((await post({ status: "confirmed" })).statusCode, 200);
  assert.equal((await post({ status: "processing" })).statusCode, 200);
  assert.equal((await post({ status: "shipped" })).statusCode, 400, "tracking required before shipped");
  assert.equal((await post({ tracking: { carrier: "DHL", number: "bad number!" } })).statusCode, 400);
  const shipped = await post({ status: "shipped", tracking: { carrier: "DHL", number: "JD0123456789", url: "https://www.dhl.com/track" } });
  assert.equal(shipped.statusCode, 200);
  assert.equal(shipped.body.order.tracking.number, "JD0123456789");
  assert.equal((await post({ status: "refund_requested" })).statusCode, 200);
  assert.equal((await post({ status: "refunded" })).statusCode, 409, "unpaid order cannot be refunded");
  assert.equal((await post({ paymentStatus: "paid" })).statusCode, 200);
  const refunded = await post({ status: "refunded" });
  assert.equal(refunded.statusCode, 200);
  assert.equal(refunded.body.order.paymentStatus, "refunded");
  assert.equal((await post({ status: "confirmed" })).statusCode, 409, "refunded is terminal");
  assert.ok(refunded.body.order.history.length >= 7);
  assert.equal(refunded.body.order.lookupTokenHash, undefined);
});

test("cancel is allowed before shipping and is terminal", async () => {
  const created = await call(orders, { body: validOrder(), ip: freshIp() });
  const cookie = await loginCookie();
  const post = (body) => call(adminOrders, { body: { orderId: created.body.orderId, ...body }, headers: { cookie, ...ORIGIN } });
  assert.equal((await post({ status: "cancelled" })).statusCode, 200);
  assert.equal((await post({ status: "confirmed" })).statusCode, 409);
});

test("catalog: landed cost, margin and owner-confirmed draft workflow", async () => {
  const cookie = await loginCookie();
  const post = (body) => call(catalog, { body, headers: { cookie, ...ORIGIN } });
  const lc = await post({ action: "landed-cost", productCost: 1200, shipping: 450, duties: 90, fees: 75, salePrice: 2499 });
  assert.equal(lc.statusCode, 200);
  assert.equal(lc.body.landedMinor, 1815);
  assert.equal(lc.body.margin.marginMinor, 684);
  assert.equal(lc.body.margin.marginBps, 2737);
  assert.equal((await post({ action: "landed-cost", productCost: 12.5 })).statusCode, 400, "floats rejected");

  const created = await post({ action: "create-draft", draft: { name: "Test cube", supplierId: "cj", supplierRef: "CJ-123", salePriceMinor: 2499, cost: { productCost: 1200, shipping: 450, duties: 90, fees: 75 } } });
  assert.equal(created.statusCode, 201);
  const d = created.body.draft;
  assert.equal(d.state, "draft");
  assert.equal(d.stockVerified, false);
  assert.equal((await post({ action: "transition", draftId: d.id, to: "published", confirm: d.id })).statusCode, 409, "cannot skip approval");
  assert.equal((await post({ action: "transition", draftId: d.id, to: "approved" })).statusCode, 400, "owner confirmation required");
  assert.equal((await post({ action: "transition", draftId: d.id, to: "approved", confirm: d.id })).statusCode, 200);
  const pub = await post({ action: "transition", draftId: d.id, to: "published", confirm: d.id });
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.body.draft.state, "published");

  const loss = await post({ action: "create-draft", draft: { name: "Loss item", supplierId: "manual", salePriceMinor: 1000, cost: { productCost: 1200 } } });
  const ld = loss.body.draft;
  await post({ action: "transition", draftId: ld.id, to: "approved", confirm: ld.id });
  assert.equal((await post({ action: "transition", draftId: ld.id, to: "published", confirm: ld.id })).statusCode, 409, "negative margin cannot publish");

  const anon = await call(catalog, { body: { action: "landed-cost", productCost: 1 }, headers: ORIGIN });
  assert.equal(anon.statusCode, 401);
});
