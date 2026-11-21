// services/confessionCheck.js
// The pre-post check for confessions and confession comments (plan P4-1, flag confessionSafety). Four checks, run
// together:
//   a) utils/profanity.js (English + Roman Urdu) plus the admin's banned words
//   b) rules: phone numbers, e-mail addresses, CNIC-like numbers, links, and full names of students at the same
//      university
//   c) OpenAI omni-moderation-latest on the text and the image (3 s timeout)
//   d) a topic check with OPENAI_MODEL (strict JSON): religion, politics, ethnic / sectarian, sexual / vulgar, threat
//      (owner rule: none of these in tdc confessions)
// Result:
//   { verdict: "ok" | "edit" | "hold" | "selfharm", reasons: [{ code, message, span? }], severe, aiOk }
//   edit      the student must change it (the app shows the reasons); nothing is saved
//   hold      a check couldn't run (timeout, no key, error): saved as pending, never silently allowed
//   selfharm  a self-harm signal: saved as pending, the author sees support, admins get the safety e-mail
// Nothing here writes to the database.
const OpenAI = require("openai");
const { findProfanity } = require("../utils/profanity");
const settings = require("./safetySettings");

const TIMEOUT_MS = 3000;

const MESSAGES = {
  identifies_person: "this names or identifies a person. edit it to post.",
  personal_info: "this has a phone number, e-mail or id number. remove it to post.",
  link: "links aren't allowed in confessions.",
  profanity: "this has a word that isn't allowed here. edit it to post.",
  religion: "tdc confessions don't allow religious topics.",
  politics: "tdc confessions don't allow political topics.",
  ethnic_or_sectarian: "tdc confessions don't allow racist, sectarian or ethnic content.",
  sexual: "sexual or vulgar content isn't allowed.",
  threat: "threats aren't allowed.",
  hate: "hate or bullying isn't allowed.",
  graphic: "graphic or violent images and content aren't allowed.",
};
const reason = (code, span) => ({ code, message: MESSAGES[code], ...(span ? { span: String(span).slice(0, 120) } : {}) });

// ---------- b) rules ----------
const PHONE = /(?:\+?92[\s-]?|\b0)3\d{2}[\s-]?\d{7}\b|\b\d{4}[\s-]\d{7}\b/;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const CNIC = /\b\d{5}-?\d{7}-?\d\b/;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|pk|net|org|io|me|co|ly|gg|app|link|xyz)(?:\/\S*)?\b/i;

// full names of students at a university, cached per university for 10 minutes
const nameCache = new Map();
const NAME_TTL = 10 * 60 * 1000;
async function universityNames(universityId) {
  if (!universityId) return [];
  const key = String(universityId);
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.names;
  const User = require("../models/User");
  const rows = await User.find({ university: universityId, role: "student" }).select("name").lean();
  const names = [];
  for (const r of rows) {
    const tokens = String(r.name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens[0].length >= 3 && tokens[1].length >= 3) names.push(tokens.slice(0, 2));
  }
  nameCache.set(key, { at: Date.now(), names });
  return names;
}

async function rulesCheck(text, { universityId, bannedWords }) {
  const out = [];
  const t = String(text || "");
  const m = (re) => t.match(re)?.[0];
  if (m(CNIC)) out.push(reason("personal_info", m(CNIC)));
  else if (m(PHONE)) out.push(reason("personal_info", m(PHONE)));
  if (m(EMAIL)) out.push(reason("personal_info", m(EMAIL)));
  else if (m(LINK)) out.push(reason("link", m(LINK)));
  const bad = findProfanity(t) || (bannedWords || []).find((w) => w && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
  if (bad) out.push(reason("profanity", bad));
  const lower = t.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ");
  try {
    for (const [first, last] of await universityNames(universityId)) {
      if (new RegExp(`\\b${first} ${last}\\b`).test(lower)) { out.push(reason("identifies_person", `${first} ${last}`)); break; }
    }
  } catch (e) {
    console.warn(`[confessionCheck] name list not read (${e.name})`);
  }
  // doxxing (phone, e-mail, CNIC) is severe
  return { reasons: out, severe: out.some((r) => r.code === "personal_info") };
}

// ---------- c) + d) AI ----------
let client = null;
function ai() {
  if (client) return client;
  if (!process.env.OPENAI_API_KEY) return null;
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 0 });
  return client;
}
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), TIMEOUT_MS))]);

