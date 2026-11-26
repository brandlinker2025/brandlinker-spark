// Admin commerce tools (session required).
// GET  /api/admin/catalog                                   -> supplier registry + product drafts
// POST /api/admin/catalog { action:"landed-cost", productCost, shipping, duties, fees, salePrice } (minor units)
// POST /api/admin/catalog { action:"create-draft", draft:{...} }
// POST /api/admin/catalog { action:"transition", draftId, to, confirm }
import { json, readJson, safeLog } from "../../lib/http.js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { getStore } from "../../lib/store.js";
import { registry } from "../../lib/suppliers.js";
import { landedCost, margin } from "../../lib/money.js";
import { newDraft, transitionDraft } from "../../lib/catalog.js";

const DRAFT_ID_RE = /^draft-[a-f0-9]{16}$/;

export default async function handler(req, res) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  try {
    const store = getStore();
    if (req.method === "GET") {
      const entries = await store.listPrefix("catalog/drafts/", 500);
      const drafts = [];
      for (const e of entries) {
        const d = await store.getJSON(e.pathname).catch(() => null);
        if (d) drafts.push(d);
      }
      return json(res, 200, { ok: true, suppliers: registry(), drafts });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { ok: false, error: "Method not allowed." });
    }
    let data;
    try {
      data = await readJson(req, 4000);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request." });
    }
    try {
      if (data.action === "landed-cost") {
        const landed = landedCost({ productCost: data.productCost, shipping: data.shipping ?? 0, duties: data.duties ?? 0, fees: data.fees ?? 0 });
        const m = data.salePrice === undefined ? null : margin({ salePrice: data.salePrice, landed });
        return json(res, 200, { ok: true, landedMinor: landed, margin: m });
      }
      if (data.action === "create-draft") {
        const d = newDraft(data.draft);
        await store.putJSON(`catalog/drafts/${d.id}.json`, d);
        return json(res, 201, { ok: true, draft: d });
      }
      if (data.action === "transition") {
        if (typeof data.draftId !== "string" || !DRAFT_ID_RE.test(data.draftId)) return json(res, 400, { ok: false, error: "Invalid draft id." });
        const path = `catalog/drafts/${data.draftId}.json`;
        const d = await store.getJSON(path);
        if (!d) return json(res, 404, { ok: false, error: "Draft not found." });
        const next = transitionDraft(d, { to: data.to, confirm: data.confirm, ownerSession: auth.session });
        await store.putJSON(path, next, { overwrite: true });
        return json(res, 200, { ok: true, draft: next });
      }
      return json(res, 400, { ok: false, error: "Unknown action." });
    } catch (err) {
      return json(res, err.status || 400, { ok: false, error: err.message || "Invalid request." });
    }
  } catch (err) {
    safeLog("admin-catalog-failed", { code: err && err.name });
    return json(res, err.status || 500, { ok: false, error: err.status === 503 ? "Storage is not configured." : "Could not process the request." });
  }
}
