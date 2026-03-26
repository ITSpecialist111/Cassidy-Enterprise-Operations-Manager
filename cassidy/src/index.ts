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
import { agentApplication, credential, runAutonomousStandup } from './agent';
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

// Initialise Application Insights early (before route handlers)
initTelemetry();

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
  res.status(200).json({
    status: 'healthy',
    agent: 'Cassidy',
    features: {
      mcp: features.mcpAvailable,
      speech: features.speechConfigured,
      openai: features.openAiConfigured,
      appIdentity: features.appIdentityConfigured,
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
    console.log('Autonomous standup triggered via /api/scheduled');
    await runAutonomousStandup();
    res.status(200).json({ status: 'standup_complete', timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    console.error('Autonomous standup error:', err);
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
    console.log(`[Cassidy] Proactive trigger fired: ${triggerType}`);
    const result = await triggerSpecific(triggerType);
    res.status(200).json({ status: 'triggered', triggerType, ...result, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    console.error('Proactive trigger error:', err);
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
      console.warn('[MeetingWebhook] Invalid clientState — rejecting notification');
      res.status(403).json({ error: 'Invalid clientState' });
      return;
    }
  }

  try {
    const responses = await handleTranscriptWebhook(req.body);

    // Post any Cassidy responses to the meeting chat
    for (const r of responses) {
      await postToMeetingChat(r.chatId, r.message).catch(err =>
        console.error(`[MeetingWebhook] Failed to post to chat ${r.chatId}:`, err)
      );
    }

    res.status(202).json({ processed: responses.length });
  } catch (err: unknown) {
    console.error('Meeting webhook error:', err);
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
        console.error(`[CallNotification] Failed to start voice conversation:`, err)
      );
    } else if (result.action === 'end' && result.callId) {
      endVoiceConversation(result.callId);
    }

    res.status(200).json({ status: 'processed' });
  } catch (err: unknown) {
    console.error('Call notification error:', err);
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
  console.debug('A2A message received from:', req.headers['x-agent-id'] || 'unknown-agent');
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.PORT) || 3978;
// CRITICAL: bind to 0.0.0.0 in production — not localhost — for Azure App Service
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');

const httpServer = server.listen(port, host, () => {
  console.log(`\nCassidy (Operations Manager) listening on ${host}:${port}`);
  console.log(`Health check: http://${host}:${port}/api/health`);

  // Wire adapter into the proactive notifier for out-of-turn messaging (legacy)
  const adapter = agentApplication.adapter as CloudAdapter;
  setAdapter(adapter);

  // Start the intelligent proactive engine — evaluates triggers every 5 min,
  // composes natural GPT-5 messages, sends via Teams 1:1 chat
  initProactiveEngine(adapter);
  console.log('Proactive engine started — intelligent outreach active');

  // Seed the multi-agent registry with known specialist agents
  seedDefaultAgents().catch(err => console.error('Agent registry seeding failed:', err));

  // Start the autonomous work loop — polls work queue every 2 min, executes tasks proactively
  // Pass empty map initially; refs are populated as users interact
  const emptyRefs = new Map<string, import('@microsoft/agents-activity').ConversationReference>();
  initAutonomousLoop(adapter, emptyRefs);
  // Backfill conversation refs from persistent storage
  getAllConversationRefs().then(refs => {
    for (const [id, ref] of refs) emptyRefs.set(id, ref);
    console.log(`Autonomous work loop started (${refs.size} persisted conversation ref(s) loaded)`);
  }).catch((err: unknown) => console.warn('Autonomous work loop started (ref backfill failed):', err));

  // Pre-warm managed identity token to avoid IMDS cold-start delay (~60s)
  if (!isDevelopment) {
    credential.getToken('https://cognitiveservices.azure.com/.default')
      .then(() => console.log('Managed identity token pre-warmed successfully'))
      .catch((err: unknown) => console.warn('Token pre-warm failed (will retry on first message):', err));
  }
}).on('error', (err: unknown) => {
  console.error(err);
  process.exit(1);
});

// Graceful shutdown — stop background loops before process exits
function gracefulShutdown(signal: string) {
  console.log(`[Cassidy] ${signal} received — shutting down gracefully`);
  stopAutonomousLoop();
  stopProactiveEngine();
  httpServer.close(() => {
    console.log('[Cassidy] HTTP server closed');
    process.exit(0);
  });
  flushTelemetry();
  // Force exit if server.close hangs
  setTimeout(() => process.exit(1), config.shutdownGracePeriodMs).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
