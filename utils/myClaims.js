// utils/myClaims.js
// Offer lists shared by every student (/offers/summary, /brands/nearby) used to carry each offer's
// full claimedBy array: every student id that ever claimed it. Now the shared part has no claims
// and each response gets only the caller's own: claimedBy is [myId] when I claimed it, else [].
// Old app builds check `claimedBy.some(id => id === myId)`, so they keep working.
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const validId = (id) => (id && mongoose.Types.ObjectId.isValid(String(id)) ? String(id) : null);

// The signed-in user's id for a public route, or null (no token, guest, bad or expired token).
// Never rejects the request: public routes stay public.
function optionalUserId(req) {
  const [scheme, token] = String(req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  try {
    return validId(jwt.verify(token, process.env.JWT_SECRET)?.id);
  } catch {
    return null;
  }
}

// Ids (strings) of the offers this user has claimed. One indexed query (claimedBy_1).
async function myClaimedOfferIds(userId) {
  const id = validId(userId);
  if (!id) return new Set();
  const Offer = require("../models/Offer");
  const rows = await Offer.find({ claimedBy: id }).select("_id").lean();
  return new Set(rows.map((r) => String(r._id)));
}

// Same offer with claimedBy reduced to the caller's own claim
function withMyClaim(offer, mine, userId) {
  const { claimedBy, ...rest } = offer || {};
  return { ...rest, claimedBy: userId && mine.has(String(rest._id)) ? [String(userId)] : [] };
}

module.exports = { optionalUserId, myClaimedOfferIds, withMyClaim };
