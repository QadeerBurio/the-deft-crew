// One case of the listing-upload test, in its own process (the Cloudinary module keeps its settings per process).
// argv: serverDir, "cloud" | "disk". With "cloud", fake credentials are set and Cloudinary's upload stream is
// replaced by a local fake (no network): it reads the file and answers like Cloudinary does.
const { Writable } = require("stream");
const path = require("path");
const Module = require("module");
const fs = require("fs");
const [serverDir, mode] = process.argv.slice(2);
const SERVER = path.resolve(serverDir);
const reqS = Module.createRequire(path.join(SERVER, "server.js"));
const quiet = console.log; console.log = () => {}; console.error = () => {}; console.warn = () => {};
const say = (...a) => quiet(...a);

for (const k of Object.keys(process.env)) if (/^CLOUDINARY_/.test(k)) delete process.env[k];
const uploads = [];
if (mode === "cloud") {
  process.env.CLOUDINARY_NAME = "test-cloud";
  process.env.CLOUDINARY_KEY = "fake-key";
  process.env.CLOUDINARY_SECRET = "fake-secret";
  const cloudinary = reqS("cloudinary").v2;
  cloudinary.uploader.upload_stream = (params, cb) => {
    let bytes = 0;
    return new Writable({
      write(chunk, enc, next) { bytes += chunk.length; next(); },
      final(done) {
        const id = `${params.folder}/fake_${uploads.length + 1}`;
        const kind = params.resource_type === "auto" ? "image" : params.resource_type;
        uploads.push({ params, bytes });
        cb(null, { public_id: id, secure_url: `https://res.cloudinary.com/test-cloud/${kind}/upload/v1/${id}.jpg`, bytes, format: "jpg", resource_type: kind });
        done();
      },
    });
  };
}

// the harness swaps config/cloudinary.js for an always-configured stub; this test needs the real one (it decides
// Cloudinary vs disk from the environment above). Loaded before the harness, from a folder without a .env.
if (fs.existsSync(path.join(process.cwd(), ".env"))) { say(JSON.stringify({ crash: "a .env in the working folder" })); process.exit(1); }
const realCloudConfig = reqS("./config/cloudinary");
const h = require("../hiring-fixes/harness")(SERVER, { extraRoutes: [], models: ["Listing", "SkillOffer"] });
const harnessLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return ""; } })();
  if (resolved.endsWith(path.join("config", "cloudinary.js"))) return realCloudConfig;
  return harnessLoad.apply(this, arguments);
};
h.app.use("/api/listings", reqS("./routes/listing.routes"));
const { oid, user, token, fake, coll } = h;
const U = oid();
fake.seed(coll("User"), [user(U, "student", "Sana Student")]);
const T = token(U, "student");

(async () => {
  const server = h.start();
  const out = {};
  // a small JPEG-typed file and an unsupported type
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(200).fill(7)]);
  const send = (name, type, buf) => {
    const b = "----tdc" + Math.random().toString(16).slice(2);
    const raw = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
    return h.call("POST", "/api/listings/upload", { tok: T, raw, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
  };
  const ok = await send("photo.jpg", "image/jpeg", jpg);
  out.ok = { status: ok.status, json: ok.json };
  const bad = await send("notes.txt", "text/plain", Buffer.from("hello"));
  out.bad = { status: bad.status, json: bad.json };
  const anon = await h.call("POST", "/api/listings/upload", {});
  out.anon = anon.status;
  out.uploads = uploads.map((u) => ({ folder: u.params.folder, resource_type: u.params.resource_type, bytes: u.bytes }));
  const dir = path.join(SERVER, "uploads", "listings");
  out.diskFile = ok.json && ok.json.url && /\/uploads\/listings\//.test(ok.json.url) ? fs.existsSync(path.join(dir, ok.json.url.split("/").pop())) : false;
  if (out.diskFile) fs.unlinkSync(path.join(dir, ok.json.url.split("/").pop())); // clean up the test's own file
  server.close();
  say(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { say(JSON.stringify({ crash: String(e && e.stack || e).slice(0, 400) })); process.exit(1); });
