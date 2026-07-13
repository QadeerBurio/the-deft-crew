const express = require('express');
const router = express.Router();
const Listing = require('../models/Listing');
const auth = require('../middleware/auth.middleware');

// Helper function to get user ID consistently
const getUserId = (req) => {
  return req.userId || req.user?._id || req.user?.id;
};

// 1. POST /api/listings - Create a new listing
router.post('/', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const ownerId = userId || req.body.ownerId;
    
    if (!ownerId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const listingData = {
      ...req.body,
      ownerId: ownerId
    };

    const listing = new Listing(listingData);
    await listing.validate();
    await listing.save();
    
    // ✅ Fix: Only populate fields that exist in User schema
    const populatedListing = await Listing.findById(listing._id)
      .populate('ownerId', 'name email profileImage role');
    
    res.status(201).json(populatedListing);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(val => val.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('Error creating listing:', err);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: err.message
    });
  }
});

// 2. GET /api/listings - Get all open listings with filters
router.get('/', async (req, res) => {
  try {
    const { type, skillName, page = 1, limit = 20 } = req.query;
    
    const query = { status: 'open' };
    
    if (type && type !== 'All') {
      query.type = type.toLowerCase();
    }
    
    if (skillName) {
      query['skillOffered.skillName'] = { $regex: skillName, $options: 'i' };
    }
    
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    
    // ✅ Fix: Only populate fields that exist
    const listings = await Listing.find(query)
      .populate('ownerId', 'name email profileImage role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    res.json(listings);
  } catch (err) {
    console.error('Error fetching listings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. GET /api/listings/mine - Get current user's listings (Improved)
router.get('/mine', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    
    // ✅ Fix: Use current user ID from auth
    const listings = await Listing.find({ ownerId: userId })
      .populate('ownerId', 'name email profileImage role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Get total count for pagination
    const total = await Listing.countDocuments({ ownerId: userId });
      
    res.json({
      listings,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error('Error fetching my listings:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. GET /api/listings/:id - Get a single listing by ID
router.get('/:id', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .populate('ownerId', 'name email profileImage role');
      
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json(listing);
  } catch (err) {
    console.error('Error fetching single listing:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. GET /api/listings/:id/suggested-matches - Get suggested matches
router.get('/:id/suggested-matches', async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    if (listing.type !== 'barter') {
      return res.status(400).json({ error: 'suggested matches only apply to barter listings' });
    }
    
    const myOfferedSkill = listing.skillOffered.skillName;
    const myWantedSkill = listing.skillWanted.skillName;
    
    // ✅ Fix: Only populate fields that exist
    const matches = await Listing.find({
      _id: { $ne: listing._id },
      status: 'open',
      type: 'barter',
      'skillOffered.skillName': { $regex: new RegExp(myWantedSkill, 'i') },
      'skillWanted.skillName': { $regex: new RegExp(myOfferedSkill, 'i') }
    })
    .populate('ownerId', 'name email profileImage role')
    .limit(10);
    
    res.json(matches);
  } catch (err) {
    console.error('Error finding suggested matches:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6. PATCH /api/listings/:id/close - Close a listing
router.patch('/:id/close', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    // ✅ Fix: Compare ObjectIds properly
    if (listing.ownerId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You are not the owner of this listing' });
    }
    
    listing.status = 'closed';
    await listing.save();
    
    // Return populated listing
    const updatedListing = await Listing.findById(listing._id)
      .populate('ownerId', 'name email profileImage role');
    
    res.json(updatedListing);
  } catch (err) {
    console.error('Error closing listing:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 7. DELETE /api/listings/:id - Delete a listing (NEW)
router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    if (listing.ownerId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You are not the owner of this listing' });
    }
    
    await Listing.findByIdAndDelete(req.params.id);
    res.json({ message: 'Listing deleted successfully' });
  } catch (err) {
    console.error('Error deleting listing:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;