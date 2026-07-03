import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IChatMessage {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  message: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  intent?: string;
  latencyMs?: number;
  retrievalLatencyMs?: number;
  openaiLatencyMs?: number;
  cacheHit?: boolean;
  createdAt?: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
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
  },
  {
    collection: 'chat_messages',
  }
);

export const ChatMessage = aiDbConnection.model<IChatMessage>('ChatMessage', ChatMessageSchema);
export default ChatMessage;
