# CJdropshipping and AliExpress plan (not built yet)

This is a plan only. No API keys were requested or stored in this preview.

## Product data

Edit `data/products.json` to add or replace catalogue items. Each product already has fields for `category`, `price`, `cost`, `images`, `source` (CJ or AliExpress), `sourceUrl`, `altSource`, `altCost`, `sellerRating`, `sellerOrders`, and `shipping` per region (`BD` and `other`). A later travel-product list can drop in by editing this file. The site renders the Travel Collection from items whose `category` is `Travel`.

The six current items are placeholders from the live storefront, not a sourced catalogue. Source fields are left empty until a final list is chosen and public listings are compared.

## CJdropshipping

Official docs: https://developers.cjdropshipping.com/

### Credential RS needs

From official CJ docs ("How to Get API Key"):

1. Sign in at cjdropshipping.com.
2. If needed, install the **API** app: left navigation **Apps** → **Install App** → **Others** → **API**.
3. Open the API page: https://www.cjdropshipping.com/my.html#/authorize/API
4. Click **Add API**, enter a name, set **Type** to **API Key**, then confirm.
5. In the list, copy the **API Key** from the **API Key & MCP Token** column (the copy icon). That API Key is the credential we need — not an email/password.

The server then exchanges the API Key for an access token:

- `POST https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken`
- Body: `{ "apiKey": "<the API Key>" }`
- Later calls use the header `CJ-Access-Token: <accessToken>`
- Access and refresh tokens last 180 days; refresh with `refreshAccessToken`. Cache tokens on the server only. Never put the API Key in the browser or in chat.

### Product import

After the access token works, a server job can pull products from CJ's product APIs, map them into `data/products.json` (or a database), and keep `source`, `sourceUrl`, `cost`, images, and shipping fields filled. This preview does not call CJ.

### Order forwarding

When a Spark order is saved, a later server step can create the matching CJ order through CJ's order APIs, using the saved customer address and item identifiers. Payment on Spark stays manual (COD / bKash / Nagad), so forwarding should wait until the order is confirmed.

## AliExpress

Official starting points: https://open.aliexpress.com/ and the dropshipping centre at https://ds.aliexpress.com

### Two ways to fulfil an AliExpress item

1. **Manual ordering (simplest, no extra paid setup).** After a Spark order is confirmed, place the matching AliExpress order by hand in RS's AliExpress account, using the saved address. No API credential is required for this path.
2. **AliExpress Dropshipping API (automation later).** This is the official path for creating and tracking dropship orders in software. It is separate from the Affiliate API, which is for links and commissions, not fulfilment.

### Credential the Dropshipping API would need

From official AliExpress Open Platform docs:

1. An AliExpress buyer account, then join the dropshipping centre: https://ds.aliexpress.com
2. Register as a developer and create a **Drop Shipping** application at https://console.aliexpress.com
3. From that app, copy the **AppKey** and **AppSecret**.
4. Complete OAuth so the app receives an **access token (session key)** for RS's account. Self-developer tokens last about a year; they must be refreshed before expiry.
5. API calls also sign requests with the AppSecret. All of these stay on the server, never in the storefront.

The Affiliate API's AppKey is not enough to place orders.

## Choosing a source later

When the final travel product list arrives, compare public CJ and AliExpress listings (cost, delivery time, rating, orders, reviews) and fill `source`, `sourceUrl`, `altCost`, and seller fields. Pick one source per product. No spending and no dashboard sign-in were done for this preview.
