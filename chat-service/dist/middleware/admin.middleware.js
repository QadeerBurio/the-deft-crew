"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminMiddleware = void 0;
const adminMiddleware = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
        return;
    }
    next();
};
exports.adminMiddleware = adminMiddleware;
exports.default = exports.adminMiddleware;
//# sourceMappingURL=admin.middleware.js.map