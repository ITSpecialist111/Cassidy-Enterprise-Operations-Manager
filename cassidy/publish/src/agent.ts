// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Load environment variables first (required before other imports)
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes, Activity } from '@microsoft/agents-activity';
import { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionTool } from 'openai/resources/chat';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { CASSIDY_SYSTEM_PROMPT } from './persona';
import { getAllTools, executeTool, executeAutonomousStandup } from './tools/index';
import { getLiveMcpToolDefinitions } from './tools/mcpToolSetup';
import { loadHistory, saveHistory } from './memory/conversationMemory';
import { enqueueWork, createWorkItem } from './workQueue/workQueue';
import { decomposeGoal, isComplexGoal } from './workQueue/goalDecomposer';
import {
  detectNotificationCommand,
  startNotifications,
  stopNotifications,
  getNotificationStatus,
} from './scheduler/proactiveNotifier';
import { registerUser } from './proactive/userRegistry';
import { recordInteraction, type InteractionSummary } from './intelligence/userProfiler';
import { extractMemories, recall } from './memory/longTermMemory';
import { getUserInsight } from './intelligence/userProfiler';
import { config as appConfig, features } from './featureConfig';
import { trackOpenAiCall, trackToolCall, trackException } from './telemetry';
import { withRetry, openAiCircuit, isTransientError } from './retry';
import { tryBuildCardFromReply } from './adaptiveCards';
import { logger } from './logger';
import { userRateLimiter } from './rateLimiter';
import { LruCache } from './lruCache';

// LRU caches for user profiles and notification preferences (reduces Table Storage calls)
const userInsightCache = new LruCache<Awaited<ReturnType<typeof getUserInsight>>>(200, 300_000);
const memoryCache = new LruCache<Awaited<ReturnType<typeof recall>>>(500, 120_000);

/** Expose caches for health endpoint reporting */
export { userInsightCache, memoryCache };

// State interfaces
interface ConversationData {
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }>;
}
interface AppTurnState extends TurnState {
  conversation: ConversationData;
}

// Keyless auth via managed identity (Azure) or local az login (dev)
export const credential = new DefaultAzureCredential();
const azureADTokenProvider = getBearerTokenProvider(
  credential,
  'https://cognitiveservices.azure.com/.default'
);

if (!features.openAiConfigured) {
  console.warn('WARNING: AZURE_OPENAI_ENDPOINT is not set. OpenAI calls will fail.');
}

const openai = new AzureOpenAI({
  azureADTokenProvider,
  endpoint: appConfig.openAiEndpoint,
  apiVersion: '2025-04-01-preview',
  deployment: appConfig.openAiDeployment,
  timeout: appConfig.openAiClientTimeoutMs,
  maxRetries: 1,
});

// Per-call timeout for OpenAI requests (AbortController)
const OPENAI_CALL_TIMEOUT_MS = appConfig.openAiCallTimeoutMs;
const TOOL_EXEC_TIMEOUT_MS = appConfig.toolExecTimeoutMs;

function parseAgenticScopes(): string[] {
  const raw =
    process.env.connections__service_connection__settings__scopes ??
    process.env.agentic_scopes ??
    'https://graph.microsoft.com/.default';
  return raw
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean);
}

export const agentApplication = new AgentApplication<AppTurnState>({
  storage: new MemoryStorage(),
  authorization: {
    AgenticAuthConnection: {
      type: 'agentic',
      scopes: parseAgenticScopes(),
      altBlueprintConnectionName: process.env.agentic_altBlueprintConnectionName ?? 'service_connection',
    },
  },
});

