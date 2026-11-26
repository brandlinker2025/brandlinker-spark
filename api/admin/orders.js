// Admin order management (session required).
// GET  /api/admin/orders                         -> list orders
// POST /api/admin/orders { orderId, status?, paymentStatus?, tracking?, note? } -> lifecycle update
// Updates only change the Spark order record. They never place supplier orders or move money.
import { json, readJson, safeLog } from "../../lib/http.js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { getOrder, saveOrder, listOrders, validOrderId, adminView } from "../../lib/orders.js";
import { applyUpdate } from "../../lib/lifecycle.js";

export default async function handler(req, res) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  try {
    if (req.method === "GET") {
      const orders = await listOrders();
      return json(res, 200, { ok: true, count: orders.length, orders });
    }
    if (req.method === "POST") {
      let data;
      try {
        data = await readJson(req, 4000);
      } catch {
        return json(res, 400, { ok: false, error: "Invalid request." });
      }
      const { orderId, ...update } = data;
      if (!validOrderId(orderId)) return json(res, 400, { ok: false, error: "Invalid order id." });
      const order = await getOrder(orderId);
      if (!order) return json(res, 404, { ok: false, error: "Order not found." });
      let next;
      try {
        next = applyUpdate({ status: "pending", ...order }, update);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, error: err.message });
      }
      await saveOrder(next, { overwrite: true });
      return json(res, 200, { ok: true, order: adminView(next) });
    }
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    safeLog("admin-orders-failed", { code: err && err.name });
    return json(res, err.status || 500, { ok: false, error: "Could not process the request." });
  }
}
