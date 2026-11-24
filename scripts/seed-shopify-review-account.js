// scripts/seed-shopify-review-account.js
// Creates or resets the TDC brand account that Shopify's app reviewers use to connect a test store.
//
//   REVIEW_ACCOUNT_PASSWORD='<strong password>' node scripts/seed-shopify-review-account.js
//
// Needs MONGO_URI (read from .env like the server). Safe to run any number of times. Each run leaves:
//   - user shopify-review@gettdc.pk with the given password, email verified, active, not blocked.
//     Brand accounts have no 2FA; the admin-only sign-in code never applies to role "brand".
//   - that user is the brand "tdc Review Brand": in this backend a brand IS its owner's user record
//     (role "brand"), and an approved, active brand user is what may manage its store connection
//     (routes/shopifyLink.js authorizedBrand).
//   - no Shopify store linked, so the next reviewer can connect their own test store.
//     Re-run it between reviews: a brand can only be linked to one store at a time.
// It never prints the password or hash.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");
const Ticket = require("../models/ShopifyLinkTicket");

const EMAIL = "shopify-review@gettdc.pk";
const BRAND_NAME = "tdc Review Brand";

async function main() {
  const password = process.env.REVIEW_ACCOUNT_PASSWORD || "";
  if (password.length < 12) {
    throw new Error("Set REVIEW_ACCOUNT_PASSWORD to the reviewer password (at least 12 characters).");
  }
  if (!process.env.MONGO_URI) throw new Error("Set MONGO_URI.");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  let user = await User.findOne({ email: EMAIL }).select("+password");
  const created = !user;
  if (user && user.role !== "brand") {
    // never turn a student, admin or other account into a brand by accident
    throw new Error(`${EMAIL} exists with role "${user.role}". Fix or remove it by hand, then run again.`);
  }
  if (!user) user = new User({ email: EMAIL, role: "brand" });

  // keep the existing hash when the password didn't change, so re-runs don't rewrite it
  const samePassword = !created && user.password && (await bcrypt.compare(password, user.password));
  if (!samePassword) user.password = await bcrypt.hash(password, 10);

  const previousShop = user.shopifyStoreUrl || "";
  user.set({
    name: BRAND_NAME,
    brandName: BRAND_NAME,
    role: "brand",
    emailVerified: true,
    brandApprovalStatus: "approved",
    brandApprovedAt: user.brandApprovedAt || new Date(),
    brandApprovalNote: "",
    accountStatus: "active",
    suspensionReason: "",
    suspensionExpiry: undefined,
    isBlocked: false,
    adminAccess: undefined,
    // unlink any store from an earlier review
    shopifyStoreUrl: "",
    shopifyAccessToken: "",
  });
  await user.save();

  // half-finished connections bound to this brand from an earlier review can no longer be completed
  const { deletedCount } = await Ticket.deleteMany({ brandId: user._id, redeemedAt: { $exists: false } });

  console.log(`${created ? "Created" : "Updated"} ${EMAIL} (brand "${BRAND_NAME}", id ${user._id})`);
  console.log(`  password: ${samePassword ? "unchanged" : "set from REVIEW_ACCOUNT_PASSWORD"}`);
  console.log(`  email verified, approved, active, no 2FA`);
  console.log(`  Shopify store: ${previousShop ? `unlinked (was ${previousShop})` : "none linked"}`);
  if (deletedCount) console.log(`  removed ${deletedCount} unfinished connection link(s)`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error("Seed failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
