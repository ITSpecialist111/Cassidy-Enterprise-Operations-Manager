// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// User Profiler — learns behavioural patterns from interactions to make
// Cassidy contextually aware of each user's work style, preferences,
// peak hours, common requests, and communication patterns.
// ---------------------------------------------------------------------------

import { AzureOpenAI } from 'openai';
import { cognitiveServicesTokenProvider } from '../auth';
import { upsertEntity, getEntity, listEntities } from '../memory/tableStorage';

const TABLE = 'CassidyUserInsights';
const PARTITION = 'insights';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserInsight {
  partitionKey: string;
  rowKey: string;              // userId
  displayName: string;
  communicationStyle: string;  // 'brief' | 'detailed' | 'action-oriented' | 'analytical'
  peakHours: string;           // JSON array of hours (0-23) when user is most active
  commonTopics: string;        // JSON array of frequently discussed topics
  preferredTools: string;      // JSON array of tools they trigger most often
  averageResponseTime: number; // minutes — how quickly they respond to Cassidy
  interactionPatterns: string; // JSON — day-of-week distribution, request types
  sentimentTrend: string;      // 'positive' | 'neutral' | 'declining' — recent interaction tone
  lastAnalysed: string;        // ISO timestamp of last profile analysis
  rawInteractionLog: string;   // JSON array of recent interaction summaries (rolling window)
  [key: string]: unknown;
}

export interface InteractionSummary {
  timestamp: string;
  topic: string;
  toolsUsed: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  responseLength: 'brief' | 'detailed';
  dayOfWeek: number;
  hourOfDay: number;
}

// ---------------------------------------------------------------------------
// Record an interaction for profiling
// ---------------------------------------------------------------------------

export async function recordInteraction(
  userId: string,
  displayName: string,
  interaction: InteractionSummary,
): Promise<void> {
  const existing = await getEntity<UserInsight>(TABLE, PARTITION, sanitiseKey(userId));
  const rollingWindow = 100; // Keep last 100 interactions for analysis

  let interactions: InteractionSummary[];
  if (existing?.rawInteractionLog) {
    try {
      interactions = JSON.parse(existing.rawInteractionLog) as InteractionSummary[];
    } catch {
      interactions = [];
    }
  } else {
    interactions = [];
  }

  interactions.push(interaction);
  if (interactions.length > rollingWindow) {
    interactions = interactions.slice(-rollingWindow);
  }

  // Quick stats update (no GPT-5 call — fast path)
  const peakHours = computePeakHours(interactions);
  const commonTopics = computeCommonTopics(interactions);
  const preferredTools = computePreferredTools(interactions);
  const sentimentTrend = computeSentimentTrend(interactions);

  const insight: UserInsight = {
    partitionKey: PARTITION,
    rowKey: sanitiseKey(userId),
    displayName,
    communicationStyle: existing?.communicationStyle ?? 'action-oriented',
    peakHours: JSON.stringify(peakHours),
    commonTopics: JSON.stringify(commonTopics),
    preferredTools: JSON.stringify(preferredTools),
    averageResponseTime: existing?.averageResponseTime ?? 0,
    interactionPatterns: JSON.stringify(computeDayDistribution(interactions)),
    sentimentTrend,
    lastAnalysed: existing?.lastAnalysed ?? new Date().toISOString(),
    rawInteractionLog: JSON.stringify(interactions),
  };

  await upsertEntity(TABLE, insight);
}

// ---------------------------------------------------------------------------
// Deep analysis — runs periodically with GPT-5 to extract nuanced insights
// ---------------------------------------------------------------------------

