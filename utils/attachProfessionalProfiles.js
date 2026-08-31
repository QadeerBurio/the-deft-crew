const ProfessionalProfile = require('../models/ProfessionalProfile');

/**
 * Overlays ProfessionalProfile (fullName / photoUrl / headline) onto an
 * already-populated User ref, so listing cards show the user's professional
 * identity instead of their raw signup name/photo. Falls back to the User
 * fields if no professional profile exists.
 *
 * Works on plain (lean) objects only — call after .lean() on your query.
 *
 * @param {Object|Object[]} docs - lean doc(s) containing a populated user ref
 * @param {string} path - dot path to the populated user object,
 *                         e.g. 'ownerId', 'offerorId', or 'listingId.ownerId'
 */
async function attachProfessionalProfiles(docs, path = 'ownerId') {
  const arr = Array.isArray(docs) ? docs : [docs];
  const keys = path.split('.');
  const getOwner = (doc) => keys.reduce((acc, k) => acc?.[k], doc);

  const ownerIds = [...new Set(
    arr
      .map((d) => {
        const owner = getOwner(d);
        const id = owner?._id || owner;
        return id ? id.toString() : null;
      })
      .filter(Boolean)
  )];

  if (ownerIds.length === 0) return docs;

  const profiles = await ProfessionalProfile.find({ userId: { $in: ownerIds } })
    .select('userId fullName photoUrl headline')
    .lean();

  const profileMap = {};
  profiles.forEach((p) => { profileMap[p.userId.toString()] = p; });

  arr.forEach((d) => {
    const owner = getOwner(d);
    if (owner && typeof owner === 'object' && owner._id) {
      const prof = profileMap[owner._id.toString()];
      if (prof) {
        owner.name = prof.fullName || owner.name;
        owner.profileImage = prof.photoUrl || owner.profileImage;
        owner.headline = prof.headline || '';
      }
    }
  });

  return docs;
}



module.exports = attachProfessionalProfiles;



/**
 * Same idea as attachProfessionalProfiles, but for when the array/object
 * itself IS the user doc (not nested under a ref field) — e.g. Conversation
 * participants, Message senders, or a manually-fetched "otherUser".
 *
 * @param {Object|Object[]} users - lean user doc(s), each with at least _id
 */
async function attachProfessionalProfilesToUsers(users) {
  const arr = Array.isArray(users) ? users : [users];
  const ids = [...new Set(
    arr.filter(Boolean).map((u) => (u._id || u).toString())
  )];

  if (ids.length === 0) return users;

  const profiles = await ProfessionalProfile.find({ userId: { $in: ids } })
    .select('userId fullName photoUrl headline')
    .lean();

  const profileMap = {};
  profiles.forEach((p) => { profileMap[p.userId.toString()] = p; });

  arr.forEach((u) => {
    if (u && u._id) {
      const prof = profileMap[u._id.toString()];
      if (prof) {
        u.name = prof.fullName || u.name;
        u.profileImage = prof.photoUrl || u.profileImage;
        u.headline = prof.headline || '';
      }
    }
  });

  return users;
}

module.exports = attachProfessionalProfiles;
module.exports.attachProfessionalProfilesToUsers = attachProfessionalProfilesToUsers;