// Company verification proof (feat/company-proof), on in-memory data:
//   - the e-mail domain and website are optional; proof = at least one of domain, website, uploaded document
//   - upload: PDF / JPEG / PNG / WebP up to 5 MB, the file's bytes must match its type, a kind is required
//   - submit with only a document: pending; with none of the three: 400 PROOF_REQUIRED; someone else's document: 400
//   - the menu chip: not_submitted -> under_review -> needs_info -> under_review -> verified
//   - admin: the proof given (domain / website / documents), opens the document (logged); the employer who uploaded
//     it, another employer, a student and a signed-out caller can't; a document of another verification: 404
//   - request info / reject with a reason the employer sees; resubmit after "needs info" with a new document
//   node tests/company-proof/run.js [serverDir]
const http = require("http");
const h = require("../hiring-fixes/harness")(process.argv[2], { extraRoutes: [["/api/career", "./routes/hiringAccess.routes"]], models: ["EmployerHiringAccess", "EmployerPlanRequest", "EmployerVerificationDocument"] });
const { call, check, rows, same, oid, user, token, fake, coll } = h;

const ids = { E1: oid(), E2: oid(), E3: oid(), S1: oid(), admin: oid() };
fake.seed(coll("User"), [
  user(ids.E1, "employee", "Small Shop", { companyName: "Karachi Tailors", email: "karachitailors@gmail.com" }),
  user(ids.E2, "employee", "Other Boss", { companyName: "Other Co" }),
  user(ids.E3, "employee", "Domain Boss", { companyName: "Domain Co", email: "boss@domainco.pk" }),
  user(ids.S1, "student", "Student One"), user(ids.admin, "admin", "Admin One"),
]);
const T = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, token(id, k === "S1" ? "student" : k === "admin" ? "admin" : "employee")]));
const B = "/api/career";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% ntn certificate\n"), Buffer.alloc(200, 32), Buffer.from("\n%%EOF\n")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

// multipart with a file and text fields
let PORT;
function multipart(url, tok, { file, filename = "proof.pdf", type = "application/pdf", fields = {} }) {
  const b = "----tdcproof" + Math.random().toString(16).slice(2);
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), file, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return call("POST", url, { tok, raw: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } });
}
// a raw GET that keeps the bytes
const getRaw = (url, tok) => new Promise((resolve) => {
  const q = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: url, headers: tok ? { authorization: `Bearer ${tok}` } : {} }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  q.end();
});
const me = async (k) => (await call("GET", `${B}/employers/me/company-verification`, { tok: T[k] })).json?.data;
const base = { companyName: "Karachi Tailors", registrationType: "ntn", ntnOrSecp: "1234567-8" };

