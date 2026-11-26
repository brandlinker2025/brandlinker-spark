import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import orders, { ORDER_RATE } from "../api/orders.js";
import orderStatus from "../api/order-status.js";
import { setup, call, validOrder, freshIp } from "./helpers.js";

let ctx;
beforeEach(() => {
  ctx = setup();
});

const KEY = "order-1234567890abcdef";

test("valid order is priced from the server catalog in integer minor units", async () => {
  const r = await call(orders, { body: validOrder({ idempotencyKey: KEY }), ip: freshIp() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.type, "order");
  assert.equal(r.body.totalMinor, 4998);
  assert.equal(r.body.total, 49.98);
  assert.match(r.body.orderId, /^BLS-\d{8}-[A-Z2-7]{10}$/);
  const saved = await ctx.store.getJSON(`orders/${r.body.orderId}.json`);
  assert.equal(saved.items[0].unitPriceMinor, 2499);
  assert.equal(saved.status, "pending");
  assert.ok(saved.lookupTokenHash && !JSON.stringify(saved).includes(r.body.lookupToken), "raw lookup token is not stored");
});

test("price tampering: a client price on an item is rejected with 400", async () => {
  const body = validOrder({ items: [{ id: "t01", variant: "Beige", qty: 1, price: 0.01 }] });
  const r = await call(orders, { body, ip: freshIp() });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /Prices are set by the server/);
  assert.equal(ctx.store.data.size, 0, "nothing stored");
});

test("price tampering: a client total at the top level is rejected with 400", async () => {
  const r = await call(orders, { body: validOrder({ total: 1 }), ip: freshIp() });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.field, "total");
});

test("BDT total is computed server-side from the fixed rate", async () => {
  const r = await call(orders, { body: validOrder({ currency: "BDT" }), ip: freshIp() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.currency, "BDT");
  assert.equal(r.body.totalMinor, Math.round(4998 * 124.75));
});

test("promo code discount is integer and server-side", async () => {
  const r = await call(orders, { body: validOrder({ promoCode: "SPARK10" }), ip: freshIp() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.totalMinor, 4998 - 500);
});

test("duplicate order with the same idempotency key returns the same order", async () => {
  const ip = freshIp();
  const a = await call(orders, { body: validOrder({ idempotencyKey: KEY }), ip });
  const b = await call(orders, { body: validOrder({ idempotencyKey: KEY }), ip });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.orderId, a.body.orderId);
  assert.equal(b.body.duplicate, true);
  const stored = [...ctx.store.data.keys()].filter((k) => k.startsWith("orders/"));
  assert.equal(stored.length, 1);
  assert.equal(ctx.mails.length, 1, "notification sent once");
});

test("duplicate via Idempotency-Key header also dedupes", async () => {
  const ip = freshIp();
  const h = { "idempotency-key": "hdr-key-abcdefghijklmnop" };
  const a = await call(orders, { body: validOrder(), ip, headers: h });
  const b = await call(orders, { body: validOrder(), ip, headers: h });
  assert.equal(b.body.orderId, a.body.orderId);
});

test("double submit without a key is deduped by content fingerprint", async () => {
  const ip = freshIp();
  const a = await call(orders, { body: validOrder(), ip });
  const b = await call(orders, { body: validOrder(), ip });
  assert.equal(b.body.orderId, a.body.orderId);
});

test("same idempotency key with a different payload is 409", async () => {
  const ip = freshIp();
  await call(orders, { body: validOrder({ idempotencyKey: KEY }), ip });
  const b = await call(orders, { body: validOrder({ idempotencyKey: KEY, items: [{ id: "t01", variant: "Beige", qty: 3 }] }), ip });
  assert.equal(b.statusCode, 409);
});

test("invalid payloads return 400", async () => {
  const cases = [
    "not json",
    "[]",
    validOrder({ email: "nope" }),
    validOrder({ phone: "12" }),
    validOrder({ country: "Atlantis" }),
    validOrder({ items: [] }),
    validOrder({ items: [{ id: "t01", variant: "Beige", qty: 0 }] }),
    validOrder({ items: [{ id: "t01", variant: "Beige", qty: 1.5 }] }),
    validOrder({ items: [{ id: "t01", variant: "Beige", qty: "2" }] }),
    validOrder({ items: [{ id: "nope", variant: "x", qty: 1 }] }),
    validOrder({ items: [{ id: "t01", variant: "Purple", qty: 1 }] }),
    validOrder({ name: 123 }),
    validOrder({ admin: true }),
    validOrder({ currency: "EUR" }),
    validOrder({ idempotencyKey: "short" }),
    validOrder({ promoCode: "FREE100" }),
    validOrder({ isTest: "yes" }),
  ];
  for (const body of cases) {
    const r = await call(orders, { body, ip: freshIp() });
    assert.equal(r.statusCode, 400, `expected 400 for ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 120)} got ${r.statusCode}`);
  }
  assert.equal([...ctx.store.data.keys()].filter((k) => k.startsWith("orders/")).length, 0);
});

test("payload too large is 413", async () => {
  const r = await call(orders, { body: validOrder({ note: "x".repeat(25000) }), ip: freshIp() });
  assert.equal(r.statusCode, 413);
});

test("cross-site origin is refused", async () => {
  const r = await call(orders, { body: validOrder(), ip: freshIp(), headers: { origin: "https://evil.example" } });
  assert.equal(r.statusCode, 403);
});

test("rate limit: more than the limit from one IP gets 429", async () => {
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < ORDER_RATE.max + 2; i++) {
    const r = await call(orders, { body: validOrder({ idempotencyKey: `rate-key-${i}-abcdefghijkl` }), ip });
    codes.push(r.statusCode);
  }
  assert.deepEqual(codes.slice(0, ORDER_RATE.max), Array(ORDER_RATE.max).fill(200));
  assert.equal(codes[ORDER_RATE.max], 429);
});

