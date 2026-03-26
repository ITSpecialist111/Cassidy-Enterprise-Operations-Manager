// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Voice Agent — orchestrates voice conversations during Teams calls.
// Speak opening prompt -> listen (STT) -> GPT-5 reasoning -> speak (TTS) -> repeat.
// Uses the same tool set as text chat, with a voice-optimized prompt.
// ---------------------------------------------------------------------------

import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { getSharedOpenAI } from '../auth';
import { synthesizeSpeech, isVoiceAvailable } from './speechProcessor';
import { getActiveCall, playPromptInCall, type CassidyCall } from './callManager';
import { getAllTools, executeTool } from '../tools/index';

// ---------------------------------------------------------------------------
// Voice conversation state
// ---------------------------------------------------------------------------

interface VoiceConversation {
  callId: string;
  messages: ChatCompletionMessageParam[];
  turnCount: number;
  startedAt: string;
}

const activeVoiceConversations = new Map<string, VoiceConversation>();

// Helper: synthesize text to audio and play in the call
async function synthesizeAndPlay(callId: string, text: string): Promise<void> {
  if (!isVoiceAvailable()) return;
  const synthesis = await synthesizeSpeech(text, { rate: 'medium' });
  const playResult = await playPromptInCall(
    callId,
    text,
    synthesis.success ? synthesis.audioData : undefined,
  );
  if (!playResult.success) {
    console.warn(`[VoiceAgent] Audio play failed for call ${callId}: ${playResult.error}`);
  }
}

// Reap stale voice conversations that never got an end signal (2-hour TTL)
const VOICE_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of activeVoiceConversations) {
    if (now - new Date(conv.startedAt).getTime() > VOICE_TTL_MS) {
      console.warn(`[VoiceAgent] Reaping stale voice conversation: ${id}`);
      activeVoiceConversations.delete(id);
    }
  }
}, 30 * 60 * 1000);

// Sliding window limit for voice conversation messages
const MAX_VOICE_MESSAGES = 20;

// ---------------------------------------------------------------------------
// Voice-optimized system prompt
// ---------------------------------------------------------------------------

const VOICE_SYSTEM_PROMPT = `You are Cassidy, an AI Operations Manager making a phone call via Microsoft Teams.

## Voice Communication Rules
- You are SPEAKING to someone — keep responses short and conversational (2-3 sentences max).
- Do NOT use markdown, bold, bullets, or any visual formatting — this is AUDIO only.
- Use natural speech patterns: pauses, transitions, conversational fillers when appropriate.
- Numbers: say "three overdue tasks" not "3 overdue tasks".
- When listing items, limit to the top 3 most important — don't read long lists.
- End each response with a clear question or next step.
- If the person asks you to do something, confirm what you'll do and do it.
- Be warm but efficient — respect their time.

## When You Call Someone
You are reaching out proactively because something needs their attention.
- Start by identifying yourself and the reason for your call.
- Keep the opening brief: "Hi [name], this is Cassidy. I'm calling about [reason]."
- Get to the point quickly — they're busy.
- Offer specific actions: "Would you like me to escalate this?" or "Should I send you the details?"

## Your Capabilities
You have the same tools as in text chat (tasks, approvals, workload, email, Teams, calendar, Planner).
Use tools to get real data before citing numbers. Keep tool-based responses conversational for voice.`;

// ---------------------------------------------------------------------------
// Start a voice conversation when a call connects
// ---------------------------------------------------------------------------

export async function startVoiceConversation(callId: string): Promise<string | null> {
  const call = getActiveCall(callId);
  if (!call) {
    console.warn(`[VoiceAgent] No active call for ${callId}`);
    return null;
  }

  // Build opening message based on the call reason and context
  const openingPrompt = await composeOpeningPrompt(call);

  const conversation: VoiceConversation = {
    callId,
    messages: [
      { role: 'system', content: VOICE_SYSTEM_PROMPT },
      { role: 'assistant', content: openingPrompt },
    ],
    turnCount: 0,
    startedAt: new Date().toISOString(),
  };

  activeVoiceConversations.set(callId, conversation);

  // Synthesize and play the opening prompt
  if (isVoiceAvailable()) {
    const synthesis = await synthesizeSpeech(openingPrompt, { rate: 'medium' });
    if (synthesis.success && synthesis.audioData) {
      const playResult = await playPromptInCall(callId, openingPrompt, synthesis.audioData);
      if (!playResult.success) {
        console.warn(`[VoiceAgent] Audio prompt failed for call ${callId}: ${playResult.error}`);
      }
    } else {
      console.warn(`[VoiceAgent] TTS synthesis failed: ${synthesis.error}`);
    }
  }

  console.log(`[VoiceAgent] Voice conversation started for call ${callId}`);
  return openingPrompt;
}

