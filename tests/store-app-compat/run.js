// The live store app (APP cdf72e6, v1.2.2) against the current server: for the crew, home, confessions, resume and
// profile screens, every field the server it was built against sent (old-shapes.json, recorded from tag
// pre-upgrade-2026-11-24 by collect.js) must still come, with the same type and the same status. New fields are fine.
//   node tests/store-app-compat/run.js [serverDir]
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const serverDir = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "store-compat-")), "now.json");
const r = spawnSync(process.execPath, [path.join(__dirname, "collect.js"), serverDir, out], { encoding: "utf8", timeout: 5 * 60 * 1000 });
if (r.status !== 0) { console.log(`FAIL  collect crashed: ${(r.stderr || "").split("\n").slice(0, 4).join(" | ")}`); console.log("0/1 passed"); process.exit(1); }
const old = JSON.parse(fs.readFileSync(path.join(__dirname, "old-shapes.json"), "utf8"));
const now = JSON.parse(fs.readFileSync(out, "utf8"));
let pass = 0; let total = 0;
for (const [key, o] of Object.entries(old)) {
  if (key.startsWith("_")) continue;
  total++;
  const n = now[key];
  const problems = [];
  if (!n) problems.push("not requested");
  else {
    if (n.status !== o.status) problems.push(`status ${o.status} → ${n.status}`);
    for (const [p, t] of Object.entries(o.shape)) {
      const nt = n.shape[p];
      if (nt === undefined) problems.push(`missing ${p} (${t})`);
      else if (!nt.split("|").some((x) => t.split("|").includes(x))) problems.push(`${p}: ${t} → ${nt}`);
    }
  }
  if (!problems.length) pass++;
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${key}: ${Object.keys(o.shape).length} fields the store app may read${problems.length ? `  (${problems.slice(0, 6).join("; ")})` : ""}`);
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
