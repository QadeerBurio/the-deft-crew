const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { before, after, test } = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

process.env.JWT_SECRET = "local-review-test-only";
process.env.SHOPIFY_APP_API_KEY = "local-integration-test";
process.env.SHOPIFY_CONNECT_ORIGIN = "https://tdc-test.example";
require.cache[require.resolve("dotenv")] = { exports: { config: () => ({}) } };
require.cache[require.resolve("../../utils/mailer")] = {
  exports: { sendMail: async () => { throw new Error("No email in tests"); }, logMailerStatus() {} },
};
const User = require("../../models/User");
const PromoCode = require("../../models/PromoCode");
const Ticket = require("../../models/ShopifyLinkTicket");
const { digest } = require("../../routes/shopifyLink");

const prefix = "/api/shopify-app";
const serviceHeaders = { "X-API-KEY": process.env.SHOPIFY_APP_API_KEY };
const password = "Tdc-local-test-149610";
const linkedShop = "review-149610.myshopify.com";
let server, origin, owner, other, student, pending;

before(async () => {
  const port = process.env.TDC_TEST_MONGO_PORT;
  assert.match(port || "", /^\d+$/, "Set TDC_TEST_MONGO_PORT to a disposable localhost replica set");
  await mongoose.connect("mongodb://127.0.0.1:" + port + "/review149610_" + randomUUID().replace(/-/g, ""), {
    serverSelectionTimeoutMS: 8000,
  });
  await Promise.all([User.init(), PromoCode.init(), Ticket.init()]);
  const hashed = await bcrypt.hash(password, 4);
  const seed = (name, role, brandApprovalStatus = "approved") =>
    User.create({ name, email: name.toLowerCase() + "@test.example", password: hashed, role, brandApprovalStatus, emailVerified: true });
  [owner, other, student, pending] = await Promise.all([
    seed("Owner", "brand"), seed("Other", "brand"), seed("Student", "student"), seed("Pending", "brand", "pending"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth.routes"));
  app.use(prefix, require("../../routes/shopifyApp.routes"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

function request(path, headers = {}, body) {
  return fetch(origin + path, {
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function status(response, expected) {
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text;
}

async function start(shop) {
  const response = await request(prefix + "/link-shop/start", serviceHeaders, { shop });
  const url = new URL(JSON.parse(await status(response, 200)).authorizationUrl);
  assert.equal(url.origin, process.env.SHOPIFY_CONNECT_ORIGIN);
  const page = await request(url.pathname);
  assert.match(page.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(await status(page, 200), /Confirm store connection/);
  return { path: url.pathname, cookie: page.headers.get("set-cookie").split(";")[0] };
}

async function signIn(user, connection) {
  const response = await request("/api/auth/login", {}, { email: user.email, password });
  const { token } = JSON.parse(await status(response, 200));
  return { Origin: process.env.SHOPIFY_CONNECT_ORIGIN, Cookie: connection.cookie, Authorization: "Bearer " + token };
}

test("authenticated brand confirms Shopify handoff and the app reads the saved connection", async () => {
  await status(await request(prefix + "/brand?shop=" + linkedShop, serviceHeaders), 404);
  await status(await request(prefix + "/link-shop/start", {}, { shop: linkedShop }), 401);
  const connection = await start(linkedShop);
  const headers = await signIn(owner, connection);
  const selected = JSON.parse(await status(await request(connection.path + "/session", headers, {}), 200));
  assert.equal(selected.shop, linkedShop);
  assert.equal(selected.brandId, String(owner._id));
  await status(await request(connection.path + "/confirm", headers, { brandId: selected.brandId }), 200);
  const reopened = JSON.parse(await status(await request(prefix + "/brand?shop=" + linkedShop, serviceHeaders), 200));
  assert.equal(reopened.id, selected.brandId);
  assert.equal(reopened.shopifyStoreUrl, linkedShop);
  assert.deepEqual(reopened.discounts, []);
  await status(await request(connection.path + "/confirm", headers, { brandId: selected.brandId }), 410);
  await status(await request(prefix + "/link-shop/start", serviceHeaders, { shop: linkedShop }), 409);
});

test("unauthorized, cross-browser, expired and reassignment requests fail", async () => {
  const connection = await start("unlinked-review.myshopify.com");
  const studentHeaders = await signIn(student, connection);
  await status(await request(connection.path + "/session", studentHeaders, {}), 403);
  await status(await request(connection.path + "/session", await signIn(pending, connection), {}), 403);
  const headers = await signIn(owner, connection);
  await status(await request(connection.path + "/session", { ...headers, Origin: "https://foreign.example" }, {}), 403);
  await status(await request(connection.path + "/session", headers, {}), 200);
  await status(await request(connection.path + "/confirm", headers, { brandId: String(other._id) }), 403);
  await status(await request(connection.path + "/confirm", { ...headers, Cookie: "tdcShopifyLink=" + "a".repeat(64) }, { brandId: String(owner._id) }), 403);
  await status(await request(connection.path + "/confirm", headers, { brandId: String(owner._id) }), 409);
  await Ticket.updateOne({ _id: digest(connection.path.split("/").at(-1)) }, { $set: { expiresAt: new Date(0) } });
  await status(await request(connection.path + "/confirm", headers, { brandId: String(owner._id) }), 410);
  await status(await request(prefix + "/link-shop", serviceHeaders, { shop: "other.myshopify.com", brandId: String(owner._id) }), 410);
  assert.equal((await User.findById(owner._id)).shopifyStoreUrl, linkedShop);
});

test("two authorized brands racing to claim a shop yield exactly one saved connection", async () => {
  const shop = "race-review.myshopify.com";
  const competitor = await User.create({
    name: "Competitor", email: "competitor@test.example", password: await bcrypt.hash(password, 4),
    role: "brand", brandApprovalStatus: "approved",
  });
  const responses = await Promise.all([other, competitor].map(async (user) => {
    const connection = await start(shop);
    const headers = await signIn(user, connection);
    await status(await request(connection.path + "/session", headers, {}), 200);
    return { user, connection, headers };
  }));
  const attempts = await Promise.all(responses.map(({ user, connection, headers }) =>
    request(connection.path + "/confirm", headers, { brandId: String(user._id) })));
  assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409]);
  await Promise.all(attempts.map((response) => response.text()));
  assert.equal(await User.countDocuments({ shopifyStoreUrl: shop }), 1);
});

test("concurrent discount saves return the same result and preserve redemption state", async () => {
  const payload = {
    shop: linkedShop, brandId: String(owner._id), code: "REVIEW149610", discountType: "percentage",
    discountValue: 10, shopifyDiscountId: "gid://shopify/DiscountCodeNode/149610", startsAt: new Date().toISOString(),
  };
  const headers = { ...serviceHeaders, "Idempotency-Key": digest(JSON.stringify([linkedShop, payload.shopifyDiscountId])) };
  const send = (body = payload, options = headers) => request(prefix + "/discount", options, body);
  const results = await Promise.all(Array.from({ length: 12 }, async () => JSON.parse(await status(await send(), 200))));
  const id = results[0].discountId;
  assert.ok(id);
  assert.ok(results.every((result) => result.discountId === id));
  assert.equal(await PromoCode.countDocuments({ externalDiscountId: payload.shopifyDiscountId }), 1);
  await PromoCode.updateOne({ _id: id }, { $set: { status: "used" } });
  await status(await send(), 200);
  assert.equal((await PromoCode.findById(id)).status, "used");
  await status(await send({ ...payload, discountValue: 20 }), 409);
  await status(await send({ ...payload, brandId: String(other._id) }), 409);
  await status(await send(payload, serviceHeaders), 400);
});
