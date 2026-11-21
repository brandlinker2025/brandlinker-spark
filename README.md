# BrandLinker Spark (`brandlinkerspark.com`)

Curated storefront with a product catalogue, shopping cart, and checkout that saves real orders.

- Catalogue data lives in `data/products.json`. The Travel Collection (`#travel`) renders items whose `category` is `Travel`.
- Checkout offers Cash on Delivery, bKash and Nagad for Bangladesh. For other countries, checkout submits a pre-order request with no payment step. No card or wallet payments are taken on the site.
- Orders are saved by a serverless function and a notification is emailed for each order.

This preview branch does not change production.