// ---------------------------------------------------------------------------
// Adaptive Card invoke handler — processes Approve / Reject button clicks
// ---------------------------------------------------------------------------
agentApplication.onActivity(ActivityTypes.Invoke, async (context: TurnContext, _state: AppTurnState) => {
  const invoke = context.activity as import('@microsoft/agents-activity').Activity & { name?: string; value?: Record<string, unknown> };
  if (invoke.name !== 'adaptiveCard/action') return;

  const valueObj = invoke.value as { action?: { data?: { action?: string; approvalId?: string } } } | undefined;
  const data = valueObj?.action?.data;
  if (!data?.action || !data?.approvalId) {
    await context.sendActivity({ type: 'invokeResponse', value: { status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: 'Missing approval data.' } } } as unknown as import('@microsoft/agents-activity').Activity);
    return;
  }

  const userName = context.activity.from?.name || 'Unknown';
  const userId = context.activity.from?.id ?? '';
  const action = data.action === 'approve' ? 'approved' : 'rejected';

  logger.info(`Approval ${action}`, { module: 'approvals', userId, toolName: 'approval_action', approvalId: data.approvalId, action });

  const responseText = `✅ **${userName}** ${action} approval **${data.approvalId}**.`;

  await context.sendActivity({ type: 'invokeResponse', value: { status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: responseText } } } as unknown as import('@microsoft/agents-activity').Activity);
});

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, _state: AppTurnState) => {
  const userMessage = context.activity.text?.trim() || '';
  const userName = context.activity.from?.name || 'there';
  const convId = context.activity.conversation?.id ?? '';
  const userId = context.activity.from?.id ?? '';

  // Always register user and persist conversation reference for proactive messaging
  registerUser(context).catch(err => logger.error('User registration failed', { module: 'agent', userId, error: String(err) }));

  // Per-user rate limiting — protect OpenAI quota from spam
  const rateCheck = userRateLimiter.check(userId);
  if (!rateCheck.allowed) {
    const waitSec = Math.ceil(rateCheck.retryAfterMs / 1000);
    logger.warn('Rate limited', { module: 'agent', userId, retryAfterMs: rateCheck.retryAfterMs });
    try {
      await context.sendActivity(`⏳ You're sending messages a bit fast — please wait ~${waitSec}s before trying again.`);
    } catch { /* best effort */ }
    return;
  }

  if (!userMessage) {
    try {
      await context.sendActivity(
        `Hi ${userName}! I'm Cassidy, your Operations Manager. How can I help today?`
      );
    } catch (err) { logger.warn('Failed to send greeting', { module: 'agent', userId, error: String(err) }); }
    return;
  }

  // Check for notification on/off commands before entering the LLM loop
  const notifCmd = detectNotificationCommand(userMessage);
  if (notifCmd) {
    let result: { success: boolean; message: string };
    if (notifCmd === 'start') {
      result = startNotifications(convId);
    } else if (notifCmd === 'stop') {
      result = stopNotifications(convId);
    } else {
      const status = getNotificationStatus(convId);
      result = {
        success: true,
        message: status.enabled
          ? `🔔 **Notifications active.** I've sent ${status.alertsSent} alert(s) since ${status.startedAt?.toLocaleTimeString() ?? 'start'}.`
          : `Notifications are currently **off**. Say **"start notifications"** to activate.`,
      };
    }
    try { await context.sendActivity(result.message); } catch (err) { logger.warn('Failed to send notification response', { module: 'agent', userId, error: String(err) }); }
    return;
  }

  // Load persistent conversation history
  let history: import('./memory/conversationMemory').HistoryMessage[] = [];
  try {
    history = await loadHistory(convId);
  } catch (err) {
    logger.error('Failed to load conversation history', { module: 'agent', conversationId: convId, error: String(err) });
  }
  history.push({ role: 'user', content: userMessage });
  const recentHistory = history.slice(-20);

  // Check if this is a complex autonomous goal — if so, enqueue and acknowledge
  if (isComplexGoal(userMessage)) {
    const typingInterval = setInterval(async () => {
      try { await context.sendActivity(new Activity(ActivityTypes.Typing)); } catch (err) { logger.debug('Typing indicator failed', { module: 'agent', error: String(err) }); }
    }, 4000);
    try {
      await context.sendActivity(`🤔 That sounds like a multi-step goal. I'm planning it out now...`);
      const subtasks = await decomposeGoal(userMessage);
      const workItem = createWorkItem({
        goal: userMessage,
        subtasks,
        conversationId: convId,
        serviceUrl: context.activity.serviceUrl ?? '',
        userId,
      });
      await enqueueWork(workItem);
      const plan = subtasks.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
      const reply = `✅ **Got it — I'm on it autonomously.**\n\n**Goal:** ${userMessage}\n\n**My plan:**\n${plan}\n\nI'll work through this and update you as each step completes. You don't need to stay in the chat.`;
      history.push({ role: 'assistant', content: reply });
      await saveHistory(convId, history);
      clearInterval(typingInterval);
      await context.sendActivity(reply);
      return; // Goal queued successfully — don't fall through to regular Q&A
    } catch (err) {
      clearInterval(typingInterval);
      logger.error('Goal enqueue error', { module: 'agent', userId, error: String(err) });
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await context.sendActivity(`❌ I hit an error while planning that goal: ${errMsg}\nI'll handle it as a regular request instead.`);
      } catch (sendErr) { logger.warn('Failed to send goal-error fallback', { module: 'agent', error: String(sendErr) }); }
      // Fall through to normal Q&A handling below
    }
  }

  // Send typing indicator every 4s to prevent Teams 15s timeout during GPT-5 reasoning
  const typingInterval = setInterval(async () => {
    try { await context.sendActivity(new Activity(ActivityTypes.Typing)); } catch (err) { logger.debug('Typing indicator failed', { module: 'agent', error: String(err) }); }
  }, 4000);

  try {
    // Recall relevant long-term memories and user insight to personalise the response
    let memoryContext = '';
    try {
      // Use LRU caches to avoid redundant Table Storage calls per turn
      const cachedInsight = userInsightCache.get(userId);
      const memoryCacheKey = `${userId}:${userMessage.slice(0, 40)}`;
      const cachedMemories = memoryCache.get(memoryCacheKey);

      const [relevantMemories, userInsight] = await Promise.all([
        cachedMemories ?? recall(userMessage, { userId, maxResults: 3 }).catch(() => []),
        cachedInsight ?? getUserInsight(userId).catch(() => null),
      ]);

      // Populate caches
      if (!cachedMemories && relevantMemories.length > 0) memoryCache.set(memoryCacheKey, relevantMemories);
      if (!cachedInsight && userInsight) userInsightCache.set(userId, userInsight);
      if (relevantMemories.length > 0) {
        memoryContext += '\n\n[Relevant long-term memories]\n' +
          relevantMemories.map(m => `- [${m.category}] ${m.content}`).join('\n');
      }
      if (userInsight) {
        memoryContext += `\n\n[User profile: ${userName}]\n` +
          `Communication style: ${userInsight.communicationStyle}\n` +
          `Common topics: ${userInsight.commonTopics.join(', ')}\n` +
          `Sentiment trend: ${userInsight.sentimentTrend}`;
      }
    } catch (memErr) { logger.warn('Memory/profile lookup failed (non-blocking)', { module: 'agent', userId, error: String(memErr) }); }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: CASSIDY_SYSTEM_PROMPT + memoryContext },
      ...recentHistory.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }),
    ];

    // Merge static tools with live MCP tools discovered from Work IQ gateway
    // Live MCP tools take PRIORITY — they're the real M365 connections (Teams, Mail, Planner, Word, Excel, etc.)
    const staticTools = getAllTools();
    const liveMcpTools = await getLiveMcpToolDefinitions(context);
    const toolName = (t: ChatCompletionTool): string => t.type === 'function' ? t.function.name : '';
    const liveNames = new Set(liveMcpTools.map(toolName));
    // Keep static tools only when no live MCP equivalent exists
    const MAX_TOOLS = 128;
    let mergedTools = [...liveMcpTools, ...staticTools.filter(t => !liveNames.has(toolName(t)))];
    if (mergedTools.length > MAX_TOOLS) {
      logger.debug('Trimming tools', { module: 'agent', totalBefore: mergedTools.length, max: MAX_TOOLS });
      mergedTools = mergedTools.slice(0, MAX_TOOLS);
    }
    logger.info('Turn tools merged', { module: 'agent', userId, liveMcp: liveMcpTools.length, static: staticTools.length, total: mergedTools.length });

    // ── Graceful degradation — when OpenAI circuit is open, respond with helpful limited-mode message
    if (openAiCircuit.getState() === 'open') {
      const degradedReply = `⚠️ **I'm running in limited mode** — my AI reasoning is temporarily unavailable due to upstream issues. ` +
        `I can still process simple commands like notification controls. Please try again in a minute.`;
      history.push({ role: 'assistant', content: degradedReply });
      await saveHistory(convId, history);
      clearInterval(typingInterval);
      await context.sendActivity(degradedReply);
      return;
    }

    // Agentic loop — GPT-5 reasons and calls tools until a final response is produced
    let reply = 'Sorry, I could not generate a response.';
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      let response;
      let llmStart: number;
      try {
        llmStart = Date.now();
        response = await openAiCircuit.execute(() =>
          withRetry(async () => {
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => controller.abort(), OPENAI_CALL_TIMEOUT_MS);
            try {
              const res = await openai.chat.completions.create(
                {
                  model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5',
                  messages,
                  tools: mergedTools,
                  tool_choice: 'auto',
                  max_completion_tokens: 4000,
                },
                { signal: controller.signal },
              );
              clearTimeout(timeoutHandle);
              return res;
            } catch (err) {
              clearTimeout(timeoutHandle);
              throw err;
            }
          }, {
            maxAttempts: 2,
            baseDelayMs: 2000,
            retryIf: isTransientError,
            onRetry: (attempt, delay) => logger.warn('OpenAI retry', { module: 'agent', attempt, durationMs: delay }),
          }),
        );
        trackOpenAiCall(Date.now() - llmStart, true, appConfig.openAiDeployment);
      } catch (apiErr) {
        trackOpenAiCall(Date.now() - llmStart!, false, appConfig.openAiDeployment);
        if (apiErr instanceof Error && (apiErr.name === 'AbortError' || apiErr.message.includes('abort'))) {
          logger.error('OpenAI API timeout', { module: 'agent', userId, durationMs: OPENAI_CALL_TIMEOUT_MS, iteration: i });
          reply = `⏱️ I'm taking longer than expected to work through this. Let me try a simpler approach — could you ask a more specific question?`;
          break;
        }
        throw apiErr;
      }

      const choice = response.choices[0];
      messages.push(choice.message as ChatCompletionMessageParam);

      if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
        const content = choice.message.content?.trim();
        if (content) {
          reply = content;
          break;
        }
        // GPT-5: empty content after tools — ask once for a summary
        if (i < maxIterations - 2) {
          messages.push({ role: 'user' as const, content: 'Please summarise what you found or did in a concise response.' });
          continue;
        }
        break;
      }

      // Execute all tool calls in parallel with per-tool timeout, thread context for OBO auth
      const toolResults = await Promise.all(
        choice.message.tool_calls.map(async (toolCall) => {
          if (toolCall.type !== 'function') {
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: '{}' };
          }
          const toolStart = Date.now();
          try {
            const params = JSON.parse(toolCall.function.arguments || '{}');
            // Safe timeout: clearTimeout on settle prevents dangling rejection
            const result = await new Promise<string>((resolve, reject) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) { settled = true; reject(new Error(`Tool timeout after ${TOOL_EXEC_TIMEOUT_MS / 1000}s`)); }
              }, TOOL_EXEC_TIMEOUT_MS);
              executeTool(toolCall.function.name, params, context)
                .then(r => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } })
                .catch(e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
            });
            trackToolCall(toolCall.function.name, Date.now() - toolStart, true);
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
          } catch (parseErr) {
            trackToolCall(toolCall.function.name, Date.now() - toolStart, false);
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            logger.error('Tool execution failed', { module: 'agent', toolName: toolCall.function.name, userId, durationMs: Date.now() - toolStart, error: errMsg });
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: JSON.stringify({ error: errMsg }) };
          }
        })
      );
      messages.push(...toolResults);
    }

    history.push({ role: 'assistant', content: reply });
    await saveHistory(convId, history);
    clearInterval(typingInterval);
    try {
      // Try sending as an Adaptive Card for structured content; fall back to plain text
      const card = tryBuildCardFromReply(reply);
      if (card) {
        await context.sendActivity({
          type: 'message',
          text: reply,
          attachments: [card],
        } as import('@microsoft/agents-activity').Activity);
      } else {
        await context.sendActivity(reply);
      }
    } catch (sendErr: unknown) {
      logger.error('sendActivity error', { module: 'agent', userId, error: String(sendErr) });
    }

    // Background: record interaction for user profiling and extract long-term memories
    const now = new Date();
    const toolsUsedInTurn = messages
      .filter(m => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls)
      .flatMap(m => ('tool_calls' in m && Array.isArray(m.tool_calls))
        ? (m.tool_calls as ChatCompletionMessageToolCall[]).filter(tc => tc.type === 'function').map(tc => tc.function.name)
        : []
      );

    const interaction: InteractionSummary = {
      timestamp: now.toISOString(),
      topic: userMessage.slice(0, 80),
      toolsUsed: toolsUsedInTurn.slice(0, 10),
      sentiment: 'neutral',
      responseLength: reply.length > 500 ? 'detailed' : 'brief',
      dayOfWeek: now.getDay(),
      hourOfDay: now.getHours(),
    };

    recordInteraction(userId, userName, interaction).catch(err =>
      logger.error('Profiling error', { module: 'agent', userId, error: String(err) })
    );

    // Extract memories if conversation has enough substance (>2 turns)
    if (history.length >= 4) {
      const recentText = history.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');
      extractMemories(recentText, userId, userName).catch(err =>
        logger.error('Memory extraction error', { module: 'agent', userId, error: String(err) })
      );
    }
  } catch (err: unknown) {
    clearInterval(typingInterval);
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.error('OpenAI/tool error', { module: 'agent', userId, error: errMsg });
    if (err instanceof Error) trackException(err, { module: 'agent', userId });
    try {
      await context.sendActivity(`Sorry, I encountered an error while processing your request. Please try again.\n\n**Debug:** ${errMsg}`);
    } catch (sendErr: unknown) {
      logger.error('sendActivity error in catch block', { module: 'agent', error: String(sendErr) });
    }
  }
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, _state: AppTurnState) => {
  if (context.activity.action === 'add') {
    try {
      await context.sendActivity(
        `👋 Hi! I'm **Cassidy**, your Operations Manager.\n\n` +
        `I can help you with:\n` +
        `- 📋 **Task tracking** — overdue items, workload, Planner integration\n` +
        `- 📊 **Project status** — health reports, blockers, completion tracking\n` +
        `- ✅ **Approvals** — send requests, track responses, escalate stalled items\n` +
        `- 📬 **Communications** — Teams channel messages and email\n` +
        `- 📅 **Scheduling** — calendar events and team meetings\n` +
        `- 🔔 **Proactive outreach** — I'll message you about overdue tasks, stalled approvals, and morning briefings\n` +
        `- 📑 **Report generation** — Word, Excel, and PowerPoint reports emailed to your team\n` +
        `- 🎤 **Meeting intelligence** — I can join meetings, listen for my name, and contribute\n` +
        `- 📞 **Voice calls** — I'll call you on Teams if something critical needs immediate attention\n` +
        `- 🧠 **Long-term memory** — I remember facts, decisions, and your preferences across conversations\n\n` +
        `I'll proactively reach out when something needs your attention — no need to ask.\n` +
        `Say **"configure notifications"** to customise what I alert you about.\n\n` +
        `What would you like to work on today?`
      );
    } catch (err: unknown) {
      logger.error('InstallationUpdate sendActivity error', { module: 'agent', error: String(err) });
    }
  }
});

export async function runAutonomousStandup(): Promise<void> {
  await executeAutonomousStandup();
}
