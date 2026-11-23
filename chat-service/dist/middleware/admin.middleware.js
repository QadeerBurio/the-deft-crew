"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminMiddleware = void 0;
const adminMiddleware = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
        return;
    }
    // Phase A: the assistant's knowledge base and sync need features.manage (main server: services/adminAccess.js)
    const access = require('../../../services/adminAccess');
    const d = access.decide({ _id: req.user.id, role: req.user.dbRole || req.user.role, adminAccess: req.user.adminAccess }, 'features.manage', `${req.method} /api/v1${req.baseUrl || ''}${req.path || ''}`);
    if (!d.allowed) {
        res.status(403).json({ success: false, code: 'ADMIN_PERMISSION_REQUIRED', permission: 'features.manage', message: "you don't have access to this. ask a super admin." });
        return;
    }
    next();
};
exports.adminMiddleware = adminMiddleware;
exports.default = exports.adminMiddleware;
//# sourceMappingURL=admin.middleware.js.map