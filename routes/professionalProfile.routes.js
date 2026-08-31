const express = require('express');
const router = express.Router();
const ProfessionalProfile = require('../models/ProfessionalProfile');
const auth = require('../middleware/auth.middleware');

const getUserId = (req) => {
  return req.userId || req.user?._id || req.user?.id;
};

// GET /professional-profile/me
router.get('/me', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const profile = await ProfessionalProfile.findOne({ userId });
    res.json({ profile: profile || null, hasProfile: !!profile });
  } catch (err) {
    console.error('Error fetching professional profile:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /professional-profile/:userId - view someone else's public profile
router.get('/:userId', async (req, res) => {
  try {
    const profile = await ProfessionalProfile.findOne({ userId: req.params.userId, isComplete: true });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile });
  } catch (err) {
    console.error('Error fetching professional profile by userId:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /professional-profile - upsert (create or update, called after every wizard step)
router.post('/', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      photoUrl, fullName, headline, university, fieldOfStudy, bio,
      skills, portfolioLinks, interestedCategories, servicesProvided,
      startingRate, rateCurrency, workMode, availabilityPerWeek, lastCompletedStep,
    } = req.body;

    const update = {
      ...(photoUrl !== undefined && { photoUrl }),
      ...(fullName !== undefined && { fullName }),
      ...(headline !== undefined && { headline }),
      ...(university !== undefined && { university }),
      ...(fieldOfStudy !== undefined && { fieldOfStudy }),
      ...(bio !== undefined && { bio }),
      ...(skills !== undefined && { skills }),
      ...(portfolioLinks !== undefined && { portfolioLinks }),
      ...(interestedCategories !== undefined && { interestedCategories }),
      ...(servicesProvided !== undefined && { servicesProvided }),
      ...(startingRate !== undefined && { startingRate }),
      ...(rateCurrency !== undefined && { rateCurrency }),
      ...(workMode !== undefined && { workMode }),
      ...(availabilityPerWeek !== undefined && { availabilityPerWeek }),
      ...(lastCompletedStep !== undefined && { lastCompletedStep }),
    };

    const profile = await ProfessionalProfile.findOneAndUpdate(
      { userId },
      { $set: update, $setOnInsert: { userId } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ profile, hasProfile: true });
  } catch (err) {
    console.error('Error saving professional profile:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// PATCH /professional-profile/complete
router.patch('/complete', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const profile = await ProfessionalProfile.findOneAndUpdate(
      { userId },
      { $set: { isComplete: true, completedAt: new Date(), lastCompletedStep: 5 } },
      { new: true }
    );

    if (!profile) return res.status(404).json({ error: 'Profile not found. Save at least one step first.' });

    res.json({ profile });
  } catch (err) {
    console.error('Error completing professional profile:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /professional-profile
router.delete('/', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await ProfessionalProfile.findOneAndDelete({ userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting professional profile:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;