import { put, list } from "@vercel/blob";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const PAYMENT_METHODS = {
  none: "none",
  cod: "Cash on Delivery (Bangladesh)",
  bkash: "bKash (we'll contact you with payment details)",
  nagad: "Nagad (we'll contact you with payment details)",
};
const BD_PAYMENTS = ["cod", "bkash", "nagad"];

function isInquiryProduct(product) {
  return !product || product.orderMode === "inquiry" || product.priceStatus === "coming_soon" || product.price == null;
}

function fxConfig(catalog) {
  const fx = catalog.currency || {};
  const rate = Number(fx.rates && fx.rates.BDT);
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : 124.75,
    note: fx.note || "Fixed site rate: 1 USD = 124.75 BDT. Not a live bank rate.",
    source: fx.source || "Bangladesh Bank weighted average, 19 November 2026",
  };
}

function toBdt(usd, rate) {
  return Math.round(Number(usd) * rate * 100) / 100;
}


const COUNTRIES = [
  "Bangladesh",
  "United Arab Emirates (Dubai / GCC)",
  "United States",
  "United Kingdom",
  "European Union",
];

const MAX_BODY = 20_000;
const MAX_QTY = 20;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;
const rateBucket = new Map();

function loadCatalog() {
  const raw = readFileSync(join(process.cwd(), "data", "products.json"), "utf8");
  return JSON.parse(raw);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

function validPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 && /^[+\d][\d\s()-]{7,24}$/.test(phone);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clientIp(req) {
  // Vercel sets x-real-ip / x-vercel-forwarded-for itself; prefer those over a client-supplied x-forwarded-for.
  const vercelIp = req.headers["x-vercel-forwarded-for"] || req.headers["x-real-ip"];
  if (typeof vercelIp === "string" && vercelIp.trim()) return vercelIp.split(",")[0].trim();
  const fwd = req.headers["x-forwarded-for"];
  const raw = (typeof fwd === "string" ? fwd.split(",")[0] : "") || req.headers["x-real-ip"] || "";
  return String(raw).trim() || "unknown";
}

// Fast per-instance first layer. Serverless instances do not share memory,
// so durableRateLimit() below enforces the same limit across instances via Blob storage.
function rateLimit(ip) {
  const now = Date.now();
  if (rateBucket.size > 5000) {
    for (const [k, v] of rateBucket) if (now - v.start > RATE_WINDOW_MS) rateBucket.delete(k);
  }
  const rec = rateBucket.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    rateBucket.set(ip, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= RATE_MAX;
}

const ALLOWED_ORIGIN_HOSTS = new Set(["brandlinkerspark.com", "www.brandlinkerspark.com"]);
// Only this project's own preview deployments, not any *.vercel.app site.
const PREVIEW_HOST_RE = /^brandlinker-spark-[a-z0-9-]+-brandlinker2025-4101s-projects\.vercel\.app$/;

function allowOrigin(req) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  if (!origin) return true;
  try {
    const { host: oh } = new URL(origin);
    return oh === host || ALLOWED_ORIGIN_HOSTS.has(oh) || PREVIEW_HOST_RE.test(oh);
  } catch {
    return false;
  }
}

async function durableRateLimit(ipHash) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return true;
  const pathname = `ratelimit/${ipHash}.json`;
  const now = Date.now();
  try {
    let rec = null;
    const found = await list({ prefix: pathname, token, limit: 1 });
    const blob = (found.blobs || []).find((b) => b.pathname === pathname);
    if (blob) {
      const r = await fetch(blob.url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (r.ok) rec = await r.json().catch(() => null);
    }
    if (!rec || !Number.isFinite(rec.start) || now - rec.start > RATE_WINDOW_MS) rec = { start: now, count: 0 };
    if (rec.count >= RATE_MAX) return false;
    rec.count += 1;
    await put(pathname, JSON.stringify(rec), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      token,
    });
    return true;
  } catch (err) {
    // Fail open: a storage hiccup must not block real customers.
    console.error("ratelimit-failed", err && err.message);
    return true;
  }
}

function secretsEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  if (A.length === 0 || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function adminAuthorized(req) {
  const secret = process.env.ORDER_ADMIN_SECRET || "";
  if (!secret) return false;
  const header = String(req.headers["x-order-admin-secret"] || "");
  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  // The secret is accepted only in a header. A ?secret= query string would end up in logs and browser history.
  return secretsEqual(header, secret) || secretsEqual(bearer, secret);
}

function priceOf(product) {
  return Number(product.price);
}

function buildOrderId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `BLS-${ymd}-${rand}`;
}

