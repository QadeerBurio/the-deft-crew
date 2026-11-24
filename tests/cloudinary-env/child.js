// Loads config/cloudinary.js once with the environment it was given and prints what it decided (names only; the
// fake values are compared here, never printed). Run by run.js in a fresh process per case, from a folder with no .env.
const path = require("path");
const Module = require("module");
const SERVER = path.resolve(process.argv[2]);
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
const logs = [];
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
const c = reqS("./config/cloudinary");
const cfg = c.cloudinary.config();
process.stdout.write(JSON.stringify({
  has: !!c.hasCloudinary,
  source: c.cloudinarySource,
  keyIs: cfg.api_key || null,
  secretIs: cfg.api_secret || null,
  cloudIs: cfg.cloud_name || null,
  offerStorage: c.offerStorage && c.offerStorage.constructor && c.offerStorage.constructor.name,
  logs,
}) + "\n");
