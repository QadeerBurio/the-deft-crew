// utils/karachiTime.js
// All day boundaries use Asia/Karachi (PKT, UTC+5).
// ISO week starts on Monday (per spec §4.2).
// Tests must cover: 23:59 / 00:01 boundary + Monday week start.

const TZ = 'Asia/Karachi';
const TZ_OFFSET_MIN = 5 * 60; // PKT = UTC+5

// ─── YYYY-MM-DD string for a given date (or now) in Karachi ───
function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  // Shift to PKT then read UTC parts
  const pkt = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  const y = pkt.getUTCFullYear();
  const m = String(pkt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(pkt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── add N days to a dayKey string, return new dayKey ───
function addDays(dayKeyStr, n) {
  const d = new Date(`${dayKeyStr}T12:00:00Z`); // noon UTC avoids DST edge cases
  d.setUTCDate(d.getUTCDate() + n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── yesterday(today) as a dayKey ───
function yesterday(dayKeyStr = dayKey()) {
  return addDays(dayKeyStr, -1);
}

// ─── ISO week key 'YYYY-Www' (week starts Monday) ───
function weekKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pkt = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  // Copy date so we don't mutate
  const tmp = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()));
  // ISO: Thursday of the current week determines the year
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ─── semester key: Jan–Jun = S1, Jul–Dec = S2 ───
function semesterKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pkt = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  const y = pkt.getUTCFullYear();
  const m = pkt.getUTCMonth() + 1; // 1..12
  return m <= 6 ? `${y}-S1` : `${y}-S2`;
}

// ─── quiet hours: 23:00–09:00 PKT ───
function isQuietHour(date = new Date(), cfg = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const pkt = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  const hour = pkt.getUTCHours();
  const start = cfg.quietStart ?? 23;
  const end = cfg.quietEnd ?? 9;
  // Wraps midnight: quiet if hour >= 23 OR hour < 9
  return hour >= start || hour < end;
}

// ─── current PKT hour (0..23) ───
function pktHour(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pkt = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  return pkt.getUTCHours();
}

module.exports = {
  TZ,
  dayKey,
  addDays,
  yesterday,
  weekKey,
  semesterKey,
  isQuietHour,
  pktHour,
};