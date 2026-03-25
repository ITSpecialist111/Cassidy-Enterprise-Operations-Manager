// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Predictive Engine — analyses operational trends and predicts future issues
// BEFORE they become problems. Uses historical data + GPT-5 reasoning to
// forecast task delays, capacity crunches, and approval bottlenecks.
// ---------------------------------------------------------------------------

import { getSharedOpenAI } from '../auth';
import { upsertEntity, getEntity, listEntities } from '../memory/tableStorage';
import { getOverdueTasks, getTeamWorkload, getPendingApprovals } from '../tools/operationsTools';

const TABLE = 'CassidyPredictions';
const PARTITION = 'predictions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Prediction {
  partitionKey: string;
  rowKey: string;            // prediction ID (timestamp-based)
  type: string;              // 'task_delay' | 'capacity_crunch' | 'approval_bottleneck' | 'trend_shift'
  severity: string;          // 'info' | 'warning' | 'critical'
  title: string;
  description: string;
  affectedUsers: string;     // JSON array of user IDs
  affectedProjects: string;  // JSON array of project names
  confidence: number;        // 0-100
  predictedDate: string;     // ISO — when the predicted event will occur
  recommendation: string;    // What Cassidy recommends doing about it
  status: string;            // 'active' | 'acknowledged' | 'resolved' | 'expired'
  createdAt: string;
  resolvedAt: string;
  [key: string]: unknown;
}

export interface TrendData {
  overdueTasksTrend: number[];      // Daily counts over past 7 days
  approvalBacklogTrend: number[];   // Daily pending approval counts
  workloadDistribution: Array<{ member: string; tasks: number; capacity: string }>;
  riskScore: number;                // 0-100 overall operational risk
}

// ---------------------------------------------------------------------------
// Run prediction cycle — called periodically by proactive engine
// ---------------------------------------------------------------------------

export async function runPredictionCycle(): Promise<Prediction[]> {
  const newPredictions: Prediction[] = [];

  try {
    // Gather current operational state
    const overdue = getOverdueTasks({ include_at_risk: true });
    const workload = getTeamWorkload({});
    const approvals = getPendingApprovals({ older_than_days: 1 });

    // Compute trend indicators
    const trendData = await computeTrends();

    // Use GPT-5 to generate predictions
    const predictions = await generatePredictions(overdue, workload, approvals, trendData);

    for (const pred of predictions) {
      const prediction: Prediction = {
        partitionKey: PARTITION,
        rowKey: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: pred.type,
        severity: pred.severity,
        title: pred.title,
        description: pred.description,
        affectedUsers: JSON.stringify(pred.affectedUsers ?? []),
        affectedProjects: JSON.stringify(pred.affectedProjects ?? []),
        confidence: pred.confidence,
        predictedDate: pred.predictedDate ?? '',
        recommendation: pred.recommendation,
        status: 'active',
        createdAt: new Date().toISOString(),
        resolvedAt: '',
      };

      await upsertEntity(TABLE, prediction);
      newPredictions.push(prediction);
    }

    // Expire old predictions (>7 days old)
    await expireOldPredictions();

    if (newPredictions.length > 0) {
      console.log(`[PredictiveEngine] Generated ${newPredictions.length} new prediction(s)`);
    }
  } catch (err) {
    console.error('[PredictiveEngine] Prediction cycle error:', err);
  }

  return newPredictions;
}

// ---------------------------------------------------------------------------
// GPT-5 prediction generation
// ---------------------------------------------------------------------------

