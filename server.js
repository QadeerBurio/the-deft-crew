// First: everything written to the logs is redacted (e-mails, phones, tokens, connection strings) and
// lines inside a request carry its id (utils/logSafety.js)
const logSafety = require("./utils/logSafety");
logSafety.install();

const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Tokens are signed and checked with JWT_SECRET. There is no fallback: refuse to start without it.
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Add it to the environment (Railway variables) and restart.");
  process.exit(1);
}
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const dns = require("dns");
const path = require("path");
const axios = require("axios");

const connectDB = require("./config/db");

const app = express();
const server = http.createServer(app);

// every request gets an id: X-Request-Id response header, and [rid:<id>] on its log lines
app.use(logSafety.requestId());

const io = new Server(server, {
  cors: { origin: require("./config/corsOrigins").corsOptions.origin } // the website, the portal, the server itself (config/corsOrigins.js)
});

// Make io available to routes
app.set('io', io);

// Initialize Event Socket Broadcaster
const eventSocket = require("./socket/eventSocket");
eventSocket.init(io);

// ---------------- DNS CONFIG ----------------
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ---------------- MIDDLEWARE ----------------
app.use(cors(require("./config/corsOrigins").corsOptions)); // the website, the portal, the server itself; no Origin (the app, webhooks) allowed
app.use(express.json({
  limit: "5mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
// gzip, except the AI chat / travel streams (middleware/compress.js)
app.use(require("./middleware/compress")());
// [perf] time + size of the most used GET routes (middleware/perfLog.js)
app.use(require("./middleware/perfLog")());

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
// Mood emoji images used as the picture in push notifications
// Mood images for push + admin. Looks in public/dots first, then uploads/dots.
app.use("/assets/dots",
  express.static(path.join(__dirname, "public", "dots"), { maxAge: "7d" }),
  express.static(path.join(__dirname, "uploads", "dots"), { maxAge: "7d" })
);

// ---------------- DATABASE ----------------
// Background jobs: each one can be switched off with JOB_<NAME>=off, all with BACKGROUND_JOBS=off, and
// in staging all are off unless switched on by name (config/featureFlags.js)
const { jobEnabled, describeJobs, describeFlags } = require("./config/featureFlags");
// one line per feature flag: rule types and counts only, never the ids (config/featureFlags.js)
for (const line of describeFlags()) console.log(line);
// admin access to features per account (services/featureAccess.js): API requests wait for the first load (at most
// 5 s), then it's re-read every 30 s; prints "[flags] admin access: <flag> <count>, …" (counts only)
const featureAccess = require("./services/featureAccess");
featureAccess.expectLoad();

connectDB().then(() => {
  // after admin access has loaded: a Surprise Box pilot set up only from the admin portal still gets the
  // "pickup-code secret missing" warning
  featureAccess.start().then(() => require("./routes/surplus.routes").warnIfNoPickupSecret("after admin access loaded")).catch(() => {});
  console.log(describeJobs());

  // Automated event ingestion (hourly, plus a pass 10s after start)
  if (jobEnabled("eventIngestion")) {
    const eventScheduler = require("./services/events/scheduler");
    eventScheduler.initialize();
  }

  // social pushes (new posts / confessions / listings): sends the groups that are due, every minute
  if (jobEnabled("socialPush")) {
    require("./services/socialPush").startScheduler();
  }

  // push receipts every 30 minutes (JOB_PUSH_RECEIPTS): delivered / failed on PushLog rows (the engagement gateway's
  // and every tracked push), dead tokens removed; the first pass 2 minutes after start
  if (jobEnabled("pushReceipts")) {
    require("./services/engagement/pushGateway").startReceiptChecks();
  }

  if (jobEnabled("jobCleanup")) {
    // Imported jobs outside Pakistan leave the feed: archived (hidden, kept), never deleted, and never a
    // job an employer posted (only isExternal imports with no postedBy). Applications stay with the job.
    const Job = require("./models/Job");
    const { archiveForeignImportedJobs } = require("./services/jobArchive");
    archiveForeignImportedJobs().then((r) => {
      console.log(`🧹 [Startup] Archived ${r.archived} imported jobs outside Pakistan (${r.checked} imported jobs checked; employer jobs are never touched).`);
    }).catch(err => {
      console.error("❌ [Startup] Failed to purge non-Pakistan jobs:", err);
    });

    // Patch existing admin/manual jobs to ensure flags exist
    Job.updateMany({ isExternal: { $exists: false } }, { $set: { isExternal: false } }).exec();
    Job.updateMany({ active: { $exists: false } }, { $set: { active: true } }).exec();
    Job.updateMany(
      { applicationDeadline: { $exists: false } },
      { $set: { applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) } }
    ).exec();

    const jobIngestionService = require("./services/jobIngestionService");
    jobIngestionService.cleanupExpiredJobs().then(count => {
      if (count > 0) console.log(`⏰ [Startup] Cleaned up ${count} expired jobs.`);
    }).catch(err => {
      console.error("❌ [Startup] Failed to run expired jobs cleanup:", err);
    });

    // Schedule periodic cleanup every 6 hours
    setInterval(() => {
      jobIngestionService.cleanupExpiredJobs().catch(err => {
        console.error("❌ [Periodic] Expired jobs cleanup failed:", err);
      });
    }, 6 * 60 * 60 * 1000);
  }

  // hiring-timeline notifications: retries and interview reminders every 5 minutes (FLAG_CAREER_TIMELINE)
  if (jobEnabled("careerOutbox")) {
    require("./services/career/careerOutboxJob").start();
  }

  // Surprise Box: expired holds, closed listings, no-shows, pickup reminders, notifications, every minute (FLAG_SURPLUS_BOXES)
  if (jobEnabled("surplusSweep")) {
    require("./services/surplus/sweep").start();
  }

  // career data retention: daily; counts only (dry run) unless CAREER_RETENTION_MODE=apply
  if (jobEnabled("careerRetention")) {
    require("./services/career/careerRetentionJob").start();
  }

  // the chat database is connected either way (chat routes need it); its schedulers are switches
  const { connectDB: connectChatDB } = require("./chat-service/dist/config/db");
  connectChatDB().then(() => {
    // Engagement scheduler (drops, streaks, rollover)
    if (jobEnabled("engagementScheduler")) {
      const engagementScheduler = require('./services/engagement/schedular');
      engagementScheduler.start();
    }
    if (jobEnabled("chatSync")) {
      const { schedulerService } = require("./chat-service/dist/services/scheduler.service");
      schedulerService.initialize().catch((err) => {
        console.error("❌ Failed to initialize sync scheduler:", err);
      });
    }
  }).catch((err) => {
    console.error("❌ Failed to connect to chat database:", err);
  });
});

// ==================== SHOPIFY WEBHOOKS ====================

// Compliance webhook — MUST return 401 for invalid HMAC, 200 for valid [citation:3][citation:24]
app.post("/webhooks/compliance", async (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const rawBody = req.body; // Buffer

  const calculatedHmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(rawBody)
    .digest("base64");

  // Constant-time comparison [citation:2]
  const valid = crypto.timingSafeEqual(
    Buffer.from(calculatedHmac, "base64"),
    Buffer.from(hmacHeader || "", "base64")
  );

  if (!valid) {
    console.warn("❌ Compliance webhook HMAC failed");
    return res.status(401).send("Unauthorized");
  }

  const topic = req.get("X-Shopify-Topic");
  const shopDomain = req.get("X-Shopify-Shop-Domain");
  const payload = JSON.parse(rawBody.toString());

  console.log(`📥 Compliance webhook: ${topic} from ${shopDomain}`);

  switch (topic) {
    case "customers/data_request":
      console.log("Customer data request — no data held by TDC");
      break;
    case "customers/redact":
      console.log("Customer redact request — no data to delete");
      break;
    case "shop/redact":
      const ShopifyStore = require("./models/ShopifyStore");
      await ShopifyStore.deleteMany({ shop: shopDomain });
      console.log(`✅ Shop data redacted: ${shopDomain}`);
      break;
  }

  res.status(200).send("OK");
});

// App uninstalled webhook
app.post("/webhooks/app/uninstalled", async (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const calculatedHmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body)
    .digest("base64");

  if (calculatedHmac !== hmacHeader) {
    return res.status(401).send("Unauthorized");
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain");
  const ShopifyStore = require("./models/ShopifyStore");
  await ShopifyStore.findOneAndUpdate(
    { shop: shopDomain },
    { status: "uninstalled", uninstalledAt: new Date() }
  );

  console.log(`📥 App uninstalled: ${shopDomain}`);
  res.status(200).send("OK");
});

// Scopes update webhook
app.post("/webhooks/app/scopes_update", async (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const calculatedHmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body)
    .digest("base64");

  if (calculatedHmac !== hmacHeader) {
    return res.status(401).send("Unauthorized");
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain");
  const payload = JSON.parse(req.body.toString());
  const ShopifyStore = require("./models/ShopifyStore");
  await ShopifyStore.findOneAndUpdate({ shop: shopDomain }, { scopes: payload.current });

  console.log(`📥 Scopes updated: ${shopDomain}`);
  res.status(200).send("OK");
});
// ---------------- ROUTES ----------------
// IMPORTANT: Register webhook routes FIRST
app.use("/api", featureAccess.waitReady); // until admin feature access has loaded once (at most 5 s after start)
app.use("/api", require("./middleware/rejectGuestWrites")); // signed-out callers can't write (an allowlist of public routes: login, sign-up, webhooks ...)
app.use("/api/webhooks/woocommerce", require("./routes/storeWebhook.routes")); // connected WooCommerce stores
app.use("/api/webhooks", require("./routes/webhook.routes"));

// Now register all other routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/universities", require("./routes/university.routes"));
app.use("/api/offers", require("./routes/offer.routes"));
app.use("/api/brands", require("./routes/brands.routes"));
app.use("/api/brand/store", require("./routes/brandStore.routes")); // a brand's own online store (WooCommerce)
app.use("/api/notification", require("./routes/notification.routes"));
app.use("/api/profile", require("./routes/profile.routes"));
app.use("/api/admin/actions", require("./routes/adminActions.routes")); // the unified admin action log (read-only)
app.use("/api/admin/universities", require("./routes/adminUniversities.routes")); // the shared university list (admin only, logged)
app.use("/api/admin/features", require("./routes/adminFeatures.routes")); // features per account (admin only, logged)
app.use("/api/admin/safety", require("./routes/adminSafety.routes")); // confession safety log (plan P4-7, admins only)
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/admin/team", require("./routes/adminTeam.routes")); // Phase A: team & access (super admins)
app.use("/api/admin/me", require("./routes/adminMe.routes")); // Phase A: an admin's own access and sessions
app.use("/api/membership", require("./routes/membership.route"));
app.use("/api/bookings", require("./routes/booking.routes"));
app.use("/api/social", require("./routes/confessionSafety.routes")); // report / mute / rules (flag confessionSafety; 404 otherwise)
app.use("/api/social", require("./routes/social.routes"));
app.use("/api/safety", require("./routes/safetyActions.routes")); // one-time links in the safety e-mail (plan P4-1b)
app.use("/api/events", require("./routes/event.routes"));
app.use("/api/app", require("./routes/appFlags.routes")); // public app switches (Meta events kill switch)
app.use("/api/invites", require("./routes/invites.routes")); // the invite page reports opens (P1-2, public, rate-limited)
app.use("/api/jobs", require("./routes/jobs.routes"));
app.use("/api/traveler", require("./routes/traveler.routes"));
// P3b: the resume coach (flags resumeV2 + resumeCoach; speech: resumeSpeak), before the resume routes
app.use("/api/resume/ai", require("./routes/resumeCoach.routes"));
app.use("/api/resume", require("./routes/resume.routes"));
app.use('/api/career/resume', require('./routes/careerResume.routes')); // AI Resume Studio, before /api/career (FLAG_RESUME_STUDIO_V2)
app.use('/api/career/matching', require('./routes/careerMatching.routes')); // candidate matching, before /api/career (FLAG_CAREER_MATCHING)
app.use('/api/career/invites', require('./routes/careerInvites.routes')); // a student's invites to apply, before /api/career (FLAG_CAREER_MATCHING)
app.use("/api/brand-approval", require("./routes/brandApproval.routes"));
app.use("/api/promo-codes", require("./routes/promoCode.routes"));
app.use("/api/shopify-app", require("./routes/shopifyApp.routes"));
app.use("/api/branches", require("./routes/branch.routes"));
app.use("/api/v1", require("./chat-service/dist/routes/index").default);

// ============ SKILLSWAP ROUTES ============
app.use('/api/professional-profile', require('./routes/professionalProfile.routes'));
app.use('/api/listings', require('./routes/listing.routes'));
app.use('/api/skill-offers', require('./routes/skillOffer.routes'));
app.use('/api/chat', require('./routes/chat.routes'));
app.use('/api/inquiries', require('./routes/inquiry.routes'));
app.use('/api/chat/upload', require('./routes/chatUpload.routes'));
app.use('/api/engagement', require('./routes/engagement.routes'));
// 🆕 admin engagement
app.use('/api/admin/engagement', require('./routes/adminEngagement.routes'));
app.use('/api/rewards', require('./routes/rewards.routes'));
app.use('/api/loyalty', require('./routes/loyalty.routes')); // brand loyalty (FLAG_LOYALTY_V2)
app.use('/api/career/ratings', require('./routes/careerRatings.routes')); // mutual ratings, before /api/career (FLAG_CAREER_RATINGS)
app.use('/api/career', require('./routes/hiringAccess.routes')); // free trial and hiring plans (every employer); unmatched requests continue below
app.use('/api/career', require('./routes/careerTrial.routes')); // First Hire Free (FLAG_EMPLOYER_FIRST_HIRE_FREE); unmatched requests continue below
app.use('/api/career', require('./routes/career.routes')); // hiring timeline (FLAG_CAREER_TIMELINE)
app.use('/api/surplus', require('./routes/surplus.routes')); // Surprise Box (FLAG_SURPLUS_BOXES)
app.use('/api/analytics', require('./routes/analytics.routes')); // admin / brand / employer figures from authoritative records (read-only)

// 🆕 admin crew
app.use('/api/admin/crew', require('./routes/adminCrew.routes'));
app.use("/api/crew", require("./routes/crew.routes")); // P2: the ambassador programme for students (flag ambassadorV2)
// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
// moved unchanged to socket/chatHandlers.js (SEC-1)
require("./socket/chatHandlers").attach(io);

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});