import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IConversationMemory {
  sessionId: string;
  summary: string;
  lastMessages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: Date;
  }>;
  updatedAt: Date;
}

const ConversationMemorySchema = new Schema<IConversationMemory>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    summary: { type: String, default: '', trim: true },
    lastMessages: [
      {
        role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
        content: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    collection: 'conversation_memory',
  }
);

export const ConversationMemory = aiDbConnection.model<IConversationMemory>(
  'ConversationMemory',
  ConversationMemorySchema
);
export default ConversationMemory;
