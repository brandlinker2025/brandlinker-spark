# Travel catalog notes (21 November 2026)

The Spark travel catalogue includes the original eleven items, plus two added only because a verified CJ listing and an approved retail price were available: an RFID passport holder and a foldable travel tote. The tote was **not** matched to the existing foldable travel duffel — a tote and a duffel are different item types, so the duffel stays “Price coming soon.” Vacuum bags were researched but are not in the Spark catalogue and were not added. Power banks remain skipped because of lithium shipping risk.

## Prices and shipping (public)

Public retail prices and order buttons are set only for these items, in US dollars, with free shipping to the United States and the United Kingdom and delivery usually 5-12 business days:

- 8-piece packing cube set (t01) — $24.99, orderable
- RFID passport holder (t12) — $16.99, orderable
- U-shape travel pillow (t03) — $18.99, orderable
- Digital luggage scale (t05) — $26.99, orderable
- Foldable travel tote (t13) — $29.99, orderable
- Travel cable organizer (t07) — $27.99, orderable
- PU travel jewelry box (t08) — $19.99, orderable

UAE shipping coming soon; customers can send a pre-order request. Shipping to other countries, including Bangladesh, is not confirmed yet for these items. The order form and the order email include the item price and the destination country. Landed costs, supplier unit costs and margins are not stored in `data/products.json` and must not be shown on the storefront. To change a public price, edit `price` on the product in `data/products.json` after the price is approved. Supplier SKUs and CJ listing URLs are kept in a gitignored internal file, not deployed.

These remain “Price coming soon” / pre-order: hanging toiletry bag, travel plug adapter (not a voltage converter), foldable travel duffel, travel shoe bags, holder case for AirTag (case only), and silicone travel bottles (sold empty).

## Ordering

Priced travel items can be added to the cart. For the United States and the United Kingdom, checkout is a priced order; payment is not taken on the site and payment options are emailed. For the UAE and for other destinations, checkout is a pre-order request that still includes the published price and the destination country. Unpriced travel items use **Pre-order request** (`type=preorder_request`, `payment_method=none`).

## Images

CJ listing photos are used on the seven priced items above, except the foldable travel tote (no usable CJ photo was obtained). Remaining travel cards use labeled Pexels stock photos of the product type, or original Spark illustrations, never AliExpress images and never Amazon images copied from Amazon. See `docs/image-credits.md`.

## Naming

The AirTag item is titled “Holder case for AirTag.” Copy states that it is a case only, an AirTag is not included, and Apple is not affiliated with the listing. No Apple logo is used. Competitor brand names from the research are not used on Spark-sold items.
