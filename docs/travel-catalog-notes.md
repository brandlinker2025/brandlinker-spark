# Travel catalog notes (21 November 2026)

The Travel Collection uses the 11 items requested from `/workspace/travel-dropship-nov21` (packing cubes, hanging toiletry bag, neck pillow, plug adapter, luggage scale, foldable duffel, cable organizer, jewelry case, shoe bags, holder case for AirTag, and silicone travel bottles). Power banks were skipped because of lithium shipping risk. The unverified weekender placeholder (p4) was removed so it would not sit beside this list with an invented price.

## Prices and shipping

Freight and delivery were not verified in the research. Public prices are shown only as “Price coming soon.” Supplier cost and source fields are kept in `data/products.json` for internal use and are not rendered on the public site. Product pages for these items omit `offers` in the Product schema so a false price is not marked up. Shipping copy is: “Delivery time confirmed at checkout.”

## Ordering

Travel items cannot be added to the paid cart. The consistent action is **Pre-order request**, which saves through `POST /api/orders` with `type=preorder_request` and `payment_method=none`. The customer is told: “Submit a pre-order request — we'll email you available payment options to confirm your order.”

## Images

AliExpress Terms of Use (updated 26 August 2026, effective 26 September 2026), clause 3.2(a), say users will not copy, reproduce, download, republish or commercially exploit site content, including images, without permission. The AliExpress Business Program agreement also requires written agreement from AliExpress or the seller before copying seller graphics.

CJ’s public materials did not give a clear, written licence in the pages we could check. CJ Academy terms treat product-image rights as belonging to manufacturers or distributors unless reuse is indicated or permission is given. The research pass also did not capture CJ product images for these items (product search was blocked).

Because of that, the preview uses original category illustrations in `assets/travel/`, not supplier photos. Each image is labelled as an illustration, not a product photo.

## Naming

The AirTag item is titled “Holder case for AirTag.” Copy states that it is a case only, an AirTag is not included, and Apple is not affiliated with the listing. No Apple logo is used. Competitor brand names from the research (BAGAIL, BAGSMART, and others) are not used on the storefront.
