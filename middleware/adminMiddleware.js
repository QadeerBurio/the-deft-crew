module.exports = (req, res, next) => {
  // We use req.userRole which was set in the auth middleware
  if (req.userRole !== require("../services/adminAccess").ADMIN_ROLE) { // the role gate; permissions: the route's map
    return res.status(403).json({ message: "Access denied. Admins only." });
  }
  next();
};