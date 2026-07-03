import mongoose from 'mongoose';
import { env } from './envValidator';
import { logger } from './logger';

export const aiDbConnection = mongoose.createConnection(env.MONGO_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/The_deft_crew_Ai_assistant', {
  dbName: 'The_deft_crew_Ai_assistant',
});

export let backendDbConnection: mongoose.Connection;

export const connectDB = async (): Promise<void> => {
  try {
    backendDbConnection = mongoose.connection;
    await aiDbConnection.asPromise();
    logger.info('✅ Chat Service connected successfully to dedicated AI database.');
  } catch (error) {
    logger.error('❌ Failed to establish connection to database: ', error);
    throw error;
  }
};

export default connectDB;
