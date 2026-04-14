// middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User"); // Import User model

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid token format" });
    }

    const token = parts[1];
    
    // Check if token is actually present and not the string "undefined"
    if (!token || token === "undefined" || token === "null") {
      return res.status(401).json({ message: "Token is missing or null" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get full user details from database
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    
    // Attach to request object
    req.user = user; // Full user object
    req.userId = decoded.id;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    const msg = err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(401).json({ message: msg });
  }
};