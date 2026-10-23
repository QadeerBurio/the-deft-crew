// server.js must refuse to start without JWT_SECRET.
//   node tests/hide-user-secrets/startup-check.js <serverDir>
// Runs server.js with JWT_SECRET unset and dotenv stubbed (no .env is read), expects exit code 1
// and the FATAL message before anything connects.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const stub = path.join(os.tmpdir(), "tdc-no-dotenv.js");
fs.writeFileSync(stub, `const M=require("module");const l=M._load;M._load=function(r){if(r==="dotenv")return{config:()=>({parsed:{}})};return l.apply(this,arguments)};`);
const env = { ...process.env };
delete env.JWT_SECRET;
const r = spawnSync(process.execPath, ["-r", stub, path.join(SERVER, "server.js")], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 20000 });
const fatal = /FATAL: JWT_SECRET is not set/.test(r.stderr || "");
console.log(`${r.status === 1 && fatal ? "PASS" : "FAIL"}  server refuses to start without JWT_SECRET (exit ${r.status}${fatal ? ", FATAL logged" : ""})`);
process.exit(r.status === 1 && fatal ? 0 : 1);
