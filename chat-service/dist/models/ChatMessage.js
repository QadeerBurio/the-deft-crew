"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatMessage = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const ChatMessageSchema = new mongoose_1.Schema({
    sessionId: { type: String, required: true, index: true },
    role: {
        type: String,
        enum: ['user', 'assistant', 'system'],
        required: true,
    },
    message: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    model: { type: String, trim: true },
    intent: { type: String, trim: true, index: true },
    latencyMs: { type: Number, default: 0 },
    retrievalLatencyMs: { type: Number, default: 0 },
    openaiLatencyMs: { type: Number, default: 0 },
    cacheHit: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
}, {
    collection: 'chat_messages',
});
exports.ChatMessage = db_1.aiDbConnection.model('ChatMessage', ChatMessageSchema);
exports.default = exports.ChatMessage;
//# sourceMappingURL=ChatMessage.js.map