async function generatePredictions(
  overdue: ReturnType<typeof getOverdueTasks>,
  workload: ReturnType<typeof getTeamWorkload>,
  approvals: ReturnType<typeof getPendingApprovals>,
  trends: TrendData,
): Promise<Array<{
  type: string;
  severity: string;
  title: string;
  description: string;
  affectedUsers?: string[];
  affectedProjects?: string[];
  confidence: number;
  predictedDate?: string;
  recommendation: string;
}>> {
  const openai = getSharedOpenAI();

  const operationalSnapshot = {
    overdueCount: overdue.total,
    criticalOverdue: overdue.criticalCount,
    topOverdue: overdue.tasks.slice(0, 5).map(t => ({
      title: t.title,
      owner: t.owner,
      daysOverdue: t.daysOverdue,
      project: t.project,
    })),
    teamWorkload: workload.members?.map((m: { name: string; activeTasks: number; capacity: string }) => ({
      name: m.name,
      tasks: m.activeTasks,
      capacity: m.capacity,
    })) ?? [],
    pendingApprovals: approvals.overdueCount,
    highUrgencyApprovals: approvals.highUrgencyCount,
    riskScore: trends.riskScore,
    overdueTasksTrend: trends.overdueTasksTrend,
    approvalBacklogTrend: trends.approvalBacklogTrend,
  };

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `You are a predictive analytics engine for an enterprise operations team.
Based on current operational data and trends, identify potential FUTURE problems.

Types of predictions you should make:
- task_delay: A task or project is likely to miss its deadline
- capacity_crunch: A team member or team will be overloaded in the coming days
- approval_bottleneck: Approval queue is growing and will cause downstream delays
- trend_shift: A significant change in operational patterns (positive or negative)

For each prediction, assess:
- Severity: info (FYI), warning (needs attention soon), critical (act now)
- Confidence: 0-100 based on strength of evidence
- Recommendation: specific action to prevent the predicted problem

Only generate predictions you have reasonable confidence in (>40%).
If the operational state looks healthy, return an empty array.

Respond as a JSON array of prediction objects.`,
        },
        {
          role: 'user',
          content: `Current operational snapshot:\n${JSON.stringify(operationalSnapshot, null, 2)}\n\nToday: ${new Date().toISOString().slice(0, 10)}`,
        },
      ],
      max_completion_tokens: 800,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    const result = JSON.parse(content);
    return Array.isArray(result) ? result : (result.predictions ?? []);
  } catch (err) {
    console.error('[PredictiveEngine] GPT-5 prediction error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trend computation
// ---------------------------------------------------------------------------

async function computeTrends(): Promise<TrendData> {
  // In a full implementation, we'd pull from historical data stored in
  // Table Storage. For now, compute from current operational state.
  const overdue = getOverdueTasks({ include_at_risk: true });
  const workload = getTeamWorkload({});

  // Risk score: weighted combination of operational health indicators
  const overdueWeight = Math.min(overdue.total * 10, 40);
  const criticalWeight = overdue.criticalCount * 15;
  const capacityWeight = (workload.members ?? [])
    .filter((m: { capacity: string }) => m.capacity === 'overloaded')
    .length * 10;

  const riskScore = Math.min(overdueWeight + criticalWeight + capacityWeight, 100);

  return {
    overdueTasksTrend: [overdue.total], // Single point — would be 7 days in production
    approvalBacklogTrend: [getPendingApprovals({ older_than_days: 1 }).overdueCount],
    workloadDistribution: (workload.members ?? []).map((m: { name: string; activeTasks: number; capacity: string }) => ({
      member: m.name,
      tasks: m.activeTasks,
      capacity: m.capacity,
    })),
    riskScore,
  };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getActivePredictions(): Promise<Prediction[]> {
  const all = await listEntities<Prediction>(TABLE, PARTITION);
  return all.filter(p => p.status === 'active');
}

export async function acknowledgePrediction(predictionId: string): Promise<{ success: boolean }> {
  const pred = await getEntity<Prediction>(TABLE, PARTITION, predictionId);
  if (!pred) return { success: false };
  await upsertEntity(TABLE, { ...pred, status: 'acknowledged' });
  return { success: true };
}

export async function resolvePrediction(predictionId: string): Promise<{ success: boolean }> {
  const pred = await getEntity<Prediction>(TABLE, PARTITION, predictionId);
  if (!pred) return { success: false };
  await upsertEntity(TABLE, { ...pred, status: 'resolved', resolvedAt: new Date().toISOString() });
  return { success: true };
}

export async function getOperationalRiskScore(): Promise<{
  score: number;
  level: 'green' | 'yellow' | 'orange' | 'red';
  factors: string[];
}> {
  const trends = await computeTrends();
  const activePredictions = await getActivePredictions();

  const factors: string[] = [];
  if (trends.riskScore > 60) factors.push('High overdue task count');
  if (trends.workloadDistribution.some(m => m.capacity === 'overloaded'))
    factors.push('Team members at capacity');
  if (activePredictions.some(p => p.severity === 'critical'))
    factors.push('Critical predictions active');

  const level = trends.riskScore < 25 ? 'green'
    : trends.riskScore < 50 ? 'yellow'
    : trends.riskScore < 75 ? 'orange' : 'red';

  return { score: trends.riskScore, level, factors };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

async function expireOldPredictions(): Promise<void> {
  const all = await listEntities<Prediction>(TABLE, PARTITION);
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  for (const pred of all) {
    if (pred.status === 'active' && new Date(pred.createdAt).getTime() < sevenDaysAgo) {
      await upsertEntity(TABLE, { ...pred, status: 'expired' });
    }
  }
}
