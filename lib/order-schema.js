// Strict schema for the public order request. Unknown fields are rejected, and any field
// that looks like a client-supplied price is rejected outright: prices come only from
// data/products.json on the server.

const TOP_FIELDS = {
  type: { max: 32 },
  name: { max: 80, required: true },
  email: { max: 120, required: true },
  phone: { max: 24, required: true },
  address: { max: 240 },
  country: { max: 80, required: true },
  paymentMethod: { max: 20 },
  note: { max: 500 },
  website: { max: 200 }, // honeypot
  company: { max: 200 }, // honeypot
  promoCode: { max: 24 },
  currency: { max: 8 },
  idempotencyKey: { max: 80 },
};
const ITEM_FIELDS = { id: { max: 40 }, variant: { max: 80 }, qty: {} };
const PRICE_FIELDS = new Set([
  "price", "prices", "unitPrice", "unit_price", "total", "totalUsd", "totalBdt", "subtotal",
  "discount", "amount", "lineTotal", "cost", "shippingCost", "fx", "fxRate",
]);
export const MAX_ITEMS = 20;
export const MAX_QTY = 20;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,80}$/;

export const COUNTRIES = [
  "Bangladesh",
  "United Arab Emirates (Dubai / GCC)",
  "United States",
  "United Kingdom",
  "European Union",
];

function fail(error, field) {
  return { ok: false, error, field };
}

export function normalize(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

export function validPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 && /^[+\d][\d\s()-]{7,24}$/.test(phone);
}

/** @returns {{ok:true, value:object} | {ok:false, error:string, field?:string}} */
export function validateOrderRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("Invalid request.");
  const out = {};
  for (const key of Object.keys(data)) {
    if (PRICE_FIELDS.has(key)) return fail("Prices are set by the server. Remove price fields from the request.", key);
    if (key === "items" || key === "isTest") continue;
    const spec = TOP_FIELDS[key];
    if (!spec) return fail(`Unknown field: ${key.slice(0, 40)}`, key);
    const v = data[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string") return fail(`${key} must be text.`, key);
    if (v.length > spec.max * 2) return fail(`${key} is too long.`, key);
    out[key] = normalize(v).slice(0, spec.max);
  }
  if (data.isTest !== undefined && typeof data.isTest !== "boolean") return fail("isTest must be true or false.", "isTest");
  out.isTest = data.isTest === true;
  for (const [key, spec] of Object.entries(TOP_FIELDS)) {
    if (spec.required && !out[key]) {
      const msg = { name: "Please enter your full name.", email: "Please enter a valid email address.", phone: "Please enter a valid phone number.", country: "Please choose a country or region." }[key];
      return fail(msg || `${key} is required.`, key);
    }
  }
  out.email = out.email.toLowerCase();
  if (!validEmail(out.email)) return fail("Please enter a valid email address.", "email");
  if (!validPhone(out.phone)) return fail("Please enter a valid phone number.", "phone");
  if (!COUNTRIES.includes(out.country)) return fail("Please choose a country or region.", "country");
  if (out.currency && !["USD", "BDT"].includes(out.currency.toUpperCase())) return fail("currency must be USD or BDT.", "currency");
  out.currency = (out.currency || "USD").toUpperCase();
  if (out.type && !["order", "preorder_request"].includes(out.type)) return fail("type must be order or preorder_request.", "type");
  if (out.paymentMethod && !["none", "cod", "bkash", "nagad"].includes(out.paymentMethod.toLowerCase())) return fail("Unknown payment method.", "paymentMethod");
  out.paymentMethod = (out.paymentMethod || "").toLowerCase();
  if (out.idempotencyKey && !IDEMPOTENCY_RE.test(out.idempotencyKey)) return fail("Invalid idempotency key.", "idempotencyKey");

  if (!Array.isArray(data.items) || data.items.length === 0) return fail("Your cart is empty.", "items");
  if (data.items.length > MAX_ITEMS) return fail("Too many items in one order.", "items");
  out.items = [];
  for (const raw of data.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Invalid cart item.", "items");
    for (const k of Object.keys(raw)) {
      if (PRICE_FIELDS.has(k)) return fail("Prices are set by the server. Remove price fields from the request.", `items.${k}`);
      if (!ITEM_FIELDS[k]) return fail(`Unknown item field: ${k.slice(0, 40)}`, `items.${k}`);
    }
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) return fail("Unknown product in cart.", "items.id");
    if (raw.variant !== undefined && raw.variant !== null && typeof raw.variant !== "string") return fail("Invalid product option.", "items.variant");
    if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_QTY) return fail("Invalid quantity.", "items.qty");
    out.items.push({ id: raw.id, variant: normalize(String(raw.variant || "")).slice(0, 80), qty: raw.qty });
  }
  return { ok: true, value: out };
}
