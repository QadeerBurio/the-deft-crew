// Owner (25 Nov 2026): config/cloudinary.js also reads the key and secret from CLOUDINARY_KEY / CLOUDINARY_SECRET
// (production's names), so uploads don't fall back to the container's disk; CLOUDINARY_API_KEY / _API_SECRET win when
// both are set; when something is missing it says which names, loudly; values are never logged. Each case loads the
// config in a fresh process (the Cloudinary module keeps its settings per process), from a folder without a .env, with
// fake values.
//   node tests/cloudinary-env/run.js [serverDir]
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-cloudinary-env-"));
const base = { ...process.env };
for (const k of Object.keys(base)) if (/^CLOUDINARY_/.test(k)) delete base[k];
const run = (env) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "child.js"), SERVER], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return { crash: (r.stderr || r.stdout || "").slice(0, 300) }; }
};
check("runs from a folder without a .env (no real settings can load)", !fs.existsSync(path.join(cwd, ".env")));

const NAME = "test-cloud", K = "fake-key-123", S = "fake-secret-456";

let r = run({ CLOUDINARY_NAME: NAME, CLOUDINARY_KEY: K, CLOUDINARY_SECRET: S });
check("production's names (CLOUDINARY_KEY / CLOUDINARY_SECRET): configured", r.has === true && r.keyIs === K && r.secretIs === S && r.cloudIs === NAME, JSON.stringify(r).slice(0, 200));
check("…uploads go to Cloudinary, not the disk", r.offerStorage === "CloudinaryStorage", r.offerStorage);
check("…the log names where the key came from, never the values", r.logs.some((l) => /key from CLOUDINARY_KEY, secret from CLOUDINARY_SECRET/.test(l)) && !r.logs.some((l) => l.includes(K) || l.includes(S)), r.logs.join(" | "));

r = run({ CLOUDINARY_NAME: NAME, CLOUDINARY_API_KEY: K, CLOUDINARY_API_SECRET: S });
check("the documented names (CLOUDINARY_API_KEY / _API_SECRET): configured as before", r.has === true && r.keyIs === K && r.secretIs === S && r.source.key === "CLOUDINARY_API_KEY");

r = run({ CLOUDINARY_NAME: NAME, CLOUDINARY_API_KEY: K, CLOUDINARY_API_SECRET: S, CLOUDINARY_KEY: "other-key", CLOUDINARY_SECRET: "other-secret" });
check("both set: the CLOUDINARY_API_* names win", r.keyIs === K && r.secretIs === S && r.source.key === "CLOUDINARY_API_KEY" && r.source.secret === "CLOUDINARY_API_SECRET");

r = run({ CLOUDINARY_NAME: NAME, CLOUDINARY_KEY: K });
check("secret missing: not configured, disk fallback", r.has === false && r.offerStorage !== "CloudinaryStorage", JSON.stringify(r).slice(0, 200));
check("…and it says, as an error, exactly what is missing", r.logs.some((l) => /❌ \[Cloudinary\] not configured, missing: CLOUDINARY_API_SECRET \(or CLOUDINARY_SECRET\)\. Uploads go to the local disk/.test(l)), r.logs.join(" | "));

r = run({ CLOUDINARY_NAME: NAME, CLOUDINARY_KEY: "   ", CLOUDINARY_SECRET: S });
check("a blank value counts as missing", r.has === false);

r = run({});
check("nothing set: not configured (as before)", r.has === false && r.logs.some((l) => /missing: CLOUDINARY_NAME, CLOUDINARY_API_KEY \(or CLOUDINARY_KEY\), CLOUDINARY_API_SECRET \(or CLOUDINARY_SECRET\)/.test(l)));

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
