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
  timeout: 120_000,  // 120s hard timeout — GPT-5 reasoning can be slow
  maxRetries: 1,
});

// Per-call timeout for OpenAI requests (AbortController)
const OPENAI_CALL_TIMEOUT_MS = 90_000; // 90s per iteration
const TOOL_EXEC_TIMEOUT_MS = 30_000;   // 30s per tool call

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

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, state: AppTurnState) => {
  const userMessage = context.activity.text?.trim() || '';
  const userName = context.activity.from?.name || 'there';
  const convId = context.activity.conversation?.id ?? '';

  // Always register user and persist conversation reference for proactive messaging
  registerUser(context).catch(err => console.error('[Cassidy] User registration failed:', err));

  if (!userMessage) {
    try {
      await context.sendActivity(
        `Hi ${userName}! I'm Cassidy, your Operations Manager. How can I help today?`
      );
    } catch (err) { console.warn('[Cassidy] Failed to send greeting:', err); }
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
    try { await context.sendActivity(result.message); } catch (err) { console.warn('[Cassidy] Failed to send notification response:', err); }
    return;
  }

  // Load persistent conversation history
  let history: import('./memory/conversationMemory').HistoryMessage[] = [];
  try {
    history = await loadHistory(convId);
  } catch (err) {
    console.error('Failed to load conversation history:', err);
  }
  history.push({ role: 'user', content: userMessage });
  const recentHistory = history.slice(-20);

  // Check if this is a complex autonomous goal — if so, enqueue and acknowledge
  if (isComplexGoal(userMessage)) {
    const typingInterval = setInterval(async () => {
      try { await context.sendActivity({ type: ActivityTypes.Typing } as unknown as Activity); } catch (err) { console.debug('[Cassidy] Typing indicator failed:', err); }
    }, 4000);
    try {
      await context.sendActivity(`🤔 That sounds like a multi-step goal. I'm planning it out now...`);
      const subtasks = await decomposeGoal(userMessage);
      const workItem = createWorkItem({
        goal: userMessage,
        subtasks,
        conversationId: convId,
        serviceUrl: context.activity.serviceUrl ?? '',
        userId: context.activity.from?.id ?? '',
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
      console.error('Goal enqueue error:', err);
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await context.sendActivity(`❌ I hit an error while planning that goal: ${errMsg}\nI'll handle it as a regular request instead.`);
      } catch (sendErr) { console.warn('[Cassidy] Failed to send goal-error fallback:', sendErr); }
      // Fall through to normal Q&A handling below
    }
  }

  // Send typing indicator every 4s to prevent Teams 15s timeout during GPT-5 reasoning
  const typingInterval = setInterval(async () => {
    try { await context.sendActivity({ type: ActivityTypes.Typing } as unknown as Activity); } catch (err) { console.debug('[Cassidy] Typing indicator failed:', err); }
  }, 4000);

  try {
    // Recall relevant long-term memories and user insight to personalise the response
    const userId = context.activity.from?.id ?? '';
    let memoryContext = '';
    try {
      const [relevantMemories, userInsight] = await Promise.all([
        recall(userMessage, { userId, maxResults: 3 }).catch(() => []),
        getUserInsight(userId).catch(() => null),
      ]);
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
    } catch (memErr) { console.warn('[Cassidy] Memory/profile lookup failed (non-blocking):', memErr); }

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
    const toolName = (t: ChatCompletionTool) => t.type === 'function' ? t.function.name : '';
    const liveNames = new Set(liveMcpTools.map(toolName));
    // Keep static tools only when no live MCP equivalent exists
    const MAX_TOOLS = 128;
    let mergedTools = [...liveMcpTools, ...staticTools.filter(t => !liveNames.has(toolName(t)))];
    if (mergedTools.length > MAX_TOOLS) {
      console.warn(`[Cassidy] Trimming tools from ${mergedTools.length} to ${MAX_TOOLS} (MCP tools kept, static overflow trimmed)`);
      mergedTools = mergedTools.slice(0, MAX_TOOLS);
    }
    console.log(`[Cassidy] Turn tools: ${liveMcpTools.length} live MCP + ${staticTools.length} static = ${mergedTools.length} total`);

    // Agentic loop — GPT-5 reasons and calls tools until a final response is produced
    let reply = 'Sorry, I could not generate a response.';
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      let response;
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), OPENAI_CALL_TIMEOUT_MS);
        response = await openai.chat.completions.create(
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
      } catch (apiErr) {
        if (apiErr instanceof Error && (apiErr.name === 'AbortError' || apiErr.message.includes('abort'))) {
          console.error(`[Cassidy] OpenAI API timeout after ${OPENAI_CALL_TIMEOUT_MS / 1000}s on iteration ${i}`);
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
          try {
            const params = JSON.parse(toolCall.function.arguments || '{}');
            const result = await Promise.race([
              executeTool(toolCall.function.name, params, context),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool timeout after ${TOOL_EXEC_TIMEOUT_MS / 1000}s`)), TOOL_EXEC_TIMEOUT_MS)
              ),
            ]);
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
          } catch (parseErr) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error(`[Cassidy] Tool ${toolCall.function.name} failed:`, errMsg);
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
      await context.sendActivity(reply);
    } catch (sendErr: unknown) {
      console.error('sendActivity error:', sendErr);
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
      console.error('[Cassidy] Profiling error:', err)
    );

    // Extract memories if conversation has enough substance (>2 turns)
    if (history.length >= 4) {
      const recentText = history.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');
      extractMemories(recentText, userId, userName).catch(err =>
        console.error('[Cassidy] Memory extraction error:', err)
      );
    }
  } catch (err: unknown) {
    clearInterval(typingInterval);
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('OpenAI/tool error:', err);
    try {
      await context.sendActivity(`Sorry, I encountered an error while processing your request. Please try again.\n\n**Debug:** ${errMsg}`);
    } catch (sendErr: unknown) {
      console.error('sendActivity error in catch block:', sendErr);
    }
  }
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: AppTurnState) => {
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
      console.error('InstallationUpdate sendActivity error:', err);
    }
  }
});

export async function runAutonomousStandup(): Promise<void> {
  await executeAutonomousStandup();
}