export async function analyseUserProfile(userId: string): Promise<{
  communicationStyle: string;
  recommendations: string[];
  riskFactors: string[];
} | null> {
  const insight = await getEntity<UserInsight>(TABLE, PARTITION, sanitiseKey(userId));
  if (!insight) return null;

  let interactions: InteractionSummary[];
  try {
    interactions = JSON.parse(insight.rawInteractionLog) as InteractionSummary[];
  } catch {
    return null;
  }

  if (interactions.length < 5) return null; // Need minimum data

  const openai = new AzureOpenAI({
    azureADTokenProvider: cognitiveServicesTokenProvider,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2025-04-01-preview',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
  });

  const interactionSummary = interactions.slice(-20).map(i =>
    `[${i.timestamp}] Topic: ${i.topic}, Tools: ${i.toolsUsed.join(',')||'none'}, Sentiment: ${i.sentiment}, Length: ${i.responseLength}`
  ).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `You are analysing a user's interaction patterns with an AI Operations Manager called Cassidy.
Based on the interaction history, determine:
1. Communication style preference (brief, detailed, action-oriented, or analytical)
2. Recommendations for how Cassidy should adjust its behaviour for this user
3. Risk factors (e.g. declining engagement, increasing negative sentiment, signs of burnout)

Respond in JSON format:
{
  "communicationStyle": "brief|detailed|action-oriented|analytical",
  "recommendations": ["recommendation 1", "recommendation 2"],
  "riskFactors": ["risk 1"] // empty array if none
}`,
        },
        {
          role: 'user',
          content: `User: ${insight.displayName}\nPeak hours: ${insight.peakHours}\nCommon topics: ${insight.commonTopics}\nSentiment trend: ${insight.sentimentTrend}\n\nRecent interactions:\n${interactionSummary}`,
        },
      ],
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const analysis = JSON.parse(content) as {
      communicationStyle: string;
      recommendations: string[];
      riskFactors: string[];
    };

    // Persist the updated style
    await upsertEntity(TABLE, {
      ...insight,
      communicationStyle: analysis.communicationStyle,
      lastAnalysed: new Date().toISOString(),
    });

    return analysis;
  } catch (err) {
    console.error('[UserProfiler] Analysis error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Get user insight for the agent to personalise responses
// ---------------------------------------------------------------------------

export async function getUserInsight(userId: string): Promise<{
  communicationStyle: string;
  peakHours: number[];
  commonTopics: string[];
  sentimentTrend: string;
  isInPeakHours: boolean;
} | null> {
  const insight = await getEntity<UserInsight>(TABLE, PARTITION, sanitiseKey(userId));
  if (!insight) return null;

  const peakHours = safeParse<number[]>(insight.peakHours, []);
  const currentHour = new Date().getHours();

  return {
    communicationStyle: insight.communicationStyle,
    peakHours,
    commonTopics: safeParse<string[]>(insight.commonTopics, []),
    sentimentTrend: insight.sentimentTrend,
    isInPeakHours: peakHours.includes(currentHour),
  };
}

// ---------------------------------------------------------------------------
// Get all user insights (for org-level analysis)
// ---------------------------------------------------------------------------

export async function getAllInsights(): Promise<UserInsight[]> {
  return listEntities<UserInsight>(TABLE, PARTITION);
}

// ---------------------------------------------------------------------------
// Statistical helpers (no GPT-5 — pure computation)
// ---------------------------------------------------------------------------

function computePeakHours(interactions: InteractionSummary[]): number[] {
  const hourCounts = new Map<number, number>();
  for (const i of interactions) {
    hourCounts.set(i.hourOfDay, (hourCounts.get(i.hourOfDay) ?? 0) + 1);
  }
  // Return top 4 most active hours
  return [...hourCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([hour]) => hour);
}

function computeCommonTopics(interactions: InteractionSummary[]): string[] {
  const topicCounts = new Map<string, number>();
  for (const i of interactions) {
    if (i.topic) {
      topicCounts.set(i.topic, (topicCounts.get(i.topic) ?? 0) + 1);
    }
  }
  return [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);
}

function computePreferredTools(interactions: InteractionSummary[]): string[] {
  const toolCounts = new Map<string, number>();
  for (const i of interactions) {
    for (const tool of i.toolsUsed) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
  }
  return [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool]) => tool);
}

function computeSentimentTrend(interactions: InteractionSummary[]): string {
  const recent = interactions.slice(-10);
  const sentimentScore = recent.reduce((sum, i) => {
    if (i.sentiment === 'positive') return sum + 1;
    if (i.sentiment === 'negative') return sum - 1;
    return sum;
  }, 0);
  if (sentimentScore >= 3) return 'positive';
  if (sentimentScore <= -3) return 'declining';
  return 'neutral';
}

function computeDayDistribution(interactions: InteractionSummary[]): Record<number, number> {
  const dist: Record<number, number> = {};
  for (const i of interactions) {
    dist[i.dayOfWeek] = (dist[i.dayOfWeek] ?? 0) + 1;
  }
  return dist;
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function sanitiseKey(key: string): string {
  return key.replace(/[/\\#?]/g, '_').slice(0, 200);
}
