# Surprise Box (merchant surplus food) — pickup-first pilot

Behind `FLAG_SURPLUS_BOXES` (off by default). It must be on for the **brand** (its listings show only then)
and the **student**: `FLAG_SURPLUS_BOXES=ids:<brand id>,<student id>`. Admin pages work once the flag is set
for anyone. Flag off: every `/api/surplus` route answers 404 and nothing is written.

## Server setup
- `SURPLUS_CODE_SECRET`: a random value of at least 32 characters, used only to derive pickup codes. Without it
  (or shorter), Surprise Box holds and orders are refused with `503 SURPLUS_NOT_CONFIGURED` and the server logs
  `[surplus] SURPLUS_CODE_SECRET is not set ...` (at startup when the flag is set, then at most once a minute).
  It is never taken from `JWT_SECRET`. Changing it changes the codes students see for orders already placed (the
  brand's check uses the stored hash), so set it once, before the pilot, and don't rotate it during pickups.

## Rules
- Pickup only. **Pay at pickup** only: tdc never takes money, stores no card data, uses no payment provider.
  The brand marks "paid at pickup" at handover.
- Stock is held for **10 minutes** while the student confirms; an expired hold gives its stock back.
- At most **2 boxes** per order; **one active order per student per brand**.
- The student cancels until **30 minutes before pickup starts**; after that, not collecting is a **no-show**
  (recorded, never an automatic ban; admins see repeat no-shows). The brand can cancel any time, with a reason.
- Pickup code: 6 characters + QR, single use, only the listing's own brand at the listing's branch, expires at
  the end of the pickup window. Only its hash is stored (derived from the order with `SURPLUS_CODE_SECRET`).
- Disputes: one per order, within 24 hours of pickup (or of a no-show / brand cancellation). tdc decides;
  nothing is refunded (no money passed through tdc). Admins can block a brand's listings.
- Before confirming, a student sees: contents may vary, allergens and allergen notes, best-before, the pickup
  window and the cancellation rule. The order keeps what they accepted.

## Pieces
- Collections (new): `SurplusListing`, `SurplusInventoryHold`, `SurplusOrder`, `SurplusSupportCase`,
  `SurplusNotificationOutbox`, `SurplusBrandBlock`.
- `services/surplus/`: `policy`, `inventory` (atomic stock), `orders` (states, verify pickup), `pickupCode`,
  `notifications` (outbox), `cases` (disputes, blocking), `sweep` (the job).
- Routes: `routes/surplus.routes.js` at `/api/surplus` (see its header).
- Job `surplusSweep` (`JOB_SURPLUS_SWEEP`; on in production, off in staging): every minute expires holds,
  closes ended listings, marks no-shows, completes verified orders never marked paid (2 h after the window),
  queues 30-minute pickup reminders and delivers notifications.
- Tests: `tests/surplus/run.js`.