function tally(catalog, items, promoCode, { inquiry = false, currency = "USD" } = {}) {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const lines = [];
  let subtotal = 0;
  for (const raw of items) {
    const id = clean(raw && raw.id, 40);
    const variant = clean(raw && raw.variant, 80);
    const qty = Number(raw && raw.qty);
    const product = byId.get(id);
    if (!product) throw Object.assign(new Error("Unknown product in cart."), { status: 400 });
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw Object.assign(new Error("Invalid quantity."), { status: 400 });
    }
    if (product.variants && product.variants.length && !product.variants.includes(variant)) {
      throw Object.assign(new Error("Invalid product option."), { status: 400 });
    }
    if (inquiry) {
      if (!isInquiryProduct(product)) {
        throw Object.assign(new Error("This item is not available as a pre-order request."), { status: 400 });
      }
      lines.push({
        id: product.id,
        name: product.name,
        variant: variant || (product.variants && product.variants[0]) || "Standard",
        qty,
        unitPrice: null,
        lineTotal: null,
        currency: null,
        priceStatus: "coming_soon",
      });
      continue;
    }
    if (isInquiryProduct(product)) {
      throw Object.assign(new Error("This item does not have a price yet. Please send a pre-order request."), { status: 400 });
    }
    const unit = priceOf(product);
    if (!Number.isFinite(unit) || unit < 0) {
      throw Object.assign(new Error("Product price is unavailable."), { status: 400 });
    }
    const lineTotal = unit * qty;
    subtotal += lineTotal;
    lines.push({
      id: product.id,
      name: product.name,
      variant,
      qty,
      unitPrice: unit,
      lineTotal,
      currency: "USD",
    });
  }
  if (!lines.length) throw Object.assign(new Error("Your cart is empty."), { status: 400 });

  if (inquiry) {
    return {
      items: lines,
      subtotal: null,
      discount: null,
      total: null,
      totalUsd: null,
      totalBdt: null,
      promo: null,
      currency: null,
      priceStatus: "price confirmed by email",
    };
  }

  const code = clean(promoCode, 24).toUpperCase();
  let promo = null;
  let discount = 0;
  if (code) {
    const offer = catalog.promoCodes && catalog.promoCodes[code];
    if (!offer) throw Object.assign(new Error("That promo code is not valid."), { status: 400 });
    if (offer.type === "percent") discount = subtotal * (Number(offer.value) / 100);
    promo = { code, label: offer.label || code, type: offer.type, value: offer.value };
  }
  const totalUsd = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  const fx = fxConfig(catalog);
  const cur = currency === "BDT" ? "BDT" : "USD";
  const total = cur === "BDT" ? toBdt(totalUsd, fx.rate) : totalUsd;
  return {
    items: lines,
    subtotal: Math.round(subtotal * 100) / 100,
    subtotalBdt: toBdt(subtotal, fx.rate),
    discount: Math.round(discount * 100) / 100,
    discountBdt: toBdt(discount, fx.rate),
    totalUsd,
    totalBdt: toBdt(totalUsd, fx.rate),
    total,
    currency: cur,
    promo,
    fxRate: fx.rate,
    fxNote: fx.note,
    priceStatus: "priced",
  };
}

async function saveOrder(order) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error("Order storage is not configured."), { status: 503 });
  const pathname = `orders/${order.id}.json`;
  const blob = await put(pathname, JSON.stringify(order, null, 2), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
    token,
  });
  return { pathname, url: blob.url };
}

