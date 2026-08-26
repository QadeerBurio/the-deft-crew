// middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

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
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    
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