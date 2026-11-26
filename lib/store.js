// Private key/value storage for orders, sessions, idempotency claims and rate-limit counters.
// Production backend: Vercel Blob with access "private" (blobs are only readable with the
// server-side BLOB_READ_WRITE_TOKEN; nothing is listable or fetchable from the browser).
// Tests inject the in-memory backend with setStoreForTests(); there is no env switch for it,
// so a misconfigured deployment can never silently fall back to memory.
import { put, get, list, del } from "@vercel/blob";

export class StoreNotConfigured extends Error {
  constructor() {
    super("Storage is not configured.");
    this.status = 503;
    this.code = "not_configured";
  }
}
export class AlreadyExists extends Error {
  constructor() {
    super("Already exists.");
    this.code = "exists";
  }
}

function blobStore(token) {
  return {
    kind: "vercel-blob-private",
    async getJSON(pathname) {
      const r = await get(pathname, { access: "private", useCache: false, token });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      const text = await new Response(r.stream).text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async putJSON(pathname, value, { overwrite = false } = {}) {
      try {
        await put(pathname, JSON.stringify(value), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: overwrite,
          contentType: "application/json",
          cacheControlMaxAge: 60,
          token,
        });
      } catch (err) {
        // Without allowOverwrite the Blob API refuses to replace an existing pathname.
        // Confirm by reading it back rather than parsing the error text.
        if (!overwrite) {
          const existing = await this.getJSON(pathname).catch(() => null);
          if (existing !== null) throw new AlreadyExists();
        }
        throw err;
      }
    },
    async listPrefix(prefix, max = 1000) {
      const out = [];
      let cursor;
      do {
        const page = await list({ prefix, token, limit: 1000, cursor });
        for (const b of page.blobs || []) out.push({ pathname: b.pathname, uploadedAt: String(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor && out.length < max);
      return out;
    },
    async remove(pathname) {
      await del(pathname, { token });
    },
  };
}

export function memoryStore() {
  const data = new Map();
  return {
    kind: "memory",
    data,
    async getJSON(p) {
      return data.has(p) ? JSON.parse(data.get(p).v) : null;
    },
    async putJSON(p, value, { overwrite = false } = {}) {
      if (!overwrite && data.has(p)) throw new AlreadyExists();
      data.set(p, { v: JSON.stringify(value), at: new Date().toISOString() });
    },
    async listPrefix(prefix) {
      return [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ pathname: k, uploadedAt: v.at }));
    },
    async remove(p) {
      data.delete(p);
    },
  };
}

let override = null;
export function setStoreForTests(store) {
  override = store;
}

export function getStore() {
  if (override) return override;
  const token = (process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new StoreNotConfigured();
  return blobStore(token);
}

export function storeConfigured() {
  return Boolean(override || (process.env.BLOB_READ_WRITE_TOKEN || "").trim());
}
