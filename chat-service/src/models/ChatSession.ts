import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IChatSession {
  sessionId: string;
  userId: string;
  title: string;
  status: 'active' | 'archived';
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ChatSessionSchema = new Schema<IChatSession>(
  {
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
  },
  {
    timestamps: true,
    collection: 'chat_sessions',
  }
);

export const ChatSession = aiDbConnection.model<IChatSession>('ChatSession', ChatSessionSchema);
export default ChatSession;
