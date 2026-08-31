// controllers/profileController.js
const ProfessionalProfile = require('../models/ProfessionalProfile');
const User = require('../models/User');

// GET /api/profile/me
// Returns the logged-in user's professional profile (or null if not created yet)
exports.getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const profile = await ProfessionalProfile.findOne({ userId });
    return res.status(200).json({ profile: profile || null, hasProfile: !!profile });
  } catch (err) {
    console.error('getMyProfile error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// GET /api/profile/:userId
// Public view of another user's professional profile
exports.getProfileByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const profile = await ProfessionalProfile.findOne({ userId }).populate(
      'userId',
      'name fullName email profileImage'
    );
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    return res.status(200).json({ profile });
  } catch (err) {
    console.error('getProfileByUserId error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// POST /api/profile
// Create or upsert-update a professional profile. Body may contain any subset
// of fields so the wizard can save progress step by step.
exports.saveProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const {
      photoUrl,
      fullName,
      headline,
      university,
      fieldOfStudy,
      bio,
      skills,
      portfolioLinks,
      interestedCategories,
      servicesProvided,
      startingRate,
      rateCurrency,
      workMode,
      availabilityPerWeek,
      lastCompletedStep,
    } = req.body;

    const update = {};
    if (photoUrl !== undefined) update.photoUrl = photoUrl;
    if (fullName !== undefined) update.fullName = fullName;
    if (headline !== undefined) update.headline = headline;
    if (university !== undefined) update.university = university;
    if (fieldOfStudy !== undefined) update.fieldOfStudy = fieldOfStudy;
    if (bio !== undefined) update.bio = bio;
    if (skills !== undefined) update.skills = skills.map((s) => (typeof s === 'string' ? { name: s } : s));
    if (portfolioLinks !== undefined) update.portfolioLinks = portfolioLinks;
    if (interestedCategories !== undefined) update.interestedCategories = interestedCategories;
    if (servicesProvided !== undefined) update.servicesProvided = servicesProvided;
    if (startingRate !== undefined) update.startingRate = startingRate;
    if (rateCurrency !== undefined) update.rateCurrency = rateCurrency;
    if (workMode !== undefined) update.workMode = workMode;
    if (availabilityPerWeek !== undefined) update.availabilityPerWeek = availabilityPerWeek;
    if (lastCompletedStep !== undefined) {
      update.lastCompletedStep = Math.max(lastCompletedStep, 0);
    }

    let profile = await ProfessionalProfile.findOne({ userId });

    if (!profile) {
      profile = new ProfessionalProfile({ userId, ...update });
    } else {
      Object.assign(profile, update);
    }

    await profile.save();

    // Keep a lightweight mirror on the User document so other parts of the
    // app (e.g. avatar/name in headers) can read it without an extra call.
    if (fullName || photoUrl) {
      await User.findByIdAndUpdate(userId, {
        ...(fullName ? { name: fullName } : {}),
        ...(photoUrl ? { profileImage: photoUrl } : {}),
      });
    }

    return res.status(200).json({ profile, hasProfile: true });
  } catch (err) {
    console.error('saveProfile error:', err);
    return res.status(500).json({ error: 'Failed to save profile' });
  }
};

// PATCH /api/profile/complete
// Mark the wizard as finished (called on the final "Complete Profile" tap)
exports.completeProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const profile = await ProfessionalProfile.findOne({ userId });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found. Save at least step 1 first.' });
    }
    profile.lastCompletedStep = 5;
    profile.computeStrength();
    profile.isComplete = true;
    await profile.save();
    return res.status(200).json({ profile });
  } catch (err) {
    console.error('completeProfile error:', err);
    return res.status(500).json({ error: 'Failed to complete profile' });
  }
};

// DELETE /api/profile
exports.deleteProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    await ProfessionalProfile.findOneAndDelete({ userId });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('deleteProfile error:', err);
    return res.status(500).json({ error: 'Failed to delete profile' });
  }
};