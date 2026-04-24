// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
import { configDotenv } from 'dotenv';
configDotenv();

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request
} from '@microsoft/agents-hosting';
import express, { Response } from 'express';
import { agentApplication, credential, runAutonomousStandup, userInsightCache, memoryCache, getToolCacheSize } from './agent';
import { setAdapter } from './scheduler/proactiveNotifier';
import { initAutonomousLoop, stopAutonomousLoop } from './autonomous/autonomousLoop';
import { initProactiveEngine, stopProactiveEngine, triggerSpecific } from './proactive/proactiveEngine';
import { startCorpGenScheduler, stopCorpGenScheduler } from './corpgenScheduler';
import { getAllConversationRefs } from './proactive/userRegistry';
import { handleTranscriptWebhook, postToMeetingChat } from './meetings/meetingMonitor';
import { handleCallNotification, getActiveCall } from './voice/callManager';
import { startVoiceConversation, endVoiceConversation } from './voice/voiceAgent';
import { seedDefaultAgents } from './orchestrator/agentRegistry';
import { config, features, logFeatureStatus } from './featureConfig';
import { initTelemetry, flushTelemetry } from './telemetry';
import { timingSafeEqual } from 'crypto';
import { openAiCircuit, graphCircuit, mcpCircuit } from './retry';
import { logger } from './logger';
import { userRateLimiter } from './rateLimiter';
import { getAnalytics, getAllTimeToolUsage } from './analytics';
import { exportConversations } from './conversationExport';
import { getActiveSubscriptions, startAutoRenewal, stopAutoRenewal } from './webhookManager';
import { requireEasyAuth } from './easyAuth';
import { getRecentActivity } from './logger';
import { listAgents } from './orchestrator/agentRegistry';
import { getRecentEvents, getEventStats, type AgentEventKind } from './agentEvents';
import path from 'path';

// Initialise Application Insights early (before route handlers)
initTelemetry();

const startTime = Date.now();

/** Constant-time secret comparison — prevents timing side-channel attacks. */
function verifySecret(provided: unknown): boolean {
  const expected = process.env.SCHEDULED_SECRET;
  if (typeof provided !== 'string' || !expected) return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const isDevelopment = features.isDevelopment;
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();

logFeatureStatus();

const server = express();
server.use(express.json());

// Health endpoint (no auth required — needed for App Service warmup probe)
server.get('/api/health', (_req, res: Response) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeH = (uptimeMs / 3_600_000).toFixed(1);

  res.status(200).json({
    status: 'healthy',
    agent: 'Cassidy',
    version: '1.7.0',
    uptimeHours: Number(uptimeH),
    features: {
      mcp: features.mcpAvailable,
      speech: features.speechConfigured,
      openai: features.openAiConfigured,
      appIdentity: features.appIdentityConfigured,
      appInsights: features.appInsightsConfigured,
    },
    circuits: {
      openAi: openAiCircuit.getState(),
      graph: graphCircuit.getState(),
      mcp: mcpCircuit.getState(),
    },
    caches: {
      userInsights: userInsightCache.size,
      memories: memoryCache.size,
      toolResults: getToolCacheSize(),
    },
    rateLimiter: {
      trackedUsers: userRateLimiter.getTrackedUsers(),
    },
    webhooks: {
      activeSubscriptions: getActiveSubscriptions().length,
    },
    timestamp: new Date().toISOString(),
  });
});

// Scheduled standup endpoint — protected by SCHEDULED_SECRET, not JWT
server.post('/api/scheduled', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.body?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    logger.info('Autonomous standup triggered via /api/scheduled', { module: 'scheduler' });
    await runAutonomousStandup();
    res.status(200).json({ status: 'standup_complete', timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    logger.error('Autonomous standup error', { module: 'scheduler', error: String(err) });
    res.status(500).json({ error: 'Standup failed', timestamp: new Date().toISOString() });
  }
});

