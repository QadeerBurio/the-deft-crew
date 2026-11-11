// services/career/careerOutboxJob.js
// Background job "careerOutbox" (JOB_CAREER_OUTBOX; on in production, off in staging, like the other jobs:
// config/featureFlags.js). Every 5 minutes: runs the registered tasks (interview reminders queue their
// rows), then delivers what's due in CareerNotificationOutbox: new rows, failed ones whose backoff has
// passed, pushes held back by quiet hours. Delivery only ever touches outbox rows; the business event
// (CareerApplicationEvent) is never written again. Each row is claimed atomically, so two servers (or two
// ticks) never deliver the same row twice. Tasks: interview reminders 24 h / 1 h (careerReminderService), and
// "a new job that matches your skills" alerts (jobAlerts, their own CareerJobAlert rows).
const notifications = require("./careerNotificationService");

const INTERVAL_MS = 5 * 60 * 1000;
const tasks = []; // async (now) => summary, run before each drain
const addTask = (name, fn) => tasks.push({ name, fn });
addTask("reminders", require("./careerReminderService").queueDueReminders);
// "a new job that matches your skills" alerts waiting for quiet hours to end, or retried after an error (CareerJobAlert)
addTask("jobAlerts", async (now) => (await require("./jobAlerts").drain({ limit: 500, now })).filter((x) => x.status === "sent").length);

let timer = null;
let running = false;

async function tick(now = new Date()) {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    const out = {};
    for (const t of tasks) {
      try { out[t.name] = await t.fn(now); } catch (err) { console.error(`[career outbox] ${t.name} failed: ${err.message}`); }
    }
    const done = await notifications.drain({ limit: 200, now });
    out.delivered = done.filter((r) => r.status === "sent").length;
    out.failed = done.filter((r) => r.status === "failed").length;
    out.deferred = done.filter((r) => r.status === "pending").length;
    out.skipped = done.filter((r) => r.status === "skipped").length;
    return out;
  } finally {
    running = false;
  }
}

function start({ intervalMs = INTERVAL_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => { tick().catch((err) => console.error(`[career outbox] tick failed: ${err.message}`)); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, addTask, INTERVAL_MS };
