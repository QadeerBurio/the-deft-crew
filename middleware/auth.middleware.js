// middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    // FIX 1: Allow guest access without token
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
      return res.status(401).json({ message: "Token is missing or null" });
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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    
    req.user = user;
    req.userId = decoded.id;
    req.userRole = decoded.role;
    req.isGuest = false;
    next();
    
  } catch (err) {
    // FIX 2: Allow expired/invalid tokens as guest
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
    next();
  }
};