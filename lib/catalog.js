// Product approval workflow: draft -> approved -> published.
// Every transition requires the owner's admin session AND an explicit confirmation of the draft id.
// "published" records the owner's decision only: the live storefront is the static
// data/products.json, which changes only through a reviewed git commit. Nothing here edits it.
import { randomBytes } from "node:crypto";
import { landedCost, margin, isMinor } from "./money.js";
import { SUPPLIERS } from "./suppliers.js";

export const DRAFT_TRANSITIONS = {
  draft: ["approved", "rejected"],
  approved: ["published", "draft"],
  published: ["draft"],
  rejected: ["draft"],
};

function bad(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

export function validateDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("draft must be an object.");
  const allowed = new Set(["name", "supplierId", "supplierRef", "currency", "salePriceMinor", "cost"]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) throw bad(`Unknown field: ${k.slice(0, 40)}`);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw bad("name is required (max 120 characters).");
  if (!SUPPLIERS[input.supplierId]) throw bad("supplierId must be one of: " + Object.keys(SUPPLIERS).join(", "));
  const supplierRef = typeof input.supplierRef === "string" ? input.supplierRef.trim().slice(0, 200) : "";
  const currency = input.currency === "BDT" ? "BDT" : input.currency === "USD" || input.currency === undefined ? "USD" : null;
  if (!currency) throw bad("currency must be USD or BDT.");
  if (!isMinor(input.salePriceMinor)) throw bad("salePriceMinor must be a non-negative integer.");
  const c = input.cost || {};
  const cost = { productCost: c.productCost, shipping: c.shipping ?? 0, duties: c.duties ?? 0, fees: c.fees ?? 0 };
  const landed = landedCost(cost);
  return { name, supplierId: input.supplierId, supplierRef, currency, salePriceMinor: input.salePriceMinor, cost, landedMinor: landed, ...pickMargin(margin({ salePrice: input.salePriceMinor, landed })) };
}

function pickMargin(m) {
  return { marginMinor: m.marginMinor, marginBps: m.marginBps, profitable: m.profitable };
}

export function newDraft(input, now = new Date().toISOString()) {
  const v = validateDraft(input);
  return {
    id: `draft-${randomBytes(8).toString("hex")}`,
    state: "draft",
    ...v,
    // Supplier data is never treated as verified by this workflow.
    stockVerified: false,
    shippingVerified: false,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, to: "draft" }],
  };
}

export function transitionDraft(draft, { to, confirm, ownerSession }, now = new Date().toISOString()) {
  if (!ownerSession) throw bad("Owner session required.", 401);
  if (confirm !== draft.id) throw bad("Confirm the change by sending confirm equal to the draft id.");
  if (!DRAFT_TRANSITIONS[draft.state] || !DRAFT_TRANSITIONS[draft.state].includes(to)) {
    throw bad(`Cannot move a draft from ${draft.state} to ${to}.`, 409);
  }
  if (to === "published" && !draft.profitable) throw bad("Cannot publish a product with zero or negative margin.", 409);
  return {
    ...draft,
    state: to,
    updatedAt: now,
    history: [...(draft.history || []), { at: now, from: draft.state, to, by: "owner" }],
  };
}
