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
import { agentApplication, credential, runAutonomousStandup, userInsightCache, memoryCache } from './agent';
import { setAdapter } from './scheduler/proactiveNotifier';
import { initAutonomousLoop, stopAutonomousLoop } from './autonomous/autonomousLoop';
import { initProactiveEngine, stopProactiveEngine, triggerSpecific } from './proactive/proactiveEngine';
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
    version: '1.6.0',
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
    },
    rateLimiter: {
      trackedUsers: userRateLimiter.getTrackedUsers(),
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
