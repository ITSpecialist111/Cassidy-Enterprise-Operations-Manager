// ---------------------------------------------------------------------------
// Conversation Analytics — in-memory metrics for ops visibility
// ---------------------------------------------------------------------------
// Tracks conversation stats, tool usage, response times. Exposed via
// /api/analytics endpoint without needing App Insights queries.
// ---------------------------------------------------------------------------

export interface ConversationMetric {
  timestamp: number;
  userId: string;
  conversationId: string;
  durationMs: number;
  toolsUsed: string[];
  tokensEstimate: number;
  wasRateLimited: boolean;
  wasDegraded: boolean;
}

const MAX_METRICS = 1000;
const metrics: ConversationMetric[] = [];
const toolUsageCounts = new Map<string, number>();

export function recordConversationMetric(metric: ConversationMetric): void {
  metrics.push(metric);
  if (metrics.length > MAX_METRICS) {
    metrics.splice(0, metrics.length - MAX_METRICS);
  }
  for (const tool of metric.toolsUsed) {
    toolUsageCounts.set(tool, (toolUsageCounts.get(tool) ?? 0) + 1);
  }
}

export interface AnalyticsSnapshot {
  totalConversations: number;
  timeWindowMs: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  topTools: Array<{ tool: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  rateLimitedCount: number;
  degradedCount: number;
  conversationsPerHour: number;
}

export function getAnalytics(windowMs = 3_600_000): AnalyticsSnapshot {
  const cutoff = Date.now() - windowMs;
  const recent = metrics.filter(m => m.timestamp > cutoff);

  // Average and P95 response times
  const durations = recent.map(m => m.durationMs).sort((a, b) => a - b);
  const avgResponseMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;
  const p95ResponseMs = durations.length > 0
    ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]
    : 0;

  // Top tools (from window)
  const windowToolCounts = new Map<string, number>();
  for (const m of recent) {
    for (const tool of m.toolsUsed) {
      windowToolCounts.set(tool, (windowToolCounts.get(tool) ?? 0) + 1);
    }
  }
  const topTools = [...windowToolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => ({ tool, count }));

  // Top users
  const userCounts = new Map<string, number>();
  for (const m of recent) {
    userCounts.set(m.userId, (userCounts.get(m.userId) ?? 0) + 1);
  }
  const topUsers = [...userCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([userId, count]) => ({ userId, count }));

  const rateLimitedCount = recent.filter(m => m.wasRateLimited).length;
  const degradedCount = recent.filter(m => m.wasDegraded).length;
  const hoursInWindow = windowMs / 3_600_000;
  const conversationsPerHour = hoursInWindow > 0
    ? Math.round((recent.length / hoursInWindow) * 10) / 10
    : 0;

  return {
    totalConversations: recent.length,
    timeWindowMs: windowMs,
    avgResponseMs,
    p95ResponseMs,
    topTools,
    topUsers,
    rateLimitedCount,
    degradedCount,
    conversationsPerHour,
  };
}

/** Get all-time tool usage counts */
export function getAllTimeToolUsage(): Array<{ tool: string; count: number }> {
  return [...toolUsageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => ({ tool, count }));
}

/** Reset all metrics (for testing) */
export function resetAnalytics(): void {
  metrics.length = 0;
  toolUsageCounts.clear();
}