async function moderation(text, image) {
  const c = ai();
  if (!c) return { ok: false };
  const input = [];
  if (text) input.push({ type: "text", text: String(text).slice(0, 4000) });
  if (image) input.push({ type: "image_url", image_url: { url: String(image) } });
  const r = await withTimeout(c.moderations.create({ model: "omni-moderation-latest", input }));
  const res = r?.results?.[0];
  if (!res) return { ok: false };
  const cat = res.categories || {};
  const reasons = [];
  const selfHarm = !!(cat["self-harm"] || cat["self-harm/intent"] || cat["self-harm/instructions"]);
  const minors = !!cat["sexual/minors"];
  if (cat.sexual || minors) reasons.push(reason("sexual"));
  if (cat["harassment/threatening"] || cat["hate/threatening"] || cat.violence) reasons.push(reason("threat"));
  if (cat.hate || cat.harassment) reasons.push(reason("hate"));
  // images and text: graphic violence (gore). Sexual / self-harm above cover images too (omni-moderation reads both).
  if (cat["violence/graphic"]) reasons.push(reason("graphic"));
  return { ok: true, reasons, selfHarm, severe: minors || !!cat["harassment/threatening"] || !!cat["hate/threatening"] };
}

const TOPIC_PROMPT = `You check posts for a student app in Pakistan. Posts may be in English or Roman Urdu.
Answer ONLY with JSON: {"religion":bool,"politics":bool,"ethnic_or_sectarian":bool,"sexual_or_vulgar":bool,"threat":bool,"quote":string}.
religion: discusses religion, a religious group or practice. politics: political parties, politicians, elections, government politics.
ethnic_or_sectarian: racist, ethnic or sectarian content. sexual_or_vulgar: sexual or vulgar content. threat: threatens anyone.
quote: the words that triggered the first true value, or "".`;

async function topics(text) {
  const c = ai();
  if (!c) return { ok: false };
  if (!String(text || "").trim()) return { ok: true, reasons: [] };
  const r = await withTimeout(c.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: TOPIC_PROMPT }, { role: "user", content: String(text).slice(0, 4000) }],
  }));
  let j;
  try { j = JSON.parse(r?.choices?.[0]?.message?.content || ""); } catch { return { ok: false }; }
  if (!j || typeof j !== "object") return { ok: false };
  const q = typeof j.quote === "string" ? j.quote : undefined;
  const reasons = [];
  if (j.religion === true) reasons.push(reason("religion", q));
  if (j.politics === true) reasons.push(reason("politics", q));
  if (j.ethnic_or_sectarian === true) reasons.push(reason("ethnic_or_sectarian", q));
  if (j.sexual_or_vulgar === true) reasons.push(reason("sexual", q));
  if (j.threat === true) reasons.push(reason("threat", q));
  return { ok: true, reasons, severe: j.threat === true };
}

const safe = async (fn) => { try { return await fn(); } catch (e) { console.warn(`[confessionCheck] a check failed (${e.name}): held for review`); return { ok: false }; } };

/**
 * Check a confession or comment before it is saved.
 *   text, image (URL), universityId (the author's), kind: "confession" | "comment"
 */
async function check({ text = "", image = "", universityId = null } = {}) {
  const s = await settings.get();
  const [rules, mod, top] = await Promise.all([
    rulesCheck(text, { universityId, bannedWords: s.bannedWords }),
    safe(() => moderation(text, image)),
    safe(() => topics(text)),
  ]);
  const reasons = [...rules.reasons];
  for (const r of [...(mod.reasons || []), ...(top.reasons || [])]) if (!reasons.some((x) => x.code === r.code)) reasons.push(r);
  const aiOk = !!(mod.ok && top.ok);
  const severe = !!(rules.severe || mod.severe || top.severe);
  let verdict = "ok";
  if (mod.selfHarm) verdict = "selfharm";
  else if (reasons.length) verdict = "edit";
  else if (!aiOk) verdict = "hold";
  return { verdict, reasons, severe, aiOk, selfHarm: !!mod.selfHarm };
}

/** Re-check reported words (plan P4-1b): confirmed when the rules, moderation or topic check finds a breach. */
async function recheck({ text = "", image = "", universityId = null } = {}) {
  const r = await check({ text, image, universityId });
  return { confirmed: r.verdict === "edit" || r.verdict === "selfharm", reasons: r.reasons.map((x) => x.code), severe: r.severe, aiOk: r.aiOk, selfHarm: r.selfHarm };
}

module.exports = {
  check, recheck, MESSAGES,
  _setClientForTests: (c) => { client = c; },
  _clearNameCache: () => nameCache.clear(),
};
