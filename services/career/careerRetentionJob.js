// services/career/careerRetentionJob.js
// Background job "careerRetention" (JOB_CAREER_RETENTION; on in production, off in staging, like the other
// jobs: config/featureFlags.js). Once a day, plus once 2 minutes after start: one retention pass
// (retentionService.run), up to 200 applications. A DRY RUN unless CAREER_RETENTION_MODE=apply: it then
// only logs how many rows it would anonymise.
const retention = require("./retentionService");

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;

let timer = null;
let first = null;
let running = false;

async function tick(now = new Date()) {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    return await retention.run({ now });
  } finally {
    running = false;
  }
}

function start({ intervalMs = INTERVAL_MS, firstRunMs = FIRST_RUN_MS } = {}) {
  if (timer) return timer;
  const go = () => tick().catch((err) => console.error(`[career-retention] run failed: ${err.message}`));
  first = setTimeout(go, firstRunMs);
  timer = setInterval(go, intervalMs);
  for (const t of [first, timer]) if (typeof t.unref === "function") t.unref();
  return timer;
}
function stop() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  timer = null;
  first = null;
}

module.exports = { start, stop, tick, INTERVAL_MS };
