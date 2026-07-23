"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationMemory = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const ConversationMemorySchema = new mongoose_1.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    summary: { type: String, default: '', trim: true },
    lastMessages: [
        {
            role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
            content: { type: String, required: true },
            timestamp: { type: Date, default: Date.now },
        },
    ],
}, {
    timestamps: { createdAt: false, updatedAt: true },
    collection: 'conversation_memory',
});
exports.ConversationMemory = db_1.aiDbConnection.model('ConversationMemory', ConversationMemorySchema);
exports.default = exports.ConversationMemory;
//# sourceMappingURL=ConversationMemory.js.map