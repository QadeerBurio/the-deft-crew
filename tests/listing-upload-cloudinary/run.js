// Owner (25 Nov 2026): SkillShare listing attachments (POST /api/listings/upload) go to Cloudinary when it is
// configured (folder TDC_Listings, images and videos), instead of the container's disk (wiped on every deploy).
// Without Cloudinary: exactly as before (disk, /uploads/listings/<file>). The reply keeps its shape { url, type };
// type checks, the 10 MB limit and sign-in are unchanged. Cloudinary's upload is a local fake (no network).
//   node tests/listing-upload-cloudinary/run.js [serverDir]
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-listing-upload-"));
const run = (mode) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "child.js"), SERVER, mode], { cwd, encoding: "utf8", timeout: 120000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return { crash: (r.stderr || r.stdout || "").slice(0, 400) }; }
};

const c = run("cloud");
check("Cloudinary configured: an image upload answers 201 with a Cloudinary https link", c.ok && c.ok.status === 201 && /^https:\/\/res\.cloudinary\.com\/test-cloud\//.test(c.ok.json?.url || ""), JSON.stringify(c).slice(0, 300));
check("…the same reply shape as before ({ url, type: image })", c.ok && Object.keys(c.ok.json || {}).sort().join() === "type,url" && c.ok.json.type === "image");
check("…stored in the TDC_Listings folder, as image or video (resource_type auto), the whole file sent", c.uploads && c.uploads.length === 1 && c.uploads[0].folder === "TDC_Listings" && c.uploads[0].resource_type === "auto" && c.uploads[0].bytes === 204, JSON.stringify(c.uploads));
check("…nothing written to the disk", c.diskFile === false);
check("…an unsupported type is still refused (400, nothing uploaded)", c.bad && c.bad.status === 400 && /Unsupported file type/.test(c.bad.json?.error || ""));
// (pre-existing, unchanged: the auth middleware lets a request without a token through as a guest; a guest without a
// file gets 400 "No file uploaded". Guests being able to upload here is reported to the owner, not changed.)
check("…no token and no file: 400 as before", c.anon === 400, String(c.anon));

const d = run("disk");
check("Cloudinary not configured: as before, the file is saved on the server (/uploads/listings/<file>)", d.ok && d.ok.status === 201 && /\/uploads\/listings\/[0-9]+-[0-9]+\.jpg$/.test(d.ok.json?.url || "") && d.diskFile === true, JSON.stringify(d).slice(0, 300));
check("…same reply shape, unsupported type refused", Object.keys(d.ok?.json || {}).sort().join() === "type,url" && d.bad?.status === 400);

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
