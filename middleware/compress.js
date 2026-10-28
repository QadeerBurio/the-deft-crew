// middleware/compress.js
// gzip JSON responses (Railway's edge already gzips to the phone; this shrinks the
// server -> edge hop too). Never the AI chat / travel streams (/api/v1, text/event-stream):
// gzip would hold their tokens back until a buffer fills.
const compression = require("compression");

function shouldCompress(req, res) {
  if (req.path.startsWith("/api/v1")) return false;
  if (res.getHeader("x-no-compression")) return false;
  if (String(res.getHeader("Content-Type") || "").includes("text/event-stream")) return false;
  return compression.filter(req, res);
}

module.exports = () => compression({ filter: shouldCompress });
module.exports.shouldCompress = shouldCompress;