test("storage not configured fails closed with 503 (no silent drop)", async () => {
  const { setStoreForTests } = await import("../lib/store.js");
  setStoreForTests(null);
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const r = await call(orders, { body: validOrder(), ip: freshIp() });
  if (saved !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved;
  assert.equal(r.statusCode, 503);
});

test("PII is never written to logs, even on failures", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    const { setMailerForTests } = await import("../api/orders.js");
    setMailerForTests(async () => ({ sent: false, provider: "test", status: 500, error: "boom jane.customer@example.com" }));
    await call(orders, { body: validOrder({ note: "Leave at door 4155550100" }), ip: freshIp() });
    await call(orders, { body: validOrder({ email: "bad" }), ip: freshIp() });
    await call(orderStatus, { body: { orderId: "BLS-20261126-AAAAAAAAAA", email: "jane.customer@example.com" }, ip: freshIp() });
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(lines.length > 0, "the email failure was logged");
  const joined = lines.join("\n");
  for (const pii of ["jane.customer@example.com", "Jane Customer", "415 555 0100", "4155550100", "Market St"]) {
    assert.ok(!joined.includes(pii), `log leaked ${pii}`);
  }
});

test("order lookup needs proof: id only 403, wrong email 404, right email 200, token 200", async () => {
  const created = await call(orders, { body: validOrder({ idempotencyKey: KEY }), ip: freshIp() });
  const id = created.body.orderId;
  const ip = freshIp();
  const noProof = await call(orderStatus, { body: { orderId: id }, ip });
  assert.equal(noProof.statusCode, 403);
  const wrong = await call(orderStatus, { body: { orderId: id, email: "attacker@example.com" }, ip });
  assert.equal(wrong.statusCode, 404);
  const wrongToken = await call(orderStatus, { body: { orderId: id, token: "x".repeat(32) }, ip });
  assert.equal(wrongToken.statusCode, 404);
  const unknown = await call(orderStatus, { body: { orderId: "BLS-20261126-AAAAAAAAAA", email: "jane.customer@example.com" }, ip });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.body, wrong.body, "unknown and wrong-proof responses are identical");
  const ok = await call(orderStatus, { body: { orderId: id, email: "JANE.customer@example.com" }, ip });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.order.id, id);
  assert.equal(ok.body.order.address, undefined);
  assert.ok(!JSON.stringify(ok.body).includes("+1 415"), "no phone in customer view");
  const byToken = await call(orderStatus, { body: { orderId: id, token: created.body.lookupToken }, ip });
  assert.equal(byToken.statusCode, 200);
  const get = await call(orderStatus, { method: "GET", ip });
  assert.equal(get.statusCode, 405);
});

test("order lookup is rate limited", async () => {
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await call(orderStatus, { body: { orderId: "BLS-20261126-AAAAAAAAAA", email: "x@example.com" }, ip });
    codes.push(r.statusCode);
  }
  assert.equal(codes[0], 404);
  assert.equal(codes[11], 429);
});

test("honeypot submissions are not stored", async () => {
  const r = await call(orders, { body: validOrder({ website: "http://spam" }), ip: freshIp() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ignored, true);
  assert.equal(ctx.store.data.size, 0);
});
