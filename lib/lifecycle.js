// Order status lifecycle. Transitions are enforced server-side on every admin update.
export const ORDER_STATUSES = [
  "pending", "confirmed", "processing", "shipped", "delivered",
  "cancelled", "refund_requested", "refunded",
];
export const TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "refund_requested"],
  delivered: ["refund_requested"],
  refund_requested: ["refunded", "delivered"],
  cancelled: [],
  refunded: [],
};
export const PAYMENT_STATUSES = ["pending", "paid", "refunded"];

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

export function validateTracking(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) throw bad("tracking must be an object.");
  const carrier = typeof t.carrier === "string" ? t.carrier.trim() : "";
  const number = typeof t.number === "string" ? t.number.trim() : "";
  const url = typeof t.url === "string" ? t.url.trim() : "";
  if (!carrier || carrier.length > 40) throw bad("tracking.carrier is required (max 40 characters).");
  if (!/^[A-Za-z0-9-]{4,60}$/.test(number)) throw bad("tracking.number must be 4-60 letters, digits or dashes.");
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw bad("tracking.url must be a valid URL.");
    }
    if (u.protocol !== "https:" || url.length > 300) throw bad("tracking.url must be an https URL.");
  }
  return { carrier, number, url: url || null };
}

/**
 * Apply an admin update to an order. Returns a new order object.
 * update = { status?, paymentStatus?, tracking?, note? }
 */
export function applyUpdate(order, update, { actor = "admin", now = new Date().toISOString() } = {}) {
  if (!update || typeof update !== "object") throw bad("Invalid update.");
  const allowed = new Set(["status", "paymentStatus", "tracking", "note"]);
  for (const k of Object.keys(update)) if (!allowed.has(k)) throw bad(`Unknown field: ${k.slice(0, 40)}`);
  const next = { ...order, history: Array.isArray(order.history) ? [...order.history] : [] };
  const from = order.status || "pending";
  const entry = { at: now, actor };

  if (update.tracking !== undefined) {
    next.tracking = validateTracking(update.tracking);
    entry.tracking = true;
  }
  if (update.status !== undefined) {
    const to = String(update.status);
    if (!ORDER_STATUSES.includes(to)) throw bad("Unknown status.");
    if (!canTransition(from, to)) throw Object.assign(new Error(`Cannot move an order from ${from} to ${to}.`), { status: 409 });
    if (to === "shipped" && !next.tracking) throw bad("Add tracking (carrier and number) before marking an order shipped.");
    if (to === "refunded" && (order.paymentStatus || "pending") !== "paid") {
      throw Object.assign(new Error("Only a paid order can be marked refunded. Cancel unpaid orders instead."), { status: 409 });
    }
    next.status = to;
    if (to === "refunded") next.paymentStatus = "refunded";
    entry.from = from;
    entry.to = to;
  }
  if (update.paymentStatus !== undefined) {
    const p = String(update.paymentStatus);
    if (!PAYMENT_STATUSES.includes(p)) throw bad("Unknown payment status.");
    if (p === "refunded" && next.status !== "refunded") throw bad("Use status refunded to record a refund.");
    if (p === "paid" && ["cancelled", "refunded"].includes(next.status)) throw Object.assign(new Error("Cannot mark a closed order paid."), { status: 409 });
    next.paymentStatus = p;
    entry.paymentStatus = p;
  }
  if (update.note !== undefined) {
    if (typeof update.note !== "string" || update.note.length > 500) throw bad("note must be text up to 500 characters.");
    entry.note = update.note.trim();
  }
  next.history.push(entry);
  next.updatedAt = now;
  return next;
}