// ---------------------------------------------------------------------------
// Process user speech (STT result) and generate GPT-5 response
// ---------------------------------------------------------------------------

export async function processUserSpeech(callId: string, userText: string): Promise<string | null> {
  const conversation = activeVoiceConversations.get(callId);
  if (!conversation) return null;

  conversation.messages.push({ role: 'user', content: userText });
  conversation.turnCount++;

  // Apply sliding window to keep message array bounded
  if (conversation.messages.length > MAX_VOICE_MESSAGES + 1) {
    const systemMsg = conversation.messages[0]; // preserve system prompt
    conversation.messages = [systemMsg, ...conversation.messages.slice(-(MAX_VOICE_MESSAGES))];
  }

  try {
    const openai = getSharedOpenAI();

    // Voice context has no TurnContext — only static (non-MCP) tools are available.
    // OBO-dependent MCP tools require a TurnContext and are excluded here.
    const tools = getAllTools();

    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: conversation.messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      max_completion_tokens: 300, // Short for voice
    });

    const choice = response.choices[0];

    // Handle tool calls (single iteration for voice speed)
    if (choice.message.tool_calls?.length) {
      conversation.messages.push(choice.message as ChatCompletionMessageParam);

      const toolResults = await Promise.all(
        choice.message.tool_calls.map(async (toolCall) => {
          if (toolCall.type !== 'function') {
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: '{}' };
          }
          try {
            const params = JSON.parse(toolCall.function.arguments || '{}');
            const result = await executeTool(toolCall.function.name, params);
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
          } catch (parseErr) {
            return { role: 'tool' as const, tool_call_id: toolCall.id, content: JSON.stringify({ error: String(parseErr) }) };
          }
        })
      );
      conversation.messages.push(...toolResults);

      // Get the final spoken response
      const followUp = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
        messages: conversation.messages,
        max_completion_tokens: 300,
      });

      const spokenResponse = followUp.choices[0]?.message?.content?.trim();
      if (spokenResponse) {
        conversation.messages.push({ role: 'assistant', content: spokenResponse });
        await synthesizeAndPlay(callId, spokenResponse);
        return spokenResponse;
      }
    }

    // Direct response (no tool calls)
    const spokenResponse = choice.message.content?.trim() ?? null;
    if (spokenResponse) {
      conversation.messages.push({ role: 'assistant', content: spokenResponse });
      await synthesizeAndPlay(callId, spokenResponse);
    }

    return spokenResponse;
  } catch (err) {
    console.error('[VoiceAgent] processUserSpeech error:', err);
    const fallback = "Sorry, I couldn't process that. Could you repeat?";
    await synthesizeAndPlay(callId, fallback);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// End a voice conversation
// ---------------------------------------------------------------------------

export function endVoiceConversation(callId: string): { turnCount: number; durationSeconds: number } | null {
  const conversation = activeVoiceConversations.get(callId);
  if (!conversation) return null;

  const durationSeconds = Math.floor(
    (Date.now() - new Date(conversation.startedAt).getTime()) / 1000
  );

  activeVoiceConversations.delete(callId);
  console.log(`[VoiceAgent] Voice conversation ended: ${callId} (${conversation.turnCount} turns, ${durationSeconds}s)`);

  return { turnCount: conversation.turnCount, durationSeconds };
}

// ---------------------------------------------------------------------------
// Compose opening prompt based on call reason
// ---------------------------------------------------------------------------

async function composeOpeningPrompt(call: CassidyCall): Promise<string> {
  const openai = getSharedOpenAI();

  const contextSummary = Object.entries(call.context)
    .map(([key, val]) => `${key}: ${JSON.stringify(val)}`)
    .join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: VOICE_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `Compose an opening phone greeting for calling ${call.targetDisplayName}.
Reason for call: ${call.reason}

Context data:
${contextSummary}

Remember: This is a VOICE call. Keep it to 2-3 sentences. Be warm but get to the point.`,
        },
      ],
      max_completion_tokens: 200,
    });

    return response.choices[0]?.message?.content?.trim()
      ?? `Hi ${call.targetDisplayName}, this is Cassidy. I'm calling about ${call.reason}. Do you have a moment?`;
  } catch {
    return `Hi ${call.targetDisplayName}, this is Cassidy. I'm calling about ${call.reason}. Do you have a moment?`;
  }
}

// ---------------------------------------------------------------------------
// Check if voice calling should be escalated (used by proactive engine)
// ---------------------------------------------------------------------------

export function shouldEscalateToVoice(urgency: string, noResponseMinutes: number): boolean {
  // Escalate to voice call if:
  // 1. Critical urgency and no response to Teams message for 30+ minutes
  // 2. High urgency and no response for 60+ minutes
  if (urgency === 'critical' && noResponseMinutes >= 30) return true;
  if (urgency === 'high' && noResponseMinutes >= 60) return true;
  return false;
}
