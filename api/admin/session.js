// Admin session for orders-admin.
// POST   /api/admin/session  { secret }  -> sets HttpOnly session cookie
// GET    /api/admin/session              -> { authenticated, integrations } (401 without a session)
// DELETE /api/admin/session              -> logout (deletes the server-side session)
import { json, readJson } from "../../lib/http.js";
import { login, logout, currentSession, adminConfigured } from "../../lib/admin-auth.js";
import { storeConfigured } from "../../lib/store.js";
import { registry } from "../../lib/suppliers.js";
import { centralConfigured } from "../../lib/central.js";

function integrations() {
  const resend = Boolean((process.env.RESEND_API_KEY || "").trim() && (process.env.ORDER_FROM_EMAIL || "").trim());
  return {
    orderStorage: storeConfigured() ? "Configured but not verified" : "Not configured",
    email: resend ? "Configured but not verified" : "FormSubmit fallback (not verified)",
    centralDb: centralConfigured() ? "Configured but not verified" : "Not configured",
    suppliers: registry(),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      let data;
      try {
        data = await readJson(req, 2000);
      } catch {
        return json(res, 400, { ok: false, error: "Invalid request." });
      }
      const r = await login(req, data.secret);
      return json(res, r.status, r.body, r.cookie ? { "Set-Cookie": r.cookie } : {});
    }
    if (req.method === "DELETE") {
      const cookie = await logout(req);
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie });
    }
    if (req.method === "GET") {
      if (!adminConfigured()) return json(res, 401, { ok: false, authenticated: false, error: "Unauthorized." });
      const s = await currentSession(req);
      if (!s) return json(res, 401, { ok: false, authenticated: false, error: "Unauthorized." });
      return json(res, 200, { ok: true, authenticated: true, expiresAt: new Date(s.expiresAt).toISOString(), integrations: integrations() });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { ok: false, error: "Method not allowed." });
  } catch {
    return json(res, 500, { ok: false, error: "Something went wrong." });
  }
}