async function listOrders() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error("Order storage is not configured."), { status: 503 });
  const result = await list({ prefix: "orders/", token });
  const blobs = result.blobs || [];
  const orders = [];
  for (const blob of blobs.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))) {
    const res = await fetch(blob.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    orders.push(await res.json());
  }
  return orders;
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
    const hint = typeof payload.message === "string" ? payload.message.slice(0, 180) : "";
    console.error("order-email-failed", "resend", response.status, hint);
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

async function handleCreate(req, res) {
  if (!allowOrigin(req)) return json(res, 403, { ok: false, error: "Forbidden." });
  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return json(res, 429, { ok: false, error: "Please wait a few minutes and try again." });
  }

  let data;
  try {
    const raw = await readBody(req, MAX_BODY);
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    const status = err.status || 400;
    return json(res, status, { ok: false, error: status === 413 ? "Payload too large." : "Invalid request." });
  }

  // Honeypot: pretend success, do not save or email.
  if (clean(data.website, 200) || clean(data.company, 200)) {
    return json(res, 200, { ok: true, orderId: `BLS-${Date.now()}`, ignored: true });
  }

  const name = clean(data.name, 80);
  const email = clean(data.email, 120).toLowerCase();
  const phone = clean(data.phone, 24);
  const address = clean(data.address, 240);
  const country = clean(data.country, 80);
  const paymentKey = clean(data.paymentMethod, 20).toLowerCase();
  const note = clean(data.note, 500);
  const rawType = clean(data.type, 32).toLowerCase();
  const currencyPref = clean(data.currency, 8).toUpperCase() === "BDT" ? "BDT" : "USD";
  // Only an explicit [TEST] tag marks a test order, so real customers named "Test..." are never dropped.
  const isTest = data.isTest === true || /\[TEST\]/i.test(`${name} ${note}`);

  if (!name) return json(res, 400, { ok: false, error: "Please enter your full name." });
  if (!validEmail(email)) return json(res, 400, { ok: false, error: "Please enter a valid email address." });
  if (!validPhone(phone)) return json(res, 400, { ok: false, error: "Please enter a valid phone number." });
  if (!COUNTRIES.includes(country)) return json(res, 400, { ok: false, error: "Please choose a country or region." });

  const catalog = loadCatalog();
  const items = Array.isArray(data.items) ? data.items : [];
  let priced;
  try {
    const unpriced = items.every((it) => {
      const prod = catalog.products.find((x) => x.id === (it && it.id));
      return isInquiryProduct(prod);
    });
    priced = tally(catalog, items, data.promoCode, {
      inquiry: unpriced,
      currency: currencyPref,
    });
  } catch (err) {
    return json(res, err.status || 400, { ok: false, error: err.message || "Could not price this order." });
  }

  // Client type is advisory. Unpriced items and destinations we cannot ship to yet are pre-order requests.
  const unpricedOrder = priced.priceStatus === "price confirmed by email" || priced.total == null;
  const type = (unpricedOrder || shouldPreorder(country, items, catalog)) ? "preorder_request" : "order";
  if (type !== "preorder_request" && !address) return json(res, 400, { ok: false, error: "Please enter your address." });

  let paymentMethod = "none";
  let paymentMethodLabel = "none";
  if (type === "preorder_request") {
    paymentMethod = "none";
    paymentMethodLabel = "none";
  } else if (country === "Bangladesh") {
    if (!BD_PAYMENTS.includes(paymentKey)) {
      return json(res, 400, { ok: false, error: "Please choose Cash on Delivery, bKash, or Nagad." });
    }
    paymentMethod = paymentKey;
    paymentMethodLabel = PAYMENT_METHODS[paymentKey];
  } else if (country === "United States" || country === "United Kingdom") {
    paymentMethod = "none";
    paymentMethodLabel = "Payment options will be emailed";
  } else {
    return json(res, 400, { ok: false, error: "Please choose a country or region." });
  }

  const shippingNote = destinationShippingNote(country, items, catalog);

  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 16);
  if (!(await durableRateLimit(ipHash))) {
    return json(res, 429, { ok: false, error: "Please wait a few minutes and try again." });
  }

  const createdAt = new Date().toISOString();
  const id = buildOrderId();
  const order = {
    id,
    createdAt,
    isTest,
    type,
    currency: priced.currency,
    customer: { name, email, phone, address, country },
    note,
    paymentMethod,
    paymentMethodLabel,
    paymentStatus: type === "preorder_request" ? "pending" : "pending",
    priceStatus: priced.priceStatus,
    items: priced.items,
    subtotal: priced.subtotal,
    subtotalBdt: priced.subtotalBdt,
    discount: priced.discount,
    discountBdt: priced.discountBdt,
    total: priced.total,
    totalUsd: priced.totalUsd,
    totalBdt: priced.totalBdt,
    fxRate: priced.fxRate || null,
    fxNote: priced.fxNote || null,
    promo: priced.promo,
    shippingNote: shippingNote || "",
    ipHash,
  };

  let stored;
  try {
    stored = await saveOrder(order);
  } catch (err) {
    console.error("order-store-failed", err && err.message);
    return json(res, err.status || 500, { ok: false, error: "We could not save your order. Please try again." });
  }

  const mail = await emailOrder(order).catch((err) => ({ sent: false, error: err.message || "Email failed." }));
  if (!mail.sent) console.error("order-email-failed", mail.error);

  return json(res, 200, {
    ok: true,
    orderId: id,
    total: order.total,
    currency: order.currency,
    emailSent: Boolean(mail.sent),
    emailProvider: mail.provider || null,
    stored: true,
    isTest,
    type: order.type,
    country: order.customer.country,
    shippingNote: order.shippingNote || "",
    priceStatus: order.priceStatus,
    paymentMethod,
    paymentStatus: order.paymentStatus,
    totalUsd: order.totalUsd,
    totalBdt: order.totalBdt,
  });
}

async function handleList(req, res) {
  if (!process.env.ORDER_ADMIN_SECRET) return json(res, 403, { ok: false, error: "Forbidden." });
  if (!adminAuthorized(req)) return json(res, 401, { ok: false, error: "Unauthorized." });
  try {
    const orders = await listOrders();
    return json(res, 200, { ok: true, count: orders.length, orders });
  } catch (err) {
    return json(res, err.status || 500, { ok: false, error: "Could not load orders." });
  }
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method === "POST") return await handleCreate(req, res);
    if (req.method === "GET") return await handleList(req, res);
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("orders-handler", err && err.message);
    return json(res, 500, { ok: false, error: "Something went wrong. Please try again." });
  }
}
