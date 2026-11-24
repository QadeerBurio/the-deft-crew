// services/confessionImages.js
// Deletes a confession's image from Cloudinary when the post is blocked, or removed after being held / reported
// (P4-1 follow-up: no unused images left behind). Only images in OUR Cloudinary account (the configured cloud name)
// are touched; any other URL is left alone. Never throws; logs the outcome without the URL.
const PUBLIC_ID = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(.+)$/i;

/** { cloud, publicId } from a Cloudinary delivery URL, or null */
function parse(url) {
  const m = PUBLIC_ID.exec(String(url || "").split("?")[0]);
  if (!m) return null;
  // drop transformation segments (w_200,c_fill…) and the version (v123456), then the extension
  // (transformation keys are 1-2 letters, or dpr / fps: "w_200,c_fill"; a folder such as "tdc_uploads" is kept)
  const TRANSFORM = /^(?:[a-z]{1,2}|dpr|fps)_[^,/]+(?:,(?:[a-z]{1,2}|dpr|fps)_[^,/]+)*$/i;
  const parts = m[2].split("/").filter((p) => p && !/^v\d+$/.test(p) && !TRANSFORM.test(p));
  if (!parts.length) return null;
  const last = parts.pop().replace(/\.[a-z0-9]{2,5}$/i, "");
  return { cloud: m[1], publicId: [...parts, last].join("/") };
}

let destroyFn = null; // tests swap the Cloudinary call
let cloudOverride = null; // …and say which cloud is ours
async function deleteImage(url, why = "") {
  try {
    const p = parse(url);
    if (!p) return { deleted: false, why: "not a Cloudinary image" };
    const { cloudinary, hasCloudinary } = require("../config/cloudinary");
    const ours = cloudOverride || cloudinary?.config?.()?.cloud_name;
    if (!ours || (!destroyFn && !hasCloudinary)) return { deleted: false, why: "Cloudinary not configured" };
    if (p.cloud !== ours) return { deleted: false, why: "another Cloudinary account" };
    const destroy = destroyFn || ((id) => cloudinary.uploader.destroy(id, { resource_type: "image", invalidate: true }));
    const r = await destroy(p.publicId);
    console.log(`[safety] confession image ${r?.result === "ok" ? "deleted" : `not deleted (${r?.result || "unknown"})`}${why ? ` (${why})` : ""}`);
    return { deleted: r?.result === "ok", publicId: p.publicId };
  } catch (e) {
    console.warn(`[safety] confession image not deleted (${e.name})`);
    return { deleted: false, why: e.name };
  }
}

// P4a (owner, for everyone): a confession image must be one the app uploaded: our Cloudinary account (the app uploads
// to "decaxpera"; the server's configured cloud too), https, an image upload URL. Anything else is refused.
const APP_CLOUD = "decaxpera";
function isOurImage(url) {
  const u = String(url || "");
  if (u.length > 500 || /\s/.test(u)) return false;
  const p = parse(u);
  if (!p) return false;
  let configured = cloudOverride;
  if (!configured) { try { configured = require("../config/cloudinary").cloudinary?.config?.()?.cloud_name || null; } catch { configured = null; } }
  return p.cloud === APP_CLOUD || (!!configured && p.cloud === configured);
}

module.exports = { deleteImage, parse, isOurImage,_setDestroyForTests: (fn, cloud = null) => { destroyFn = fn; cloudOverride = cloud; } };
