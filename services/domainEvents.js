// services/domainEvents.js
// recordOnce(type, key, fields): writes one DomainEvent (models/DomainEvent.js) unless one with this key
// already exists. Returns { created: true, event } for the first write and { created: false, event }
// for every repeat, including two writes at the same moment (the unique index picks one).
// Off (FLAG_DOMAIN_EVENTS=off) → { created: false, event: null, skipped: true }.
//
// recordSafe(...) is for request paths: same call, but it never throws (a failed record is logged, the
// request it describes has already succeeded).
const DomainEvent = require("../models/DomainEvent");
const { isEnabled } = require("../config/featureFlags");

async function recordOnce(type, key, { actor = null, subject = null, data = {}, at = new Date() } = {}) {
  if (!type || !key) throw new Error("recordOnce needs a type and a key");
  if (!isEnabled("domainEvents")) return { created: false, event: null, skipped: true };
  const fullKey = `${type}:${key}`;
  try {
    const event = await DomainEvent.create({ key: fullKey, type, actor, subject: subject || {}, data, at });
    return { created: true, event };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return { created: false, event: await DomainEvent.findOne({ key: fullKey }).lean() };
  }
}

async function recordSafe(type, key, fields) {
  try {
    return await recordOnce(type, key, fields);
  } catch (err) {
    console.error(`[domain-event] ${type} not recorded: ${err.message}`);
    return { created: false, event: null, error: err.message };
  }
}

module.exports = { recordOnce, recordSafe };
