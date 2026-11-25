// services/confessionHandles.js
// P4-2 anonymous handles (flags confessionsV2 + confessionHandles): "adjective-noun-123" from config/confessionHandles.js,
// one per student, stable, unique, never the name or e-mail. Owner (25 Nov 2026): its own flag `confessionHandles`
// (off; the owner approves the word list before switching it on); off = no handle is made or shown, posts stay "anon.".
// The admin can block a single word later (Safety settings, blockedHandleWords; no app update): no new handle uses it,
// a student whose handle has it gets a new one on their next post, and posts under the old one show "anon.".
// Every candidate goes through the confession word filter first (utils/profanity + the admin's banned words), as a
// whole and word by word, so a combination or a newly banned word is never handed out.
//   enabled(userId)           the student has confessionHandles
//   hasBlockedWord(h, words)  the handle contains a word the admin blocked
//   candidate(rand?)          one random handle (not checked against the database)
//   clean(handle, banned)     passes the word filter
//   ensureHandle(userId)      the student's handle (made and saved on first use), or null when not enabled
const crypto = require("crypto");
const lists = require("../config/confessionHandles");
const { findProfanity } = require("../utils/profanity");

const enabled = (userId) => !!userId && require("../config/featureFlags").isEnabled("confessionHandles", { id: String(userId), role: "student" });
const hasBlockedWord = (handle, words = []) => { const parts = String(handle || "").toLowerCase().split("-"); return (words || []).some((w) => w && parts.includes(String(w).toLowerCase())); };
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];
const cryptoRand = () => crypto.randomInt(0, 1e9) / 1e9;

function candidate(rand = cryptoRand) {
  let n = 100 + Math.floor(rand() * 900);
  for (let i = 0; i < 20 && lists.NUMBER_LEFT_OUT(n); i++) n = 100 + Math.floor(rand() * 900);
  if (lists.NUMBER_LEFT_OUT(n)) n = 123;
  return `${pick(lists.ADJECTIVES, rand)}-${pick(lists.NOUNS, rand)}-${n}`;
}

function clean(handle, bannedWords = []) {
  const h = String(handle || "").toLowerCase();
  if (!/^[a-z]+-[a-z]+-\d{3}$/.test(h) || lists.NUMBER_LEFT_OUT(Number(h.split("-")[2]))) return false;
  const parts = h.split("-");
  if (findProfanity(h.replace(/-/g, " ")) || parts.some((p) => findProfanity(p))) return false;
  const joined = parts.slice(0, 2).join("");
  return !(bannedWords || []).some((w) => w && (parts.includes(w) || joined.includes(w) || h.includes(w)));
}

async function ensureHandle(userId, { rand = cryptoRand } = {}) {
  if (!enabled(userId)) return null;
  const User = require("../models/User");
  const me = await User.findById(userId).select("+confessionHandle").lean();
  if (!me) return null;
  const settings = await require("./safetySettings").get();
  const blocked = settings.blockedHandleWords || [];
  if (me.confessionHandle && !hasBlockedWord(me.confessionHandle, blocked)) return me.confessionHandle;
  const old = me.confessionHandle || null; // a handle with a blocked word is replaced
  const banned = [...(settings.bannedWords || []), ...blocked];
  for (let i = 0; i < 25; i++) {
    const h = candidate(rand);
    if (!clean(h, banned)) continue;
    if (await User.exists({ confessionHandle: h })) continue;
    try {
      const r = await User.updateOne(old ? { _id: userId, confessionHandle: old } : { _id: userId, confessionHandle: { $exists: false } }, { $set: { confessionHandle: h } });
      if (r.modifiedCount || r.nModified) return h;
      const again = await User.findById(userId).select("+confessionHandle").lean(); // made at the same moment elsewhere
      if (again?.confessionHandle && !hasBlockedWord(again.confessionHandle, blocked)) return again.confessionHandle;
    } catch (e) {
      if (e?.code !== 11000) throw e; // taken a moment ago: try another
    }
  }
  return null; // practically never: the post goes out "anon."
}

module.exports = { enabled, hasBlockedWord, candidate, clean, ensureHandle };
