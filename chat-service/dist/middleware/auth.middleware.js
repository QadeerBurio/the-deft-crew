"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongoose_1 = __importDefault(require("mongoose"));
const envValidator_1 = require("../config/envValidator");
const db_1 = require("../config/db");
const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        // 1. Guest access without token
        if (!authHeader) {
            req.user = {
                id: 'guest-user',
                role: 'guest',
                email: 'guest@example.com',
                name: 'Guest Student',
                isGuest: true,
            };
            return next();
        }
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            res.status(401).json({ success: false, message: 'Invalid token format' });
            return;
        }
        const token = parts[1];
        if (!token || token === 'undefined' || token === 'null') {
            res.status(401).json({ success: false, message: 'Token is missing or null' });
            return;
        }
        // 2. Handle guest token
        if (token === 'guest-token-2024') {
            req.user = {
                id: 'guest-user',
                role: 'guest',
                email: 'guest@example.com',
                name: 'Guest Student',
                isGuest: true,
            };
            return next();
        }
        // 3. Verify real JWT
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(token, envValidator_1.env.JWT_SECRET);
        }
        catch (jwtErr) {
            res.status(401).json({ success: false, message: 'Invalid or expired token' });
            return;
        }
        if (!decoded || !decoded.id) {
            res.status(401).json({ success: false, message: 'Invalid token payload' });
            return;
        }
        // 4. Fetch user details from shared backend connection
        const db = db_1.backendDbConnection.db;
        if (!db) {
            res.status(503).json({ success: false, message: 'Database connection in initialization. Please retry.' });
            return;
        }
        const userDoc = await db.collection('users').findOne({
            _id: new mongoose_1.default.Types.ObjectId(decoded.id),
        });
        if (!userDoc) {
            res.status(401).json({ success: false, message: 'User not found in production database' });
            return;
        }
        // Attach profile details for personalized prompts
        req.user = {
            id: decoded.id,
            role: decoded.role || userDoc.role || 'student',
            email: userDoc.email || '',
            name: userDoc.name || 'Student',
            isGuest: false,
            university: userDoc.university ? userDoc.university.toString() : undefined,
        };
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.authMiddleware = authMiddleware;
exports.default = exports.authMiddleware;
//# sourceMappingURL=auth.middleware.js.map