// Work queue status endpoint — protected by SCHEDULED_SECRET
server.get('/api/workqueue', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { getPendingItems } = await import('./workQueue/workQueue');
    const items = await getPendingItems();
    res.status(200).json({ count: items.length, items: items.map(i => ({
      id: i.rowKey, goal: i.goal, status: i.status,
      step: i.currentStep, retries: i.retryCount,
      subtasks: JSON.parse(i.subtasks),
      created: i.createdAt, updated: i.updatedAt,
      lastError: i.lastError,
    }))});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Proactive trigger endpoint — fire a specific trigger on demand (secret-protected)
server.post('/api/proactive-trigger', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.body?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const triggerType = req.body?.triggerType ?? 'morning_briefing';
  try {
    logger.info('Proactive trigger fired', { module: 'proactive', triggerType });
    const result = await triggerSpecific(triggerType);
    res.status(200).json({ status: 'triggered', triggerType, ...result, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    logger.error('Proactive trigger error', { module: 'proactive', error: String(err) });
    res.status(500).json({ error: 'Trigger failed', timestamp: new Date().toISOString() });
  }
});

// Meeting transcript webhook — called by Microsoft Graph when transcript segments arrive
server.post('/api/meeting-webhook', async (req: express.Request, res: Response) => {
  // Graph webhook validation — respond to validation token requests
  if (req.query.validationToken) {
    res.status(200).contentType('text/plain').send(req.query.validationToken as string);
    return;
  }

  // Validate clientState prefix to ensure notification came from our subscriptions
  const items = req.body?.value;
  if (Array.isArray(items) && items.length > 0) {
    const allValid = items.every(
      (item: { clientState?: string }) => item.clientState?.startsWith('cassidy_meeting_')
    );
    if (!allValid) {
      logger.warn('Invalid clientState on meeting webhook', { module: 'meetings' });
      res.status(403).json({ error: 'Invalid clientState' });
      return;
    }
  }

  try {
    const responses = await handleTranscriptWebhook(req.body);

    // Post any Cassidy responses to the meeting chat
    for (const r of responses) {
      await postToMeetingChat(r.chatId, r.message).catch(err =>
        logger.error('Failed to post to meeting chat', { module: 'meetings', chatId: r.chatId, error: String(err) })
      );
    }

    res.status(202).json({ processed: responses.length });
  } catch (err: unknown) {
    logger.error('Meeting webhook error', { module: 'meetings', error: String(err) });
    res.status(200).json({ status: 'error_logged' }); // Graph requires 2xx even on errors
  }
});

// Voice call notifications — called by Microsoft Graph Communications API
server.post('/api/calls/notifications', async (req: express.Request, res: Response) => {
  try {
    // Only process notifications for calls we initiated
    const items = req.body?.value;
    if (Array.isArray(items)) {
      const callIds = items
        .map((item: { resourceData?: { id?: string } }) => item.resourceData?.id)
        .filter((id): id is string => Boolean(id));
      if (callIds.length > 0 && !callIds.some(id => getActiveCall(id))) {
        res.status(200).json({ status: 'ignored_unknown_call' });
        return;
      }
    }

    const result = await handleCallNotification(req.body);

    if (result.action === 'play_prompt' && result.callId) {
      // Call just connected — start the voice conversation
      startVoiceConversation(result.callId).catch(err =>
        logger.error('Failed to start voice conversation', { module: 'voice', callId: result.callId, error: String(err) })
      );
    } else if (result.action === 'end' && result.callId) {
      endVoiceConversation(result.callId);
    }

    res.status(200).json({ status: 'processed' });
  } catch (err: unknown) {
    logger.error('Call notification error', { module: 'voice', error: String(err) });
    res.status(200).json({ status: 'error_logged' });
  }
});

// Conversation analytics endpoint — secret-protected
server.get('/api/analytics', (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const windowMs = Number(req.query?.windowMs) || 3_600_000;
  const analytics = getAnalytics(windowMs);
  const allTimeTools = getAllTimeToolUsage();
  res.status(200).json({ ...analytics, allTimeToolUsage: allTimeTools, timestamp: new Date().toISOString() });
});

// Conversation export / audit trail — secret-protected
server.get('/api/conversations/export', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const conversations = await exportConversations({
      fromDate: req.query?.fromDate as string | undefined,
      toDate: req.query?.toDate as string | undefined,
      redact: req.query?.redact === 'true',
      limit: Number(req.query?.limit) || 100,
    });
    res.status(200).json({ count: conversations.length, conversations, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    logger.error('Conversation export error', { module: 'export', error: String(err) });
    res.status(500).json({ error: 'Export failed' });
  }
});

// Webhook subscriptions management — secret-protected
server.get('/api/webhooks', (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const subs = getActiveSubscriptions();
  res.status(200).json({ count: subs.length, subscriptions: subs, timestamp: new Date().toISOString() });
});

// CorpGen autonomous workday — operator-only HTTP harness (secret-protected).
// Pass `async=true` to enqueue and poll via /api/corpgen/jobs/:id (recommended
// for runs >2 minutes — App Service Linux caps responses at ~230s).
server.post('/api/corpgen/run', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.body?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const opts = {
    employeeId: typeof req.body?.employeeId === 'string' ? req.body.employeeId : undefined,
    maxCycles: typeof req.body?.maxCycles === 'number' ? req.body.maxCycles : undefined,
    maxWallclockMs: typeof req.body?.maxWallclockMs === 'number' ? req.body.maxWallclockMs : undefined,
    maxToolCalls: typeof req.body?.maxToolCalls === 'number' ? req.body.maxToolCalls : undefined,
    phase: typeof req.body?.phase === 'string'
      ? req.body.phase as 'init' | 'cycle' | 'reflect' | 'monthly' | 'manual'
      : undefined,
    force: typeof req.body?.force === 'boolean' ? req.body.force : undefined,
  };
  if (req.body?.async === true) {
    const { startJob } = await import('./corpgenJobs');
    const job = startJob('workday', opts as Record<string, unknown>, async () => {
      const { runWorkdayForCassidy } = await import('./corpgenIntegration');
      return await runWorkdayForCassidy(opts) as unknown as Record<string, unknown>;
    });
    res.status(202).json({ ok: true, jobId: job.id, status: job.status, statusUrl: `/api/corpgen/jobs/${job.id}` });
    return;
  }
  try {
    const { runWorkdayForCassidy } = await import('./corpgenIntegration');
    const result = await runWorkdayForCassidy(opts);
    res.status(200).json({ ok: true, result, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    logger.error('CorpGen run failed', { module: 'corpgen', error: String(err) });
    res.status(500).json({ ok: false, error: String(err), timestamp: new Date().toISOString() });
  }
});

// CorpGen jobs status (operator-only, secret-protected). Mirrors the
// dashboard /api/dashboard/jobs endpoint but auth-by-secret instead of EasyAuth.
server.get('/api/corpgen/jobs', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { listJobs, summariseJob } = await import('./corpgenJobs');
  res.status(200).json({ jobs: listJobs().map(summariseJob) });
});

server.get('/api/corpgen/jobs/:id', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.query?.secret;
  if (!verifySecret(secret)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { getJob, summariseJob } = await import('./corpgenJobs');
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.status(200).json(summariseJob(job));
});

// CorpGen multi-day benchmark (operator-only). Synchronous by default; pass
// `async=true` to enqueue and return a job id (poll /api/corpgen/jobs/:id).
server.post('/api/corpgen/multi-day', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.body?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const days = typeof req.body?.days === 'number' ? req.body.days : 3;
  if (days < 1 || days > 30) {
    res.status(400).json({ error: 'days must be 1..30' });
    return;
  }
  const isAsync = req.body?.async === true;
  const buildOpts = (): {
    employeeId?: string; days: number; maxCycles: number; maxWallclockMs: number;
    maxToolCalls: number; dayStepMs?: number; delayBetweenDaysMs: number; startNow?: string;
  } => ({
    employeeId: typeof req.body?.employeeId === 'string' ? req.body.employeeId : undefined,
    days,
    maxCycles: typeof req.body?.maxCycles === 'number' ? req.body.maxCycles : 3,
    maxWallclockMs:
      typeof req.body?.maxWallclockMs === 'number' ? req.body.maxWallclockMs : 3 * 60_000,
    maxToolCalls: typeof req.body?.maxToolCalls === 'number' ? req.body.maxToolCalls : 60,
    dayStepMs: typeof req.body?.dayStepMs === 'number' ? req.body.dayStepMs : undefined,
    delayBetweenDaysMs:
      typeof req.body?.delayBetweenDaysMs === 'number' ? req.body.delayBetweenDaysMs : 0,
    startNow: typeof req.body?.startNow === 'string' ? req.body.startNow : undefined,
  });

  if (isAsync) {
    const { startJob } = await import('./corpgenJobs');
    const opts = buildOpts();
    const job = startJob('multi-day', opts as unknown as Record<string, unknown>, async (onProgress) => {
      const { runMultiDayForCassidy } = await import('./corpgenIntegration');
      onProgress({ current: 0, total: opts.days, note: 'starting' });
      const results = await runMultiDayForCassidy(opts);
      onProgress({ current: results.length, total: opts.days, note: 'done' });
      return results;
    });
    res.status(202).json({ ok: true, jobId: job.id, status: job.status, statusUrl: `/api/corpgen/jobs/${job.id}` });
    return;
  }

  try {
    const { runMultiDayForCassidy, summariseMultiDay } = await import('./corpgenIntegration');
    const results = await runMultiDayForCassidy(buildOpts());
    const avgCompletion =
      results.length > 0
        ? results.reduce((s, r) => s + r.completionRate, 0) / results.length
        : 0;
    res.status(200).json({
      ok: true,
      days: results.length,
      avgCompletionRate: avgCompletion,
      totalToolCalls: results.reduce((s, r) => s + r.toolCallsUsed, 0),
      results,
      summary: summariseMultiDay(results),
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logger.error('CorpGen multi-day failed', { module: 'corpgen', error: String(err) });
    res.status(500).json({ ok: false, error: String(err), timestamp: new Date().toISOString() });
  }
});

// CorpGen organization benchmark — multi-employee, multi-day (operator-only).
// Pass `async=true` to enqueue and poll via /api/corpgen/jobs/:id.
server.post('/api/corpgen/organization', async (req: express.Request, res: Response) => {
  const secret = req.headers['x-scheduled-secret'] || req.body?.secret;
  if (!verifySecret(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const days = typeof req.body?.days === 'number' ? req.body.days : 1;
  const members = Array.isArray(req.body?.members) ? req.body.members : null;
  if (!members || members.length === 0) {
    res.status(400).json({ error: 'members array required' });
    return;
  }
  if (members.length > 10 || days < 1 || days > 30) {
    res.status(400).json({ error: 'members must be 1..10, days must be 1..30' });
    return;
  }
  const isAsync = req.body?.async === true;
  const buildOpts = (): {
    members: unknown[]; days: number; concurrent: boolean; maxCycles: number;
    maxWallclockMs: number; maxToolCalls: number; dayStepMs?: number; startNow?: string;
  } => ({
    members,
    days,
    concurrent: req.body?.concurrent !== false,
    maxCycles: typeof req.body?.maxCycles === 'number' ? req.body.maxCycles : 2,
    maxWallclockMs:
      typeof req.body?.maxWallclockMs === 'number' ? req.body.maxWallclockMs : 2 * 60_000,
    maxToolCalls: typeof req.body?.maxToolCalls === 'number' ? req.body.maxToolCalls : 40,
    dayStepMs: typeof req.body?.dayStepMs === 'number' ? req.body.dayStepMs : undefined,
    startNow: typeof req.body?.startNow === 'string' ? req.body.startNow : undefined,
  });

  if (isAsync) {
    const { startJob } = await import('./corpgenJobs');
    const opts = buildOpts();
    const job = startJob('organization', opts as unknown as Record<string, unknown>, async (onProgress) => {
      const { runOrganizationForCassidy } = await import('./corpgenIntegration');
      onProgress({ current: 0, total: opts.members.length, note: 'starting' });
      const results = await runOrganizationForCassidy(opts as Parameters<typeof runOrganizationForCassidy>[0]);
      onProgress({ current: results.length, total: opts.members.length, note: 'done' });
      return results;
    });
    res.status(202).json({ ok: true, jobId: job.id, status: job.status, statusUrl: `/api/corpgen/jobs/${job.id}` });
    return;
  }

  try {
    const { runOrganizationForCassidy, summariseOrganization } = await import(
      './corpgenIntegration'
    );
    const results = await runOrganizationForCassidy(buildOpts() as Parameters<typeof runOrganizationForCassidy>[0]);
    res.status(200).json({
      ok: true,
      members: results.length,
      results,
      summary: summariseOrganization(results),
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    logger.error('CorpGen organization failed', { module: 'corpgen', error: String(err) });
    res.status(500).json({ ok: false, error: String(err), timestamp: new Date().toISOString() });
  }
});

// CorpGen async job status (operator-only) — (duplicate routes removed; canonical defs above)

// ---------------------------------------------------------------------------
// Mission Control dashboard — Easy Auth (Entra) protected JSON API
// ---------------------------------------------------------------------------

const dashApi = express.Router();
dashApi.use(requireEasyAuth);

dashApi.get('/me', (req, res: Response) => {
  const p = (req as express.Request & { easyAuthPrincipal?: { oid?: string; email?: string; name?: string; tenantId?: string } }).easyAuthPrincipal;
  res.status(200).json({ ok: true, principal: p });
});

dashApi.get('/snapshot', async (_req, res: Response) => {
  const uptimeMs = Date.now() - startTime;
  let agents: Array<{ id: string; name: string; description?: string; expertise?: string[] }> = [];
  try {
    const list = await listAgents();
    agents = list.map((a) => {
      let expertise: string[] = [];
      try { expertise = a.expertise ? JSON.parse(a.expertise) : []; } catch { /* ignore */ }
      return {
        id: String(a.rowKey),
        name: String(a.displayName),
        description: a.description,
        expertise,
      };
    });
  } catch {
    agents = [];
  }
  res.status(200).json({
    agent: 'Cassidy',
    version: '1.7.0',
    uptimeHours: Number((uptimeMs / 3_600_000).toFixed(2)),
    startTime: new Date(startTime).toISOString(),
    features: {
      mcp: features.mcpAvailable,
      speech: features.speechConfigured,
      openai: features.openAiConfigured,
      appIdentity: features.appIdentityConfigured,
      appInsights: features.appInsightsConfigured,
    },
    circuits: {
      openAi: openAiCircuit.getState(),
      graph: graphCircuit.getState(),
      mcp: mcpCircuit.getState(),
    },
    caches: {
      userInsights: userInsightCache.size,
      memories: memoryCache.size,
      toolResults: getToolCacheSize(),
    },
    rateLimiter: { trackedUsers: userRateLimiter.getTrackedUsers() },
    webhooks: { activeSubscriptions: getActiveSubscriptions().length },
    agents,
    timestamp: new Date().toISOString(),
  });
});

dashApi.get('/activity', (req, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const level = (req.query.level as 'debug' | 'info' | 'warn' | 'error' | undefined) || undefined;
  const moduleFilter = (req.query.module as string | undefined) || undefined;
  res.status(200).json({ entries: getRecentActivity({ limit, level, module: moduleFilter }) });
});

dashApi.get('/events', (req, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const sinceId = (req.query.sinceId as string | undefined) || undefined;
  const kindsParam = (req.query.kinds as string | undefined) || undefined;
  const kinds = kindsParam ? (kindsParam.split(',') as AgentEventKind[]) : undefined;
  res.status(200).json({
    events: getRecentEvents({ limit, sinceId, kinds }),
    stats: getEventStats(),
  });
});

dashApi.get('/jobs', async (_req, res: Response) => {
  const { listJobs, summariseJob } = await import('./corpgenJobs');
  res.status(200).json({ jobs: listJobs().map(summariseJob) });
});

dashApi.get('/jobs/:id', async (req, res: Response) => {
  const { getJob, summariseJob } = await import('./corpgenJobs');
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.status(200).json(summariseJob(job));
});

// Today's CorpGen DailyPlan for the default employee — feeds the Kanban board.
dashApi.get('/kanban', async (req, res: Response) => {
  try {
    const { defaultCassidyIdentity, loadDailyPlan } = await import('./corpgen');
    const identity = defaultCassidyIdentity();
    const employeeId = String(req.query.employeeId || identity.employeeId);
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const plan = await loadDailyPlan(employeeId, date);
    res.status(200).json({
      ok: true,
      employeeId,
      date,
      plan,
      columns: plan
        ? {
          pending:     plan.tasks.filter((t) => t.status === 'pending'),
          in_progress: plan.tasks.filter((t) => t.status === 'in_progress'),
          blocked:     plan.tasks.filter((t) => t.status === 'blocked'),
          done:        plan.tasks.filter((t) => t.status === 'done' || t.status === 'skipped' || t.status === 'failed'),
        }
        : null,
    });
  } catch (err) {
    logger.error('Kanban load failed', { module: 'dashboard.kanban', error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Codebase graph — Graphify-style starfield of Cassidy's own source tree.
// Files = nodes, imports = edges, top-level folder = community.
// Cached in-memory for 5 min; rebuild on demand via ?refresh=1.
// ---------------------------------------------------------------------------

interface CodeGraphNode {
  id: string;        // relative path
  label: string;     // basename
  community: string; // top-level folder
  size: number;      // file LOC (capped)
  degree?: number;
}
interface CodeGraphEdge { source: string; target: string; }
interface CodeGraphResponse {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  communities: Array<{ id: string; label: string; color: string; count: number }>;
  builtAt: string;
}

let _codegraphCache: { data: CodeGraphResponse; ts: number } | null = null;

const COMMUNITY_COLORS = [
  '#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff', '#e0af68', '#f7768e',
  '#c0caf5', '#ff9e64', '#73daca', '#f7768e', '#b4f9f8', '#ad8ee6',
  '#cfc9c2', '#449dab', '#9d7cd8', '#ff007c', '#41a6b5', '#ffb86c',
];

async function buildCodeGraph(): Promise<CodeGraphResponse> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Walk cassidy/src — works in dev (./src) and production (./dist already
  // strips imports; we look at the original .ts files alongside the dist).
  const candidates = [
    path.resolve(__dirname, '..', 'src'),  // dist/.. /src — production layout
    path.resolve(__dirname, 'src'),
    path.resolve(process.cwd(), 'src'),
    path.resolve(process.cwd(), 'cassidy', 'src'),
  ];
  let srcRoot: string | null = null;
  for (const c of candidates) {
    try { const s = await fs.stat(c); if (s.isDirectory()) { srcRoot = c; break; } } catch { /* skip */ }
  }
  if (!srcRoot) {
    return { nodes: [], edges: [], communities: [], builtAt: new Date().toISOString() };
  }

  // Recursive walk for .ts/.tsx files (skip .test.ts and node_modules)
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        files.push(full);
      }
    }
  }
  await walk(srcRoot);

  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  const nodeIds = new Set<string>();
  const importRegex = /(?:^|\n)\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;

  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).replace(/\\/g, '/');
    const community = rel.includes('/') ? rel.split('/')[0] : 'core';
    const isTest = /\.test\.tsx?$/.test(rel);
    if (isTest) continue;

    let content = '';
    try { content = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const loc = content.split('\n').length;

    nodes.push({
      id: rel,
      label: path.basename(rel, path.extname(rel)),
      community,
      size: Math.min(loc, 1500),
    });
    nodeIds.add(rel);

    // Collect imports
    let m: RegExpExecArray | null;
    importRegex.lastIndex = 0;
    while ((m = importRegex.exec(content)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // only relative imports
      const resolved = path.posix.normalize(path.posix.join(path.dirname(rel), spec));
      // Try common extensions
      const candidates = [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}/index.ts`,
        `${resolved}/index.tsx`,
      ];
      const target = candidates.find((c) => nodeIds.has(c)) || candidates.find(() => false);
      if (target && target !== rel) {
        edges.push({ source: rel, target });
      }
    }
  }

  // Resolve edges that reference files added later (second pass)
  const resolvedEdges: CodeGraphEdge[] = [];
  for (const e of edges) {
    if (nodeIds.has(e.target)) {
      resolvedEdges.push(e);
    } else {
      // try variants
      for (const v of [e.target, `${e.target}.ts`, `${e.target}.tsx`, `${e.target}/index.ts`]) {
        if (nodeIds.has(v)) { resolvedEdges.push({ source: e.source, target: v }); break; }
      }
    }
  }

  // Compute degree
  const degree = new Map<string, number>();
  for (const e of resolvedEdges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  // Build community list with colors
  const commCounts = new Map<string, number>();
  nodes.forEach((n) => commCounts.set(n.community, (commCounts.get(n.community) || 0) + 1));
  const communities = [...commCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count], i) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' '),
      color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
      count,
    }));

  return {
    nodes,
    edges: resolvedEdges,
    communities,
    builtAt: new Date().toISOString(),
  };
}

dashApi.get('/codegraph', async (req, res: Response) => {
  try {
    const refresh = req.query.refresh === '1';
    const now = Date.now();
    if (!refresh && _codegraphCache && now - _codegraphCache.ts < 5 * 60_000) {
      res.status(200).json(_codegraphCache.data);
      return;
    }
    const data = await buildCodeGraph();
    _codegraphCache = { data, ts: now };
    res.status(200).json(data);
  } catch (err) {
    logger.error('CodeGraph build failed', { module: 'dashboard.codegraph', error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Mindmap — 3D Neural Core graph (agent cognition visualization)
// ---------------------------------------------------------------------------
dashApi.get('/mindmap', async (_req, res: Response) => {
  try {
    const events = getRecentEvents({ limit: 500 });
    const stats  = getEventStats();

    // Build graph from live event data + registered agents + plan
    const nodes: Array<{
      id: string; label: string; type: string; group: string;
      importance: number; detail?: string; ts?: string; status?: string;
    }> = [];
    const links: Array<{
      source: string; target: string; type: string;
      strength: number; label?: string;
    }> = [];
    const seen = new Set<string>();

    const addNode = (n: typeof nodes[0]) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      nodes.push(n);
    };

    // 1. Central Cassidy core node
    addNode({ id: 'cassidy-core', label: 'Cassidy', type: 'core', group: 'core', importance: 10, detail: 'Autonomous AI Digital Employee — Neural Core' });

    // 2. Cognitive process hubs (always present)
    const hubs = [
      { id: 'hub-memory',    label: 'Memory',     type: 'memory',     group: 'memory',    importance: 8, detail: 'Long-term + semantic + working memory' },
      { id: 'hub-reasoning', label: 'Reasoning',   type: 'thought',    group: 'thought',   importance: 8, detail: 'ReAct thought chain — observation/action/reflection' },
      { id: 'hub-tools',     label: 'Tool Belt',   type: 'tool',       group: 'tool',      importance: 8, detail: 'MCP + native tool registry' },
      { id: 'hub-agents',    label: 'Agent Mesh',  type: 'agent',      group: 'agent',     importance: 7, detail: 'Multi-agent orchestrator (A2A protocol)' },
      { id: 'hub-tasks',     label: "Today's Plan", type: 'task',      group: 'task',      importance: 8, detail: 'CorpGen daily operational plan' },
      { id: 'hub-users',     label: 'Users',       type: 'user',       group: 'user',      importance: 7, detail: 'User interactions and profiles' },
    ];
    for (const h of hubs) {
      addNode(h);
      links.push({ source: 'cassidy-core', target: h.id, type: 'core', strength: 0.9 });
    }

    // 3. Registered agents
    let agentCount = 0;
    try {
      const agentList = await listAgents();
      for (const a of agentList) {
        const aid = `agent-${a.rowKey}`;
        addNode({ id: aid, label: String(a.displayName), type: 'agent', group: 'agent', importance: 5, detail: a.description || undefined });
        links.push({ source: 'hub-agents', target: aid, type: 'agent_link', strength: 0.5, label: 'registered' });
        agentCount++;
      }
    } catch { /* ok — agents table may not exist */ }

    // 4. Recent events → granular nodes (every thought, every tool call, every message)
    // Goal: dense, brain-like cloud — hundreds of nodes, naturally clustered by correlation.
    const toolUseCount = new Map<string, number>();
    const thoughtCount = { n: 0 };
    const memoryNodes: string[] = [];
    const toolInstanceIds: string[] = [];

    for (const ev of events.slice(0, 500)) {
      if (ev.kind === 'llm.thought') {
        const tid = `thought-${ev.id}`;
        thoughtCount.n++;
        if (thoughtCount.n <= 200) {
          const text = (ev.data?.text as string) || ev.label;
          addNode({ id: tid, label: ev.label.slice(0, 48), type: 'thought', group: 'thought', importance: 3, detail: text, ts: ev.ts });
          // Only link the most important / recent thoughts to the hub.
          // Older thoughts stay disconnected → render as the outer "starfield".
          if (thoughtCount.n <= 60) {
            links.push({ source: 'hub-reasoning', target: tid, type: 'thought_chain', strength: 0.35 });
          }
        }
      } else if (ev.kind === 'tool.call' || ev.kind === 'corpgen.tool') {
        const toolName = (ev.data?.tool as string) || ev.label.split('▸').pop()?.trim() || ev.label;
        const useCount = (toolUseCount.get(toolName) || 0) + 1;
        toolUseCount.set(toolName, useCount);
        // Tool family hub (one per tool name)
        const toolHubId = `tool-${toolName}`;
        if (!seen.has(toolHubId)) {
          addNode({ id: toolHubId, label: toolName, type: 'tool', group: 'tool', importance: 5, detail: `Tool: ${toolName}`, ts: ev.ts, status: ev.status });
          links.push({ source: 'hub-tools', target: toolHubId, type: 'tool_use', strength: 0.5 });
        }
        // Individual invocation node (granular)
        if (useCount <= 25) {
          const callId = `toolcall-${ev.id}`;
          addNode({ id: callId, label: `${toolName} #${useCount}`, type: 'tool', group: 'tool', importance: 2, detail: ev.label, ts: ev.ts, status: ev.status });
          links.push({ source: toolHubId, target: callId, type: 'tool_use', strength: 0.6 });
          toolInstanceIds.push(callId);
        }
      } else if (ev.kind === 'agent.message') {
        const uid = `user-${ev.correlationId || ev.id}`;
        if (!seen.has(uid)) {
          addNode({ id: uid, label: ev.label.slice(0, 40), type: 'user', group: 'user', importance: 3, ts: ev.ts, detail: 'User interaction' });
          links.push({ source: 'hub-users', target: uid, type: 'memory_recall', strength: 0.4 });
          memoryNodes.push(uid);
        }
      } else if (ev.kind === 'corpgen.cycle') {
        const cid = `cycle-${ev.id}`;
        addNode({ id: cid, label: `Cycle ${ev.label.slice(0, 30)}`, type: 'reflection', group: 'thought', importance: 5, ts: ev.ts, status: ev.status, detail: 'CorpGen plan-act-reflect cycle' });
        links.push({ source: 'hub-reasoning', target: cid, type: 'thought_chain', strength: 0.6 });
      }
    }

    // 4b. Long-term memories — pull a sample for the visualisation
    try {
      const { listEntities } = await import('./memory/tableStorage');
      const partitions = ['fact', 'decision', 'preference'];
      let memCount = 0;
      for (const p of partitions) {
        const entries = await listEntities<{ partitionKey: string; rowKey: string; content?: string; tags?: string; sourceUserId?: string }>('CassidyMemories', p);
        for (const m of entries.slice(0, 40)) {
          const mid = `mem-${p}-${m.rowKey}`;
          const label = (m.content || m.rowKey).slice(0, 50);
          addNode({ id: mid, label, type: 'memory', group: 'memory', importance: 3, detail: m.content });
          links.push({ source: 'hub-memory', target: mid, type: 'memory_recall', strength: 0.35 });
          memoryNodes.push(mid);
          memCount++;
          // Link memory to the user who created it
          if (m.sourceUserId) {
            const uid = `user-profile-${m.sourceUserId}`;
            if (!seen.has(uid)) {
              addNode({ id: uid, label: m.sourceUserId.slice(0, 24), type: 'user', group: 'user', importance: 4 });
              links.push({ source: 'hub-users', target: uid, type: 'memory_recall', strength: 0.4 });
            }
            links.push({ source: uid, target: mid, type: 'memory_recall', strength: 0.3 });
          }
          // Tag-based cross-links → memory clusters
          if (m.tags) {
            for (const tag of m.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 3)) {
              const tid = `tag-${tag}`;
              if (!seen.has(tid)) {
                addNode({ id: tid, label: `#${tag}`, type: 'thought', group: 'memory', importance: 2, detail: `Memory cluster: ${tag}` });
              }
              links.push({ source: tid, target: mid, type: 'memory_recall', strength: 0.25 });
            }
          }
        }
        if (memCount > 100) break;
      }
    } catch { /* ok — memory table may not exist yet */ }

    // 5. Today's plan tasks
    let taskCount = 0;
    try {
      const { defaultCassidyIdentity, loadDailyPlan } = await import('./corpgen');
      const identity = defaultCassidyIdentity();
      const date = new Date().toISOString().slice(0, 10);
      const plan = await loadDailyPlan(identity.employeeId, date);
      if (plan) {
        for (const t of plan.tasks) {
          const nid = `task-${t.taskId}`;
          addNode({ id: nid, label: t.description.slice(0, 50), type: 'task', group: 'task', importance: 7 - (t.priority || 3), status: t.status, detail: `${t.app} — P${t.priority}` });
          links.push({ source: 'hub-tasks', target: nid, type: 'task_dep', strength: 0.6, label: t.status });

          // DAG dependency edges
          for (const dep of t.dependsOn) {
            const depId = `task-${dep}`;
            if (seen.has(depId)) {
              links.push({ source: depId, target: nid, type: 'task_dep', strength: 0.4, label: 'depends on' });
            }
          }
          taskCount++;
        }
      }
    } catch { /* ok — no plan today */ }

    // 6. Cross-links: tools used by thoughts (via correlation)
    const corrGroups = new Map<string, string[]>();
    for (const ev of events.slice(0, 500)) {
      if (ev.correlationId) {
        const arr = corrGroups.get(ev.correlationId) || [];
        const prefix = (ev.kind === 'tool.call' || ev.kind === 'corpgen.tool')
          ? 'toolcall'
          : ev.kind === 'llm.thought'
            ? 'thought'
            : 'other';
        arr.push(`${prefix}-${ev.id}`);
        corrGroups.set(ev.correlationId, arr);
      }
    }
    // Link thoughts to tool calls in the same correlation group → forms tight clusters
    for (const group of corrGroups.values()) {
      const thoughts = group.filter(id => id.startsWith('thought-') && seen.has(id));
      const tools = group.filter(id => id.startsWith('toolcall-') && seen.has(id));
      for (const t of thoughts) {
        for (const tl of tools) {
          links.push({ source: t, target: tl, type: 'thought_chain', strength: 0.5 });
        }
      }
      // Also chain consecutive thoughts so the agent's "stream of consciousness" is visible
      for (let i = 0; i < thoughts.length - 1; i++) {
        links.push({ source: thoughts[i], target: thoughts[i + 1], type: 'thought_chain', strength: 0.4 });
      }
    }

    res.status(200).json({
      nodes,
      links,
      stats: {
        totalMemories: memoryNodes.length + (stats.byKind['agent.message'] || 0),
        activeThoughts: thoughtCount.n,
        toolsUsed: toolUseCount.size,
        agentsOnline: agentCount,
        tasksToday: taskCount,
      },
    });
  } catch (err) {
    logger.error('Mindmap build failed', { module: 'dashboard.mindmap', error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

server.use('/api/dashboard', dashApi);

// Static dashboard assets at /dashboard (SPA — fall back to index.html for client routes).
const dashboardDir = path.resolve(__dirname, '..', 'dashboard', 'dist');
server.use('/dashboard', express.static(dashboardDir, { index: 'index.html', maxAge: '5m' }));
server.get(/^\/dashboard(\/.*)?$/, (_req, res: Response) => {
  res.sendFile(path.join(dashboardDir, 'index.html'), (err) => {
    if (err) res.status(404).send('Dashboard not built. Run `npm run build` in cassidy/dashboard.');
  });
});

// Apply JWT auth middleware for all routes below this point
server.use(authorizeJWT(authConfig));

// Main messages endpoint — CloudAdapter pattern (correct per Agent 365 SDK)
server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

// Agent-to-Agent (A2A) messages endpoint
server.post('/api/agent-messages', (req: Request, res: Response) => {
  logger.info('A2A message received', { module: 'a2a', agentId: String(req.headers['x-agent-id'] || 'unknown-agent') });
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.PORT) || 3978;
// CRITICAL: bind to 0.0.0.0 in production — not localhost — for Azure App Service
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');

const httpServer = server.listen(port, host, () => {
  logger.info('Cassidy listening', { module: 'startup', host, port });
  logger.info('Health check available', { module: 'startup', url: `http://${host}:${port}/api/health` });

  // Wire adapter into the proactive notifier for out-of-turn messaging (legacy)
  const adapter = agentApplication.adapter as CloudAdapter;
  setAdapter(adapter);

  // Start the intelligent proactive engine — evaluates triggers every 5 min,
  // composes natural GPT-5 messages, sends via Teams 1:1 chat
  initProactiveEngine(adapter);
  logger.info('Proactive engine started', { module: 'startup' });

  // Seed the multi-agent registry with known specialist agents
  seedDefaultAgents().catch(err => logger.error('Agent registry seeding failed', { module: 'startup', error: String(err) }));

  // Start the autonomous work loop — polls work queue every 2 min, executes tasks proactively
  // Pass empty map initially; refs are populated as users interact
  const emptyRefs = new Map<string, import('@microsoft/agents-activity').ConversationReference>();
  initAutonomousLoop(adapter, emptyRefs);
  // Backfill conversation refs from persistent storage
  getAllConversationRefs().then(refs => {
    for (const [id, ref] of refs) emptyRefs.set(id, ref);
    logger.info('Autonomous work loop started', { module: 'startup', conversationRefs: refs.size });
  }).catch((err: unknown) => logger.warn('Autonomous work loop ref backfill failed', { module: 'startup', error: String(err) }));

  // Start webhook subscription auto-renewal loop
  startAutoRenewal();
  logger.info('Webhook auto-renewal started', { module: 'startup' });

  // Hydrate CorpGen jobs from table storage so the dashboard survives restarts.
  void import('./corpgenJobs').then(({ hydrateJobs }) =>
    hydrateJobs().then(n => logger.info('CorpGen jobs hydrated', { module: 'startup', count: n })),
  ).catch((err: unknown) => logger.warn('CorpGen jobs hydrate failed', { module: 'startup', error: String(err) }));

  // Start the in-process CorpGen day scheduler (init / cycle / reflect / monthly).
  startCorpGenScheduler();

  // Pre-warm managed identity token to avoid IMDS cold-start delay (~60s)
  if (!isDevelopment) {
    credential.getToken('https://cognitiveservices.azure.com/.default')
      .then(() => logger.info('Managed identity token pre-warmed', { module: 'startup' }))
      .catch((err: unknown) => logger.warn('Token pre-warm failed', { module: 'startup', error: String(err) }));
  }
}).on('error', (err: unknown) => {
  logger.error('Server error', { module: 'startup', error: String(err) });
  process.exit(1);
});

// Graceful shutdown — stop background loops before process exits
function gracefulShutdown(signal: string) {
  logger.info('Graceful shutdown initiated', { module: 'lifecycle', signal });
  stopAutonomousLoop();
  stopProactiveEngine();
  stopCorpGenScheduler();
  stopAutoRenewal();
  httpServer.close(() => {
    logger.info('HTTP server closed', { module: 'lifecycle' });
    process.exit(0);
  });
  flushTelemetry();
  // Force exit if server.close hangs
  setTimeout(() => process.exit(1), config.shutdownGracePeriodMs).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
