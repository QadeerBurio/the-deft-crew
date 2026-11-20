# TDC backend verification for Shopify review 149610

## Local configuration

1. Start a disposable MongoDB replica set on localhost. A replica set is required for the transaction that consumes a ticket and saves the brand connection. Use separate local databases for TDC application data and Shopify sessions. Never reuse a production URI, test account, or API secret.
2. In the TDC backend at `E:\Development\Test\server`, set `MONGO_URI` to the local TDC database, set a test `JWT_SECRET`, and set `SHOPIFY_APP_API_KEY` to a new shared test secret. Set `SHOPIFY_CONNECT_ORIGIN` to the exact HTTPS origin of the development tunnel in front of the backend. This origin must route both `/api/auth/login` and `/api/shopify-app` to the same backend. Run `node server.js` with the backend's local-only configuration.
3. Verify the following indexes exist before enabling the new routes. Mongoose builds them on initialization with the default auto-index setting. If auto-index is disabled, build the indexes explicitly using the model definitions before serving requests.

   | Model | Required index |
   | --- | --- |
   | User | Unique partial `unique_brand_shopify_store` on non-empty brand `shopifyStoreUrl` |
   | PromoCode | Unique partial `unique_shopify_discount_save` on `shopifySaveKey`, plus the existing unique index on `code` |
   | ShopifyLinkTicket | TTL index on `expiresAt` plus the implicit unique `_id` index |

   For a database with existing links, first audit for duplicates after normalizing scheme, case, whitespace and trailing slash. Resolve conflicting assignments with the brand owners, then normalize valid links to lower-case `*.myshopify.com` before enabling the unique index. Preserve the original assignments and resolve ambiguous records explicitly. The legacy direct link endpoint returns HTTP 410. Existing discount codes keep their global uniqueness. A code already owned by another operation returns HTTP 409. Legacy promo rows created before idempotency keys require reconciliation if they collide with a new save.
4. Create local TDC test fixtures for an approved brand with a verified email and no Shopify link, a second approved brand, and a student or pending brand. The current account model represents each brand as a brand user. The handoff therefore offers the authenticated user's own approved brand for confirmation.
5. In the Shopify app at `E:\Development\shopify_tdc`, configure `BACKEND_API_URL` and `TDC_CONNECT_ORIGIN` to the backend HTTPS tunnel origin. Use the same `SHOPIFY_APP_API_KEY` as the TDC backend. Set `DATABASE_URL` and `MONGODB_DB_NAME` to the local Shopify session database. Use a separate Shopify development app and its own app credentials. In the local development copy of `shopify.web.toml`, use `dev = "npm exec remix vite:dev"` and keep the Prisma generate predev command. MongoDB does not support `prisma migrate deploy`.
6. Link the CLI configuration to the separate development app. From the local Shopify app, run `shopify app dev --config <development-config-name> --store <fresh-test-store>.myshopify.com` and use the installation preview printed by the CLI. Use the CLI's Shopify app tunnel for the embedded app and the separate backend HTTPS tunnel from step 2 for the TDC handoff.

## Fresh-store verification

1. Install the development app on the fresh store and approve access. On **The Deft Crew**, click **Connect your TDC account**. As a student or pending brand, sign in and verify that TDC rejects the connection. Then sign in with the approved brand. Confirm the page displays the correct store and brand. Click **Confirm store connection**.
2. Return to **Shopify Admin > Apps > tdc** and confirm **Partner Brand** is **Active**. Close and reopen the app and check that the same brand appears. Reload the used handoff page and confirm it asks you to start from Shopify Admin. Use the local suite for deterministic expiry, cross-browser and concurrent claim checks.
3. Select **Discounts**, enter a unique **Discount Code** and **Value (%)**, and click **Create Discount**. Confirm **Discount saved** and one entry under **Active Rules**. To exercise retry, make the local backend discount endpoint temporarily fail while keeping brand lookup available, create a different code, restore the backend, reload **Discounts**, and click **Retry TDC Save**. Verify one Shopify discount and one TDC promo row for the Shopify ID.
4. Apply that code at the test store checkout and confirm the reduced total. See the Shopify repo's recording checklist for the rest of the review workflow. The backend's existing order webhook only adds ROI entries when a promo belongs to an offer. A manual app rule has no offer, so verifying redemption in Shopify Admin is separate from validating TDC ROI with an offer-backed code.

## Automated test

In the TDC backend, point `TDC_TEST_MONGO_PORT` at a disposable localhost replica set and run `node --test tests/shopify-review-149610/run.cjs`. The test uses a randomly named database, the real login route and persistence models, test-only credentials, and a local HTTP server. The HTTP driver sends the browser cookie explicitly. Run the fresh-store test above to verify real browser cookies, the Shopify redirect, and the embedded UI.