(async () => {
  const server = h.start();
  PORT = server.address().port;
  let r, d;

  d = await me("E1");
  check("menu chip before anything: not_submitted", d.chip === "not_submitted" && !d.verification);

  // ---------- upload ----------
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: PDF, fields: { kind: "ntn_certificate" } });
  const D1 = r.json?.data?.id;
  check("upload a PDF NTN certificate: 201 with its id (no file content in the reply)", r.status === 201 && D1 && r.json.data.kind === "ntn_certificate" && r.json.data.mimeType === "application/pdf" && !("data" in r.json.data), r.text.slice(0, 200));
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: PDF, fields: {} });
  check("no kind: 400 INVALID_KIND", r.status === 400 && r.json.error.code === "INVALID_KIND");
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: Buffer.from("<html>not a pdf</html>          "), fields: { kind: "letterhead" } });
  check("a file that isn't really a PDF: 400 INVALID_FILE_TYPE", r.status === 400 && r.json.error.code === "INVALID_FILE_TYPE");
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: Buffer.from("MZ executable bytes here.."), filename: "x.exe", type: "application/octet-stream", fields: { kind: "letterhead" } });
  check("another file type: 400", r.status === 400 && r.json.error.code === "INVALID_FILE_TYPE");
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * 1024 * 1024 + 10, 32)]), fields: { kind: "ntn_certificate" } });
  check("over 5 MB: 413 FILE_TOO_LARGE", r.status === 413 && r.json.error.code === "FILE_TOO_LARGE");
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.S1, { file: PDF, fields: { kind: "ntn_certificate" } });
  check("a student can't upload", r.status === 403);
  const stored = rows("EmployerVerificationDocument");
  check("only the valid file was stored", stored.length === 1 && same(stored[0].employerUserId, ids.E1));

  // ---------- submit ----------
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: base });
  check("none of domain, website or document: 400 PROOF_REQUIRED", r.status === 400 && r.json.error.code === "PROOF_REQUIRED" && /at least one/.test(r.json.error.message));
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, businessEmailDomain: "gmail.com" } });
  check("a free-mail domain is still refused (with a hint to upload instead)", r.status === 400 && r.json.error.code === "FREE_MAIL_DOMAIN" && /upload a document/.test(r.json.error.message));
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E2, { file: PNG, filename: "letter.png", type: "image/png", fields: { kind: "letterhead" } });
  const D2 = r.json?.data?.id;
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, documentIds: [D2] } });
  check("someone else's document: 400 INVALID_DOCUMENT", r.status === 400 && r.json.error.code === "INVALID_DOCUMENT");
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, documentIds: [D1] } });
  check("only a document (no domain, no website): 201 pending", r.status === 201 && r.json.data.verification.status === "pending" && r.json.data.verification.businessEmailDomain === "" && r.json.data.verification.website === "" && r.json.data.verification.documents.length === 1, r.text.slice(0, 300));
  check("menu chip: under_review", r.json.data.chip === "under_review");
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E3, body: { companyName: "Domain Co", registrationType: "ntn", ntnOrSecp: "7654321-0", businessEmailDomain: "domainco.pk" } });
  check("only an own e-mail domain (no website, no document): 201", r.status === 201 && r.json.data.verification.status === "pending");
  check("an empty domain doesn't make two document-only companies duplicates", rows("EmployerCompanyVerification").every((v) => !(v.duplicateOf || []).length));

  // ---------- admin: proof and the document ----------
  r = await call("GET", `${B}/admin/company-verifications?status=pending`, { tok: T.admin });
  const v1 = r.json?.data?.find((x) => x.employer.id === String(ids.E1));
  check("admin list: the proof given (no domain, no website, 1 document) and the document's name and kind", v1 && v1.proof.emailDomain === false && v1.proof.website === false && v1.proof.documents === 1 && v1.documents[0].id === D1 && v1.documents[0].kind === "ntn_certificate", JSON.stringify(v1?.proof));
  check("the list never carries the file itself", !r.text.includes("% ntn certificate") && !r.text.includes("%PDF") && !r.json.data.some((x) => "data" in x));
  const url = `${B}/admin/company-verifications/${v1.id}/documents/${D1}`;
  let g = await getRaw(url, T.admin);
  check("admin opens the document: the same bytes, its type, inline, not cached", g.status === 200 && g.body.equals(PDF) && g.headers["content-type"].startsWith("application/pdf") && /inline/.test(g.headers["content-disposition"]) && /no-store/.test(g.headers["cache-control"]) && g.headers["x-content-type-options"] === "nosniff", `${g.status} ${g.headers["content-type"]}`);
  check("opening it is logged", rows("AdminActionLog", (l) => l.action === "employer.verification.document_open" && l.targetId === D1).length === 1);
  for (const [who, tok] of [["the employer who uploaded it", T.E1], ["another employer", T.E2], ["a student", T.S1], ["signed out", null]]) {
    g = await getRaw(url, tok);
    check(`${who} can't open it`, [401, 403].includes(g.status) && !g.body.includes(Buffer.from("ntn certificate")), String(g.status));
  }
  const v3 = r.json.data.find((x) => x.employer.id === String(ids.E3));
  g = await getRaw(`${B}/admin/company-verifications/${v3.id}/documents/${D1}`, T.admin);
  check("a document through another company's verification: 404", g.status === 404);
  g = await getRaw(`${B}/admin/company-verifications/${v1.id}/documents/${D2}`, T.admin);
  check("an uploaded document not attached to this verification: 404", g.status === 404);

  // ---------- request info, resubmit ----------
  r = await call("POST", `${B}/admin/company-verifications/${v1.id}/review`, { tok: T.admin, body: { action: "request_info" } });
  check("request info without a reason: 400", r.status === 400);
  r = await call("POST", `${B}/admin/company-verifications/${v1.id}/review`, { tok: T.admin, body: { action: "request_info", reason: "The NTN certificate is unreadable: upload a clearer scan" } });
  check("admin requests info: status needs_info, logged", r.status === 200 && r.json.data.status === "needs_info" && rows("AdminActionLog", (l) => l.action === "employer.verification.review" && l.after?.status === "needs_info").length === 1);
  d = await me("E1");
  check("the employer sees what's needed; menu chip needs_info", d.chip === "needs_info" && d.actionNeeded?.status === "needs_info" && /clearer scan/.test(d.actionNeeded.reason) && d.verification.status === "needs_info");
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: PNG, filename: "ntn-scan.png", type: "image/png", fields: { kind: "ntn_certificate" } });
  const D3 = r.json?.data?.id;
  check("a new (PNG) scan uploads", r.status === 201 && D3);
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, documentIds: [D3] } });
  check("resubmit after 'needs info': under review again, the new document attached, reason cleared", r.status === 200 && r.json.data.verification.status === "pending" && r.json.data.verification.documents.length === 1 && r.json.data.verification.documents[0].id === D3 && r.json.data.chip === "under_review" && !r.json.data.actionNeeded, r.text.slice(0, 300));
  check("the history keeps both submissions and the request", rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E1))[0].history.map((x) => x.action).join(",") === "submitted,request_info,resubmitted");
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, documentIds: [D3] } });
  check("the same details again while under review: nothing new", r.status === 200 && rows("EmployerCompanyVerification", (v) => same(v.employerUserId, ids.E1))[0].history.length === 3);

  // reject -> the reason -> resubmit; approve -> verified
  r = await call("POST", `${B}/admin/company-verifications/${v1.id}/review`, { tok: T.admin, body: { action: "reject", reason: "The NTN doesn't match the certificate" } });
  d = await me("E1");
  check("rejected: the employer sees why, chip needs_info", d.chip === "needs_info" && d.actionNeeded?.status === "rejected" && /doesn't match/.test(d.actionNeeded.reason));
  r = await call("POST", `${B}/employers/me/company-verification`, { tok: T.E1, body: { ...base, ntnOrSecp: "1234567-9", documentIds: [D3] } });
  check("resubmit after a rejection: under review", r.status === 200 && r.json.data.verification.status === "pending");
  r = await call("POST", `${B}/admin/company-verifications/${v1.id}/review`, { tok: T.admin, body: { action: "approve", reason: "NTN checked on FBR" } });
  d = await me("E1");
  check("approved: chip verified", r.status === 200 && d.chip === "verified" && d.verified === true);
  r = await multipart(`${B}/employers/me/company-verification/documents`, T.E1, { file: PDF, fields: { kind: "letterhead" } });
  check("no more uploads once verified (409)", r.status === 409);

  h.finish(server);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
