import { memoryStore, setStoreForTests } from "../lib/store.js";
import { resetRateLimitsForTests } from "../lib/ratelimit.js";
import { setMailerForTests, setMirrorForTests } from "../api/orders.js";

export const ADMIN_SECRET = "test-admin-secret-0123456789";

export function setup() {
  const store = memoryStore();
  setStoreForTests(store);
  resetRateLimitsForTests();
  process.env.ORDER_ADMIN_SECRET = ADMIN_SECRET;
  process.env.IP_HASH_SALT = "test-salt";
  const mails = [];
  setMailerForTests(async (order) => {
    mails.push(order.id);
    return { sent: true, provider: "test" };
  });
  setMirrorForTests(async () => ({ mirrored: false, status: "Not configured" }));
  return { store, mails };
}

let ipCounter = 0;
export function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

export function mkReq({ method = "POST", body, headers = {}, ip = "198.51.100.7" } = {}) {
  return {
    method,
    url: "/api/x",
    headers: { host: "brandlinkerspark.com", "x-real-ip": ip, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  };
}

export function mkRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(s) {
      this.raw = s;
      try {
        this.body = JSON.parse(s);
      } catch {
        this.body = s;
      }
    },
  };
  return res;
}

export async function call(handler, reqOpts) {
  const res = mkRes();
  await handler(mkReq(reqOpts), res);
  return res;
}

export function validOrder(overrides = {}) {
  return {
    type: "order",
    name: "Jane Customer",
    email: "jane.customer@example.com",
    phone: "+1 415 555 0100",
    address: "1 Market St, San Francisco CA",
    country: "United States",
    paymentMethod: "none",
    note: "",
    website: "",
    promoCode: "",
    currency: "USD",
    items: [{ id: "t01", variant: "Beige", qty: 2 }],
    ...overrides,
  };
}
