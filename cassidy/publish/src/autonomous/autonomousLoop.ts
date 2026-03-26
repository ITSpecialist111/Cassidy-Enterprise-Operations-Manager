// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Autonomous execution loop — polls the work queue every 2 minutes,
// executes pending subtasks, handles retries, and notifies users proactively.

import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { CloudAdapter } from '@microsoft/agents-hosting';
import type { ConversationReference } from '@microsoft/agents-activity';
import {
  getPendingItems, updateWorkItem, WorkItem, Subtask,
} from '../workQueue/workQueue';
import { getAllTools, executeTool } from '../tools/index';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';

const POLL_INTERVAL_MS = appConfig.autonomousPollIntervalMs;
const MAX_RETRIES = 3;

let _adapter: CloudAdapter | null = null;
let _conversationRefs: Map<string, ConversationReference> = new Map();
let _loopTimer: ReturnType<typeof setInterval> | null = null;

export function initAutonomousLoop(
  adapter: CloudAdapter,
  conversationRefs: Map<string, ConversationReference>,
): void {
  _adapter = adapter;
  _conversationRefs = conversationRefs;
  _loopTimer = setInterval(runLoop, POLL_INTERVAL_MS);
  console.debug('[AutonomousLoop] Started — polling every 2 minutes');
  // Run once immediately after a short delay (let app finish booting)
  setTimeout(runLoop, appConfig.autonomousBootDelayMs);
}

