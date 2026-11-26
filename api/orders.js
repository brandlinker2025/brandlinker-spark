import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { json, readJson, ipHash, originAllowed, sha256, header, safeLog } from "../lib/http.js";
import { validateOrderRequest, IDEMPOTENCY_RE } from "../lib/order-schema.js";
import { toMinor, fromMinor, percentOf, usdCentsToBdtPaisa } from "../lib/money.js";
import { rateLimit } from "../lib/ratelimit.js";
import { getStore, AlreadyExists, StoreNotConfigured } from "../lib/store.js";
import { saveOrder, listOrders } from "../lib/orders.js";
import { requireAdmin } from "../lib/admin-auth.js";
import { mirrorOrder } from "../lib/central.js";

// Orders API.
// POST /api/orders  -> create an order or pre-order request (public, validated, rate limited, idempotent)
// GET  /api/orders  -> admin list (requires the admin session cookie; see /api/admin/session)

const PAYMENT_METHODS = {
  none: "none",
  cod: "Cash on Delivery (Bangladesh)",
  bkash: "bKash (we'll contact you with payment details)",
  nagad: "Nagad (we'll contact you with payment details)",
};
const BD_PAYMENTS = ["cod", "bkash", "nagad"];
const MAX_BODY = 20_000;
export const ORDER_RATE = { max: 5, windowMs: 15 * 60 * 1000 };
const IDEM_PENDING_MS = 60 * 1000;

let mailer = null;
export function setMailerForTests(fn) {
  mailer = fn;
}
let mirror = mirrorOrder;
export function setMirrorForTests(fn) {
  mirror = fn;
}

function isInquiryProduct(product) {
  return !product || product.orderMode === "inquiry" || product.priceStatus === "coming_soon" || product.price == null;
}

function fxConfig(catalog) {
  const fx = catalog.currency || {};
  const rate = Number(fx.rates && fx.rates.BDT);
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : 124.75,
    note: fx.note || "Fixed site rate: 1 USD = 124.75 BDT. Not a live bank rate.",
  };
}

