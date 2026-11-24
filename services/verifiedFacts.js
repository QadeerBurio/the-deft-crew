// services/verifiedFacts.js
// P3d "verified by tdc" (flag resumeVerified): only facts tdc itself has checked, never anything the student typed.
//   - a verified student (the account's status "Verified", set by tdc after the student-ID check) at their university
//   - a campus ambassador certificate / founder circle card that tdc issued and hasn't revoked, with its public verify
//     link (the portal page gettdc.pk/verify/<id>, services/crew/certificate.js)
// No event certificates: tdc keeps no attendance record to rely on (P3a note).
//   factsFor(userId) → [{ kind: "student" | "ambassador" | "founder", text, url? }]   ([] when nothing is verified)

const ROLES = { certificate: { kind: "ambassador", text: "campus ambassador" }, founder_card: { kind: "founder", text: "founder circle member" } };

async function factsFor(userId) {
  const User = require("../models/User");
  const Credential = require("../models/Credential");
  const { verifyUrl } = require("./crew/certificate");
  const [u, creds] = await Promise.all([
    User.findById(userId).select("role status universityName university").populate("university", "name").lean(),
    Credential.find({ user: userId, status: "issued", type: { $in: Object.keys(ROLES) } }).select("type issuedAt").sort({ issuedAt: 1 }).lean(),
  ]);
  const facts = [];
  if (u && u.role === "student" && u.status === "Verified") {
    const uni = String(u.university?.name || u.universityName || "").trim();
    facts.push({ kind: "student", text: uni ? `verified student at ${uni}` : "verified student" });
  }
  const seen = new Set();
  for (const c of creds || []) {
    const r = ROLES[c.type];
    if (!r || seen.has(r.kind)) continue; // one line per role (the first issued)
    seen.add(r.kind);
    facts.push({ kind: r.kind, text: r.text, url: verifyUrl(String(c._id)) });
  }
  return facts;
}

module.exports = { factsFor };
