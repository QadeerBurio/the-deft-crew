// middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

// The fields routes read from req.user (every req.user.<field> in routes/, services/, utils/,
// middleware/): _id, id, role, name, email, university, phone, location, headline. Loaded lean,
// instead of the whole document (every field but the password) on every signed-in request.
// routes/jobs.routes.js loads its own full user and is not affected.
const REQ_USER_FIELDS = "_id role name email university phone location headline";
// read only for the lock-out check (plan P0-6) and removed again before req.user is set, so routes see the same fields
const STATUS_FIELDS = "accountStatus suspensionExpiry suspensionReason";
const { lockOf, lockBody } = require("../services/accountStatus");

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    // If no token, user is guest
    if (!authHeader) {
      req.user = {
        id: 'guest-user',
        role: 'guest',
        email: 'guest@example.com',
        name: 'Guest User',
        isGuest: true
      };
      req.isGuest = true;
      req.userId = 'guest-user';
      req.userRole = 'guest';
      return next();
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid token format" });
    }

    const token = parts[1];
    
    if (!token || token === "undefined" || token === "null") {
      req.isGuest = true;
      req.userId = 'guest-user';
      req.userRole = 'guest';
      return next();
    }
    
    // Handle guest token
    if (token === 'guest-token-2024') {
      req.user = {
        id: 'guest-user',
        role: 'guest',
        email: 'guest@example.com',
        name: 'Guest User',
        isGuest: true
      };
      req.isGuest = true;
      req.userId = 'guest-user';
      req.userRole = 'guest';
      return next();
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.id).select(`${REQ_USER_FIELDS} ${STATUS_FIELDS}`).lean();
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    // suspended / banned accounts (only while the accountStatusEnforce flag is on; admins never). 401, so the app's
    // existing handling signs the account out; the next login then shows the reason.
    const lock = lockOf(user);
    for (const f of STATUS_FIELDS.split(" ")) delete user[f];
    if (lock.locked) {
      return res.status(401).json(lockBody(lock));
    }
    user.id = String(user._id); // Mongoose's "id" virtual; routes use req.user.id
    
    // Set user data on request
    req.user = user;
    req.userId = decoded.id;
    req.userRole = user.role || decoded.role || 'student';
    req.isGuest = false;
    next();
    
  } catch (err) {
    // Return proper 401 Unauthorized if token verification fails
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: "Invalid token" });
    }
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Token expired" });
    }
    
    return res.status(401).json({ message: "Authentication failed", error: err.message });
  }
};