export function loadCatalog() {
  const raw = readFileSync(join(process.cwd(), "data", "products.json"), "utf8");
  return JSON.parse(raw);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function buildOrderId(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += B32[bytes[i] & 31];
  return `BLS-${ymd}-${s}`;
}

/** Server-side pricing. Client prices are never read (the schema rejects them). */
export function tally(catalog, items, promoCode, { inquiry = false, currency = "USD" } = {}) {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const lines = [];
  let subtotalMinor = 0;
  for (const raw of items) {
    const product = byId.get(raw.id);
    if (!product) throw httpError(400, "Unknown product in cart.");
    const variant = raw.variant;
    if (product.variants && product.variants.length && !product.variants.includes(variant)) {
      throw httpError(400, "Invalid product option.");
    }
    if (inquiry) {
      if (!isInquiryProduct(product)) throw httpError(400, "This item is not available as a pre-order request.");
      lines.push({
        id: product.id,
        name: product.name,
        variant: variant || (product.variants && product.variants[0]) || "Standard",
        qty: raw.qty,
        unitPrice: null,
        lineTotal: null,
        currency: null,
        priceStatus: "coming_soon",
      });
      continue;
    }
    if (isInquiryProduct(product)) throw httpError(400, "This item does not have a price yet. Please send a pre-order request.");
    const unitMinor = toMinor(product.price);
    const lineMinor = unitMinor * raw.qty;
    subtotalMinor += lineMinor;
    lines.push({
      id: product.id,
      name: product.name,
      variant,
      qty: raw.qty,
      unitPrice: fromMinor(unitMinor),
      unitPriceMinor: unitMinor,
      lineTotal: fromMinor(lineMinor),
      lineTotalMinor: lineMinor,
      currency: "USD",
    });
  }
  if (!lines.length) throw httpError(400, "Your cart is empty.");
  if (inquiry) {
    return { items: lines, subtotal: null, discount: null, total: null, totalUsd: null, totalBdt: null, promo: null, currency: null, priceStatus: "price confirmed by email" };
  }
  const code = String(promoCode || "").toUpperCase();
  let promo = null;
  let discountMinor = 0;
  if (code) {
    const offer = catalog.promoCodes && catalog.promoCodes[code];
    if (!offer) throw httpError(400, "That promo code is not valid.");
    if (offer.type === "percent") discountMinor = percentOf(subtotalMinor, Number(offer.value));
    promo = { code, label: offer.label || code, type: offer.type, value: offer.value };
  }
  const totalUsdMinor = Math.max(0, subtotalMinor - discountMinor);
  const fx = fxConfig(catalog);
  const cur = currency === "BDT" ? "BDT" : "USD";
  const totalBdtMinor = usdCentsToBdtPaisa(totalUsdMinor, fx.rate);
  const totalMinor = cur === "BDT" ? totalBdtMinor : totalUsdMinor;
  return {
    items: lines,
    subtotal: fromMinor(subtotalMinor),
    subtotalMinor,
    subtotalBdt: fromMinor(usdCentsToBdtPaisa(subtotalMinor, fx.rate)),
    discount: fromMinor(discountMinor),
    discountMinor,
    discountBdt: fromMinor(usdCentsToBdtPaisa(discountMinor, fx.rate)),
    totalUsd: fromMinor(totalUsdMinor),
    totalUsdMinor,
    totalBdt: fromMinor(totalBdtMinor),
    totalBdtMinor,
    total: fromMinor(totalMinor),
    totalMinor,
    currency: cur,
    promo,
    fxRate: fx.rate,
    fxNote: fx.note,
    priceStatus: "priced",
  };
}

function buildOrderEmailText(order) {
  const itemLines = order.items
    .map((i) => {
      if (i.unitPrice == null || i.lineTotal == null) {
        return `  - ${i.name} (${i.variant}) x${i.qty} — Price coming soon`;
      }
      return `  - ${i.name} (${i.variant}) x${i.qty} @ $${Number(i.unitPrice).toFixed(2)} = $${Number(i.lineTotal).toFixed(2)} USD`;
    })
    .join("\n");
  const promoLine = order.promo ? `${order.promo.code} (${order.promo.label})` : "None";
  const testBanner = order.isTest ? "THIS IS A TEST ORDER.\n\n" : "";
  const preorder = order.type === "preorder_request";
  const preorderFlag = preorder
    ? "TYPE: preorder_request\nPayment method: none\nACTION REQUIRED: Email the customer available payment options to confirm this order.\n\n"
    : "";
  return (
    `${testBanner}${preorderFlag}A new BrandLinker Spark ${preorder ? "pre-order request" : "order"} was saved.\n\n` +
    `Order ID: ${order.id}\n` +
    `Time (UTC): ${order.createdAt}\n` +
    `Payment: ${order.paymentMethodLabel}\n` +
    `Payment status: ${order.paymentStatus}\n` +
    `Customer: ${order.customer.name}\n` +
    `Email: ${order.customer.email}\n` +
    `Phone: ${order.customer.phone}\n` +
    `Address: ${order.customer.address}\n` +
    `Country: ${order.customer.country}\n` +
    `Order note: ${order.note || "(none)"}\n\n` +
    `Items:\n${itemLines}\n\n` +
    (order.type === "preorder_request" && (order.total == null || order.priceStatus === "price confirmed by email")
      ? `Totals: to be confirmed by email.\n\n`
      : `Subtotal: $${Number(order.subtotal || 0).toFixed(2)} USD (BDT ${Number(order.subtotalBdt || 0).toFixed(2)})\n` +
        `Promo: ${promoLine}\n` +
        `Discount: $${Number(order.discount).toFixed(2)} USD\n` +
        `Total: ${order.currency} ${Number(order.total).toFixed(2)} (USD ${Number(order.totalUsd).toFixed(2)} / BDT ${Number(order.totalBdt).toFixed(2)})\n` +
        `FX: 1 USD = ${order.fxRate} BDT (fixed site rate, not a live bank rate)\n\n`) +
    (order.shippingNote ? `Shipping: ${order.shippingNote}\n\n` : "") +
    (order.total == null || order.priceStatus === "price confirmed by email"
      ? `No payment has been taken online. Contact the customer to confirm the price, payment and delivery.`
      : `No payment has been taken online. Contact the customer to confirm payment and delivery. The prices and destination country above are part of this order.`)
  );
}

function orderEmailSubject(order) {
  const preorder = order.type === "preorder_request";
  const kind = preorder ? "pre-order request" : "order";
  const preTag = preorder ? "Email payment options — " : "";
  return `${order.isTest ? "[TEST] " : ""}${preTag}Spark ${kind} ${order.id} — ${order.customer.name}`;
}

async function emailOrderViaResend(order, { to, from, subject, text }) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: String(from),
      to: [String(to)],
      subject: String(subject),
      text: String(text || ""),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    safeLog("order-email-failed", { provider: "resend", status: response.status, orderId: order.id });
    return { sent: false, provider: "resend", error: "Email provider rejected the message.", status: response.status };
  }
  return { sent: true, provider: "resend", emailId: payload.id || null };
}

