import { ChatMessage } from '../models/ChatMessage';
import { ChatSession } from '../models/ChatSession';
import { logger } from '../config/logger';

export class AnalyticsService {
  /**
   * Compiles daily and cumulative system performance statistics.
   */
  public async getAnalyticsSummary(): Promise<any> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 1. Daily Active Users (DAU) - active session count grouped by userId
      const activeUsersGroup = await ChatSession.aggregate([
        { $match: { updatedAt: { $gte: today } } },
        { $group: { _id: '$userId' } },
      ]);
      const dau = activeUsersGroup.length;

      // 2. Average latency and tokens (from ChatMessage collections)
      const messageStats = await ChatMessage.aggregate([
        {
          $group: {
            _id: null,
            totalMessages: { $sum: 1 },
            avgLatency: { $avg: '$latencyMs' },
            avgRetrieval: { $avg: '$retrievalLatencyMs' },
            avgOpenAI: { $avg: '$openaiLatencyMs' },
            avgTokens: { $avg: '$totalTokens' },
            cacheHits: {
              $sum: { $cond: [{ $eq: ['$cacheHit', true] }, 1, 0] },
            },
          },
        },
      ]);

      const stats = messageStats[0] || {
        totalMessages: 0,
        avgLatency: 0,
        avgRetrieval: 0,
        avgOpenAI: 0,
        avgTokens: 0,
        cacheHits: 0,
      };

      // 3. Messages per User (approximation)
      const distinctUsers = await ChatSession.distinct('userId');
      const messagesPerUser =
        distinctUsers.length > 0 ? stats.totalMessages / distinctUsers.length : 0;

      // 4. Cache hit rate percentage
      const cacheHitRate =
        stats.totalMessages > 0 ? (stats.cacheHits / stats.totalMessages) * 100 : 0;

      // 5. Top Asked Intents / Categories
      const topIntents = await ChatMessage.aggregate([
        { $match: { intent: { $exists: true, $ne: null } } },
        { $group: { _id: '$intent', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]);

      const categoryDistribution: Record<string, number> = {};
      for (const item of topIntents) {
        if (item._id) {
          categoryDistribution[item._id] = item.count;
        }
      }

      return {
        dailyActiveUsers: dau,
        totalMessages: stats.totalMessages,
        messagesPerUser: parseFloat(messagesPerUser.toFixed(2)),
        averageResponseTimeMs: parseFloat(stats.avgLatency.toFixed(2)),
        averageRetrievalTimeMs: parseFloat(stats.avgRetrieval.toFixed(2)),
        averageOpenAiLatencyMs: parseFloat(stats.avgOpenAI.toFixed(2)),
        averageTokens: parseFloat(stats.avgTokens.toFixed(2)),
        cacheHitRatePercentage: parseFloat(cacheHitRate.toFixed(2)),
        topAskedCategories: categoryDistribution,
        mostUsedFeatures: {
          chatSessionSearch: 1,
          sseStreaming: 1,
          toolCallingSearch: 1,
        },
      };
    } catch (err: any) {
      logger.error('Failed to compile analytics summary:', err.message);
      return {
        dailyActiveUsers: 0,
        totalMessages: 0,
        messagesPerUser: 0,
        averageResponseTimeMs: 0,
        averageRetrievalTimeMs: 0,
        averageOpenAiLatencyMs: 0,
        averageTokens: 0,
        cacheHitRatePercentage: 0,
        topAskedCategories: {},
      };
    }
  }
}

export const analyticsService = new AnalyticsService();
export default analyticsService;