export function stopAutonomousLoop(): void {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  console.debug('[AutonomousLoop] Stopped');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runLoop(): Promise<void> {
  const items = await getPendingItems().catch(err => {
    console.error('[AutonomousLoop] Failed to fetch work queue:', err);
    return [] as WorkItem[];
  });

  if (items.length === 0) return;
  console.debug(`[AutonomousLoop] Processing ${items.length} work item(s)`);

  for (const item of items) {
    await processItem(item).catch(err =>
      console.error(`[AutonomousLoop] Unhandled error on item ${item.rowKey}:`, err)
    );
  }
}

// ---------------------------------------------------------------------------
// Process a single work item
// ---------------------------------------------------------------------------

async function processItem(item: WorkItem): Promise<void> {
  const subtasks: Subtask[] = JSON.parse(item.subtasks);

  // Find next pending subtask whose dependencies are all done
  const next = subtasks.find(s =>
    s.status === 'pending' &&
    s.dependsOn.every(dep => subtasks.find(d => d.id === dep)?.status === 'done')
  );

  if (!next) {
    // All subtasks done (or blocked by failures)
    const allDone = subtasks.every(s => s.status === 'done');
    const hasFailed = subtasks.some(s => s.status === 'failed');

    if (allDone) {
      const summary = subtasks.map(s => `✅ ${s.description}`).join('\n');
      await updateWorkItem({ rowKey: item.rowKey, status: 'done', result: summary });
      await notifyUser(item, `✅ **Goal complete:** ${item.goal}\n\n${summary}`);
    } else if (hasFailed && item.retryCount >= MAX_RETRIES) {
      await updateWorkItem({ rowKey: item.rowKey, status: 'waiting_on_human' });
      const failed = subtasks.filter(s => s.status === 'failed').map(s => `❌ ${s.description}`).join('\n');
      await notifyUser(item, `⚠️ **I need your help with:** ${item.goal}\n\nI tried ${MAX_RETRIES} times but hit a blocker:\n${failed}\n\nPlease advise and I'll continue.`);
    }
    return;
  }

  console.debug(`[AutonomousLoop] Executing subtask ${subtasks.indexOf(next) + 1}/${subtasks.length} for work item ${item.rowKey}`);  await updateWorkItem({ rowKey: item.rowKey, status: 'in_progress' });

  try {
    const result = await executeSubtask(next, subtasks, item.goal);
    next.status = 'done';
    next.result = result;
    await updateWorkItem({
      rowKey: item.rowKey,
      subtasks: JSON.stringify(subtasks),
      currentStep: item.currentStep + 1,
      status: 'in_progress',
      retryCount: 0,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[AutonomousLoop] Subtask failed: ${error}`);
    next.status = 'failed';
    const newRetryCount = item.retryCount + 1;

    if (newRetryCount < MAX_RETRIES) {
      // Reset subtask for retry on next loop
      next.status = 'pending';
      const backoffMs = Math.pow(2, newRetryCount) * appConfig.autonomousBackoffBaseMs;
      console.log(`[AutonomousLoop] Will retry in ${backoffMs / 60000} min (attempt ${newRetryCount + 1}/${MAX_RETRIES})`);
    }

    await updateWorkItem({
      rowKey: item.rowKey,
      subtasks: JSON.stringify(subtasks),
      retryCount: newRetryCount,
      lastError: error,
      status: newRetryCount >= MAX_RETRIES ? 'failed' : 'in_progress',
    });
  }
}

// ---------------------------------------------------------------------------
// Execute a single subtask via GPT-5 + tool calling
// ---------------------------------------------------------------------------

async function executeSubtask(
  subtask: Subtask,
  allSubtasks: Subtask[],
  parentGoal: string,
): Promise<string> {
  const openai = getSharedOpenAI();

  // Build context from completed subtask results
  const completedContext = allSubtasks
    .filter(s => s.status === 'done' && s.result)
    .map(s => `Completed: "${s.description}" → ${s.result}`)
    .join('\n');

  const systemPrompt = `You are Cassidy, an autonomous Operations Manager AI executing a work plan.
Parent goal: "${parentGoal}"
${completedContext ? `\nPrevious steps completed:\n${completedContext}` : ''}

Your job right now: execute ONLY this one subtask: "${subtask.description}"
Use the available tools to complete it. After completing it, respond with a brief confirmation of what you did.
Do not ask questions — make reasonable decisions and proceed.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Execute: ${subtask.description}` },
  ];

  const tools = getAllTools();
  let result = '';

  for (let i = 0; i < 5; i++) {
    let response;
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), appConfig.autonomousSubtaskTimeoutMs);
      response = await openai.chat.completions.create(
        {
          model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
          messages,
          tools,
          tool_choice: 'auto',
          max_completion_tokens: 2000,
        },
        { signal: controller.signal },
      );
      clearTimeout(timeoutHandle);
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))) {
        console.error(`[AutonomousLoop] Subtask OpenAI timeout on iteration ${i}`);
        result = 'Subtask timed out during reasoning — partial progress may have been made.';
        break;
      }
      throw err;
    }

    const choice = response.choices[0];
    messages.push(choice.message as ChatCompletionMessageParam);

    if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
      result = choice.message.content?.trim() ?? 'Completed';
      break;
    }

    // Execute tool calls (no TurnContext in autonomous mode — app-only)
    const toolResults = await Promise.all(
      choice.message.tool_calls.map(async tc => {
        if (tc.type !== 'function') return { role: 'tool' as const, tool_call_id: tc.id, content: '{}' };
        const params = JSON.parse(tc.function.arguments || '{}');
        const res = await executeTool(tc.function.name, params, undefined);
        return { role: 'tool' as const, tool_call_id: tc.id, content: res };
      })
    );
    messages.push(...toolResults);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Proactively notify user via Teams
// ---------------------------------------------------------------------------

async function notifyUser(item: WorkItem, message: string): Promise<void> {
  if (!_adapter) return;

  const ref = _conversationRefs.get(item.conversationId);
  if (!ref) {
    console.warn(`[AutonomousLoop] No conversation ref for ${item.conversationId} — cannot notify`);
    return;
  }

  try {
    const botAppId = process.env.MicrosoftAppId ?? '';
    await _adapter.continueConversation(botAppId, ref, async (context: import('@microsoft/agents-hosting').TurnContext) => {
      await context.sendActivity(message);
    });
    console.log(`[AutonomousLoop] Notified user in conversation ${item.conversationId}`);
  } catch (err) {
    console.error('[AutonomousLoop] Failed to notify user:', err);
  }
}