async function emailOrderViaFormSubmit(order, { to, text }) {
  const url = `https://formsubmit.co/ajax/${encodeURIComponent(to)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://brandlinkerspark.com",
      Referer: "https://brandlinkerspark.com/",
    },
    body: JSON.stringify({
      _subject: `New Spark order ${order.id}`,
      _template: "table",
      _captcha: "false",
      name: "BrandLinker Spark",
      message: text,
      order_id: order.id,
      type: order.type || "order",
      is_test: order.isTest ? "yes" : "no",
      customer_name: order.customer.name,
      customer_email: order.customer.email,
      customer_phone: order.customer.phone,
      customer_address: order.customer.address,
      customer_country: order.customer.country,
      destination_country: order.customer.country,
      order_total: order.total == null ? "" : String(order.total),
      order_currency: order.currency || "",
      shipping_note: order.shippingNote || "",
      payment: order.paymentMethodLabel,
      payment_status: order.paymentStatus,
      note: order.note || "",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      sent: false,
      provider: "formsubmit",
      error: "FormSubmit rejected the message.",
      status: response.status,
      detail: typeof payload.message === "string" ? payload.message : "",
    };
  }
  return {
    sent: true,
    provider: "formsubmit",
    message: typeof payload.message === "string" ? payload.message : "",
  };
}

async function emailOrder(order) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  const to = (process.env.ORDER_NOTIFY_TO || "inforsfusionbd@gmail.com").trim();
  const from = (process.env.ORDER_FROM_EMAIL || "").trim();
  const text = buildOrderEmailText(order);
  const subject = orderEmailSubject(order);
  if (key && from) {
    return emailOrderViaResend(order, { to, from, subject, text });
  }
  return emailOrderViaFormSubmit(order, { to, text });
}


function hasFulfillment(product) {
  return Boolean(product && product.fulfillment && Array.isArray(product.fulfillment.orderableCountries));
}

function destinationShippingNote(country, itemRows, catalog) {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const prods = itemRows.map((i) => byId.get(i.id)).filter(Boolean);
  const travel = prods.filter(hasFulfillment);
  if (!travel.length) return "";
  if (country === "United States" || country === "United Kingdom") {
    const allOk = travel.every((p) => p.fulfillment.orderableCountries.includes(country));
    if (allOk) return `Free shipping to the ${country}. Delivery is usually 5-12 business days.`;
  }
  if (country === "United Arab Emirates (Dubai / GCC)") {
    return "UAE shipping coming soon.";
  }
  return `Shipping to ${country} for these travel items is not confirmed yet.`;
}

function shouldPreorder(country, itemRows, catalog) {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const prods = itemRows.map((i) => byId.get(i.id)).filter(Boolean);
  const travel = prods.filter(hasFulfillment);
  const others = prods.filter((p) => !hasFulfillment(p));
  if (country === "United States" || country === "United Kingdom") {
    const travelOk = travel.length && travel.every((p) => p.fulfillment.orderableCountries.includes(country));
    // Lifestyle items still use a pre-order request for destinations outside Bangladesh.
    if (travelOk && others.length === 0) return false;
    return true;
  }
  if (country === "Bangladesh") {
    // Do not take a Cash on Delivery order for travel items whose Bangladesh shipping is not confirmed.
    if (travel.length) return true;
    return false;
  }
  return true;
}

function idempotencyKeyFor(req, v) {
  const fromHeader = header(req, "idempotency-key").trim();
  const supplied = fromHeader || v.idempotencyKey || "";
  if (supplied) {
    if (!IDEMPOTENCY_RE.test(supplied)) throw httpError(400, "Invalid idempotency key.");
    return { key: `k:${supplied}`, supplied: true };
  }
  // No key from the client (e.g. a cached old page): fall back to a fingerprint of the
  // order content within a 10-minute bucket so an accidental double submit is still deduped.
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  return { key: `f:${bucket}:${requestHash(v)}`, supplied: false };
}

function requestHash(v) {
  const canonical = {
    name: v.name, email: v.email, phone: v.phone, address: v.address || "", country: v.country,
    paymentMethod: v.paymentMethod || "", note: v.note || "", promoCode: (v.promoCode || "").toUpperCase(),
    currency: v.currency, type: v.type || "", items: v.items.map((i) => [i.id, i.variant, i.qty]),
  };
  return sha256(JSON.stringify(canonical));
}

async function handleCreate(req, res) {
  if (!originAllowed(req)) return json(res, 403, { ok: false, error: "Forbidden." });
  const ctype = header(req, "content-type");
  if (ctype && !/^application\/json\b/i.test(ctype)) return json(res, 415, { ok: false, error: "Send JSON." });

  let data;
  try {
    data = await readJson(req, MAX_BODY);
  } catch (err) {
    const status = err.status === 413 ? 413 : 400;
    return json(res, status, { ok: false, error: status === 413 ? "Payload too large." : "Invalid request." });
  }

  // Honeypot: pretend success, do not save or email.
  if ((typeof data.website === "string" && data.website.trim()) || (typeof data.company === "string" && data.company.trim())) {
    return json(res, 200, { ok: true, orderId: buildOrderId(), ignored: true });
  }

  const checked = validateOrderRequest(data);
  if (!checked.ok) return json(res, 400, { ok: false, error: checked.error, field: checked.field });
  const v = checked.value;
  const isTest = v.isTest || /\[TEST\]/i.test(`${v.name} ${v.note || ""}`);

  const catalog = loadCatalog();
  let priced;
  try {
    const unpriced = v.items.every((it) => isInquiryProduct(catalog.products.find((x) => x.id === it.id)));
    priced = tally(catalog, v.items, v.promoCode, { inquiry: unpriced, currency: v.currency });
  } catch (err) {
    return json(res, err.status || 400, { ok: false, error: err.message || "Could not price this order." });
  }

  // Client type is advisory. Unpriced items and destinations we cannot ship to yet are pre-order requests.
  const unpricedOrder = priced.priceStatus === "price confirmed by email" || priced.total == null;
  const type = unpricedOrder || shouldPreorder(v.country, v.items, catalog) ? "preorder_request" : "order";
  if (type !== "preorder_request" && !v.address) return json(res, 400, { ok: false, error: "Please enter your address.", field: "address" });

  let paymentMethod = "none";
  let paymentMethodLabel = "none";
  if (type === "order") {
    if (v.country === "Bangladesh") {
      if (!BD_PAYMENTS.includes(v.paymentMethod)) {
        return json(res, 400, { ok: false, error: "Please choose Cash on Delivery, bKash, or Nagad.", field: "paymentMethod" });
      }
      paymentMethod = v.paymentMethod;
      paymentMethodLabel = PAYMENT_METHODS[v.paymentMethod];
    } else if (v.country === "United States" || v.country === "United Kingdom") {
      paymentMethodLabel = "Payment options will be emailed";
    } else {
      return json(res, 400, { ok: false, error: "Please choose a country or region.", field: "country" });
    }
  }

  let store;
  try {
    store = getStore();
  } catch (err) {
    if (err instanceof StoreNotConfigured) return json(res, 503, { ok: false, error: "Order storage is not configured.", status: "Not configured" });
    throw err;
  }

  let idem;
  try {
    idem = idempotencyKeyFor(req, v);
  } catch (err) {
    return json(res, 400, { ok: false, error: err.message, field: "idempotencyKey" });
  }
  // Scope the key to the customer email so one customer's key can never return another's order.
  const idemPath = `idempotency/${sha256(`${idem.key}|${v.email}`)}.json`;
  const reqHash = requestHash(v);

  const replay = async () => {
    const rec = await store.getJSON(idemPath);
    if (!rec) return null;
    if (rec.requestHash !== reqHash) {
      json(res, 409, { ok: false, error: "This idempotency key was already used for a different order." });
      return "handled";
    }
    if (rec.state === "done" && rec.response) {
      json(res, 200, { ...rec.response, duplicate: true });
      return "handled";
    }
    if (Date.now() - Number(rec.at || 0) < IDEM_PENDING_MS) {
      json(res, 409, { ok: false, error: "This order is already being processed. Please wait a moment." });
      return "handled";
    }
    return "stale";
  };

  const prior = await replay();
  if (prior === "handled") return;

  const ipId = ipHash(req);
  const rl = await rateLimit({ scope: "orders", id: ipId, ...ORDER_RATE, failOpen: true });
  if (!rl.ok) return json(res, 429, { ok: false, error: "Please wait a few minutes and try again." }, { "Retry-After": "900" });

  try {
    await store.putJSON(idemPath, { state: "pending", requestHash: reqHash, at: Date.now() }, { overwrite: prior === "stale" });
  } catch (err) {
    if (err instanceof AlreadyExists) {
      const again = await replay();
      if (again === "handled") return;
      return json(res, 409, { ok: false, error: "This order is already being processed. Please wait a moment." });
    }
    safeLog("order-idempotency-store-failed", { code: err && err.name });
    return json(res, 503, { ok: false, error: "We could not save your order. Please try again." });
  }

  const shippingNote = destinationShippingNote(v.country, v.items, catalog);
  const createdAt = new Date().toISOString();
  const id = buildOrderId();
  const lookupToken = randomBytes(24).toString("base64url");
  const order = {
    id,
    createdAt,
    updatedAt: createdAt,
    isTest,
    type,
    status: "pending",
    currency: priced.currency,
    customer: { name: v.name, email: v.email, phone: v.phone, address: v.address || "", country: v.country },
    note: v.note || "",
    paymentMethod,
    paymentMethodLabel,
    paymentStatus: "pending",
    priceStatus: priced.priceStatus,
    items: priced.items,
    subtotal: priced.subtotal,
    subtotalMinor: priced.subtotalMinor ?? null,
    subtotalBdt: priced.subtotalBdt,
    discount: priced.discount,
    discountMinor: priced.discountMinor ?? null,
    discountBdt: priced.discountBdt,
    total: priced.total,
    totalMinor: priced.totalMinor ?? null,
    totalUsd: priced.totalUsd,
    totalUsdMinor: priced.totalUsdMinor ?? null,
    totalBdt: priced.totalBdt,
    totalBdtMinor: priced.totalBdtMinor ?? null,
    fxRate: priced.fxRate || null,
    fxNote: priced.fxNote || null,
    promo: priced.promo,
    shippingNote: shippingNote || "",
    tracking: null,
    history: [{ at: createdAt, actor: "customer", to: "pending" }],
    idempotency: idem.supplied ? "client-key" : "fingerprint",
    lookupTokenHash: sha256(lookupToken),
    ipHash: ipId,
  };

  try {
    await saveOrder(order);
  } catch (err) {
    safeLog("order-store-failed", { code: err && err.name });
    await store.remove(idemPath).catch(() => {});
    return json(res, err.status || 500, { ok: false, error: "We could not save your order. Please try again." });
  }

  const mail = await (mailer || emailOrder)(order).catch((err) => ({ sent: false, error: (err && err.name) || "Email failed." }));
  if (!mail.sent) safeLog("order-email-failed", { provider: mail.provider, status: mail.status, orderId: id });
  const central = await mirror(order).catch(() => ({ mirrored: false, status: "Unavailable" }));

  const response = {
    ok: true,
    orderId: id,
    lookupToken,
    total: order.total,
    totalMinor: order.totalMinor,
    currency: order.currency,
    emailSent: Boolean(mail.sent),
    emailProvider: mail.provider || null,
    stored: true,
    isTest,
    type: order.type,
    status: order.status,
    country: order.customer.country,
    shippingNote: order.shippingNote || "",
    priceStatus: order.priceStatus,
    paymentMethod,
    paymentStatus: order.paymentStatus,
    totalUsd: order.totalUsd,
    totalBdt: order.totalBdt,
    centralMirror: central.status,
  };
  await store
    .putJSON(idemPath, { state: "done", requestHash: reqHash, at: Date.now(), orderId: id, response }, { overwrite: true })
    .catch((err) => safeLog("order-idempotency-finalize-failed", { code: err && err.name, orderId: id }));
  return json(res, 200, response);
}

async function handleList(req, res) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  try {
    const orders = await listOrders();
    return json(res, 200, { ok: true, count: orders.length, orders });
  } catch (err) {
    safeLog("order-list-failed", { code: err && err.name });
    return json(res, err.status || 500, { ok: false, error: "Could not load orders." });
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") return await handleCreate(req, res);
    if (req.method === "GET") return await handleList(req, res);
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    safeLog("orders-handler", { code: err && err.name });
    return json(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
}
