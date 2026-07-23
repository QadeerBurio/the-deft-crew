"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatSession = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const ChatSessionSchema = new mongoose_1.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, default: 'guest-user', index: true },
    title: { type: String, default: 'New Conversation', trim: true },
    status: {
        type: String,
        enum: ['active', 'archived'],
        default: 'active',
        index: true,
    },
    pinned: { type: Boolean, default: false, index: true },
}, {
    timestamps: true,
    collection: 'chat_sessions',
});
exports.ChatSession = db_1.aiDbConnection.model('ChatSession', ChatSessionSchema);
exports.default = exports.ChatSession;
//# sourceMappingURL=ChatSession.js.map