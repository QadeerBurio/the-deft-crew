// services/crew/certificate.js
// Plan P2-5 (owner): credential PDFs made on the server (pdfkit; no new package): the holder's name, role, university,
// dates, the credential id, and a verify link + QR code (https://gettdc.pk/verify/<id>), backed by the public verify
// route. Certificates are laid out from the record; a recommendation letter prints the text an admin wrote and
// approved (never generated). A revoked credential's page says "revoked".
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const VERIFY_BASE = () => String(process.env.PORTAL_URL || "https://gettdc.pk").replace(/\/$/, "");
const verifyUrl = (id) => `${VERIFY_BASE()}/verify/${id}`;
const TITLES = { certificate: "certificate of ambassadorship", founder_card: "founder circle", badge: "tdc badge", letter: "letter of recommendation", recommendation: "letter of recommendation" };
const LETTERS = new Set(["letter", "recommendation"]);
const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" }) : "");

/** Can this credential be printed? (a letter only with approved text) */
const printable = (c) => !!c && (!LETTERS.has(c.type) || (!!String(c.letterText || "").trim() && !!c.approvedAt));

/** The public facts (verify page and PDF): name, role, university, dates, status */
async function facts(credential) {
  const User = require("../../models/User");
  const EngagementProfile = require("../../models/EngagementProfile");
  const [u, p] = await Promise.all([
    User.findById(credential.user).select("name universityName university").populate("university", "name").lean(),
    EngagementProfile.findOne({ user: credential.user }).select("partner").lean(),
  ]);
  return {
    id: String(credential._id),
    name: u?.name || "",
    role: credential.type === "founder_card" ? "founder circle member" : "campus ambassador",
    university: p?.partner?.university || u?.university?.name || u?.universityName || "",
    since: p?.partner?.since || null,
    issuedAt: credential.issuedAt || null,
    status: credential.status === "revoked" ? "revoked" : "valid",
    revokedAt: credential.revokedAt || null,
  };
}

/** → a PDF Buffer */
async function render(credential) {
  const f = await facts(credential);
  const url = verifyUrl(f.id);
  const qr = await QRCode.toBuffer(url, { margin: 1, width: 240 });
  const letter = LETTERS.has(credential.type);
  const doc = new PDFDocument({ size: "A4", layout: letter ? "portrait" : "landscape", margin: 56, info: { Title: `${TITLES[credential.type] || "tdc credential"}: ${f.name}`, Author: "tdc (the deft crew)" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width; const H = doc.page.height;
  doc.rect(28, 28, W - 56, H - 56).lineWidth(2).stroke("#111111");
  doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text("tdc.", 56, 56);
  if (letter) {
    doc.moveDown(2).font("Helvetica-Bold").fontSize(22).text(TITLES[credential.type]);
    doc.moveDown(0.5).font("Helvetica").fontSize(11).fillColor("#555555").text(day(f.issuedAt));
    doc.moveDown(1.2).fillColor("#111111").fontSize(12).text(String(credential.letterText || "").trim(), { align: "left", lineGap: 4 });
    doc.moveDown(1.5).fontSize(11).text(`${f.name} · ${f.role}${f.university ? ` · ${f.university}` : ""}`);
  } else {
    doc.font("Helvetica").fontSize(14).fillColor("#555555").text(TITLES[credential.type] || "tdc credential", 0, H * 0.24, { align: "center", width: W });
    doc.font("Helvetica-Bold").fontSize(36).fillColor("#111111").text(f.name, 0, H * 0.33, { align: "center", width: W });
    doc.font("Helvetica").fontSize(16).text(`${f.role}${f.university ? `, ${f.university}` : ""}`, 0, H * 0.46, { align: "center", width: W });
    const dates = [f.since ? `since ${day(f.since)}` : "", f.issuedAt ? `issued ${day(f.issuedAt)}` : ""].filter(Boolean).join(" · ");
    doc.fontSize(12).fillColor("#555555").text(dates, 0, H * 0.53, { align: "center", width: W });
  }
  doc.image(qr, W - 56 - 96, H - 56 - 120, { width: 96 });
  doc.font("Helvetica").fontSize(9).fillColor("#555555")
    .text(`credential ${f.id}`, 56, H - 80, { width: W - 240 })
    .text(`verify: ${url}`, 56, H - 68, { width: W - 240, link: url });
  if (f.status === "revoked") doc.font("Helvetica-Bold").fontSize(40).fillColor("#D9443F").text("REVOKED", 0, H * 0.62, { align: "center", width: W });
  doc.end();
  return done;
}

module.exports = { render, facts, printable, verifyUrl, LETTERS };
