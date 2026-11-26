import { getStore } from "./store.js";

export const ORDER_ID_RE = /^BLS-\d{8}-[A-Z2-7]{10}$/;
// Older orders used 6 hex chars; still accepted for lookups/admin.
export const LEGACY_ORDER_ID_RE = /^BLS-\d{8}-[A-F0-9]{6}$/;

export function validOrderId(id) {
  return typeof id === "string" && (ORDER_ID_RE.test(id) || LEGACY_ORDER_ID_RE.test(id));
}

export function orderPath(id) {
  if (!validOrderId(id)) throw Object.assign(new Error("Invalid order id."), { status: 400 });
  return `orders/${id}.json`;
}

export async function getOrder(id) {
  return getStore().getJSON(orderPath(id));
}

export async function saveOrder(order, { overwrite = false } = {}) {
  await getStore().putJSON(orderPath(order.id), order, { overwrite });
}

export async function listOrders(max = 500) {
  const store = getStore();
  const entries = (await store.listPrefix("orders/", max))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
    .slice(0, max);
  const out = [];
  for (const e of entries) {
    const o = await store.getJSON(e.pathname).catch(() => null);
    if (o) out.push(adminView(o));
  }
  return out;
}

export function adminView(order) {
  const { lookupTokenHash, ...rest } = order;
  return { status: "pending", ...rest };
}

/** What a customer sees after proving ownership. No address, phone or internal fields. */
export function customerView(order) {
  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt,
    type: order.type,
    status: order.status || "pending",
    paymentStatus: order.paymentStatus,
    paymentMethodLabel: order.paymentMethodLabel,
    country: order.customer && order.customer.country,
    items: (order.items || []).map((i) => ({ name: i.name, variant: i.variant, qty: i.qty, lineTotal: i.lineTotal })),
    currency: order.currency,
    total: order.total,
    shippingNote: order.shippingNote || "",
    tracking: order.tracking || null,
  };
}
