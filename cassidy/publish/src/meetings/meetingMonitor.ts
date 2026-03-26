// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Meeting Monitor — manages Microsoft Graph subscriptions for meeting
// transcripts and processes transcript segments in real time.
// When someone says "Cassidy" in a meeting, it detects the mention,
// formulates a response via GPT-5, and posts to the meeting chat.
// ---------------------------------------------------------------------------

import { getGraphToken, getSharedOpenAI } from '../auth';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import {
  startMeetingSession,
  endMeetingSession,
  addTranscriptSegment,
  getTranscriptAsText,
  recordCassidyResponse,
  addActionItem,
  addTopic,
  getMeetingSession,
  type TranscriptSegment,
} from './meetingContext';
import { detectMention, isActionableMention } from './nameDetection';
import { CASSIDY_SYSTEM_PROMPT } from '../persona';
import { getAllTools, executeTool } from '../tools/index';

// ---------------------------------------------------------------------------
// Graph subscription management
// ---------------------------------------------------------------------------

interface GraphSubscription {
  id: string;
  meetingId: string;
  resource: string;
  expirationDateTime: string;
}

const activeSubscriptions = new Map<string, GraphSubscription>();

// Sequence tracking per meeting
const sequenceCounters = new Map<string, number>();

// Reap expired subscriptions that weren't explicitly unsubscribed (30-min sweep)
setInterval(() => {
  const now = Date.now();
  for (const [meetingId, sub] of activeSubscriptions) {
    if (new Date(sub.expirationDateTime).getTime() < now) {
      console.log(`[MeetingMonitor] Reaping expired subscription for ${meetingId}`);
      activeSubscriptions.delete(meetingId);
      sequenceCounters.delete(meetingId);
    }
  }
}, 30 * 60 * 1000);

/**
 * Subscribe to transcript events for a meeting via Microsoft Graph.
 * Requires OnlineMeetingTranscript.Read.All permission.
 */
export async function subscribeToMeeting(params: {
  meetingId: string;
  organizerName?: string;
  organizerEmail?: string;
  chatId?: string;
  webhookUrl: string;
}): Promise<{ success: boolean; subscriptionId?: string; error?: string }> {
  try {
    const token = await getGraphToken();

    const subscriptionBody = {
      changeType: 'created',
      notificationUrl: params.webhookUrl,
      resource: `/communications/onlineMeetings/${params.meetingId}/transcripts`,
      expirationDateTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), // 4 hours
      clientState: `cassidy_meeting_${params.meetingId}`,
    };

    const res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(subscriptionBody),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[MeetingMonitor] Graph subscription failed (${res.status}):`, text);
      return { success: false, error: `Graph API ${res.status}: ${text}` };
    }

    const data = await res.json() as { id: string; expirationDateTime: string };

    const subscription: GraphSubscription = {
      id: data.id,
      meetingId: params.meetingId,
      resource: subscriptionBody.resource,
      expirationDateTime: data.expirationDateTime,
    };
    activeSubscriptions.set(params.meetingId, subscription);

    // Start the in-memory meeting session
    startMeetingSession({
      meetingId: params.meetingId,
      organizerName: params.organizerName,
      organizerEmail: params.organizerEmail,
      chatId: params.chatId,
    });

    sequenceCounters.set(params.meetingId, 0);

    console.log(`[MeetingMonitor] Subscribed to meeting ${params.meetingId} (sub: ${data.id})`);
    return { success: true, subscriptionId: data.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[MeetingMonitor] subscribeToMeeting error:`, error);
    return { success: false, error };
  }
}

/**
 * Unsubscribe from a meeting's transcript events and end the session.
 */
export async function unsubscribeFromMeeting(meetingId: string): Promise<{ success: boolean; error?: string }> {
  const sub = activeSubscriptions.get(meetingId);
  if (!sub) {
    return { success: false, error: `No active subscription for meeting ${meetingId}` };
  }

  try {
    const token = await getGraphToken();

    await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    activeSubscriptions.delete(meetingId);
    sequenceCounters.delete(meetingId);
    const session = endMeetingSession(meetingId);

    console.log(`[MeetingMonitor] Unsubscribed from meeting ${meetingId} (${session?.actionItems.length ?? 0} action items)`);
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[MeetingMonitor] unsubscribeFromMeeting error:`, error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Webhook handler — called by Express when Graph sends a notification
// ---------------------------------------------------------------------------

export interface GraphWebhookNotification {
  value: Array<{
    subscriptionId: string;
    changeType: string;
    clientState: string;
    resource: string;
    resourceData?: {
      id?: string;
      '@odata.type'?: string;
      [key: string]: unknown;
    };
  }>;
}

/**
 * Process a Graph webhook notification for meeting transcripts.
 * Returns a chat message to post if Cassidy was mentioned, or null.
 */
export async function handleTranscriptWebhook(
  notification: GraphWebhookNotification,
): Promise<Array<{ meetingId: string; chatId: string; message: string }>> {
  const responses: Array<{ meetingId: string; chatId: string; message: string }> = [];

  for (const item of notification.value) {
    // Extract meeting ID from clientState
    const meetingId = item.clientState?.replace('cassidy_meeting_', '');
    if (!meetingId) continue;

    const session = getMeetingSession(meetingId);
    if (!session || !session.isActive) continue;

    // Fetch the actual transcript content from Graph
    const segments = await fetchTranscriptContent(item.resource);
    if (segments.length === 0) continue;

    for (const segment of segments) {
      addTranscriptSegment(meetingId, segment);

      // Detect Cassidy mentions
      const mention = detectMention(segment.text);
      if (isActionableMention(mention)) {
        console.log(`[MeetingMonitor] Cassidy mentioned in meeting ${meetingId} by ${segment.speaker}: "${segment.text}"`);

        // Compose a response using GPT-5 with meeting context
        const response = await composeMeetingResponse(meetingId, segment, mention.extractedIntent);
        if (response && session.chatId) {
          responses.push({
            meetingId,
            chatId: session.chatId,
            message: response,
          });
          recordCassidyResponse(meetingId);
        }
      }

      // Detect action items (simple heuristic)
      if (detectActionItemPhrase(segment.text)) {
        const actionDesc = extractActionDescription(segment.text);
        addActionItem(meetingId, {
          description: actionDesc,
          source: segment.speaker,
          detectedAt: segment.timestamp,
        });
      }

      // Detect topic changes (simple heuristic)
      const topic = detectTopicPhrase(segment.text);
      if (topic) {
        addTopic(meetingId, topic);
      }
    }
  }

  return responses;
}

// ---------------------------------------------------------------------------
// Fetch transcript content from Graph
// ---------------------------------------------------------------------------

async function fetchTranscriptContent(resource: string): Promise<TranscriptSegment[]> {
  try {
    const token = await getGraphToken();

    const url = `https://graph.microsoft.com/v1.0/${resource}/content`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error(`[MeetingMonitor] Failed to fetch transcript: ${res.status}`);
      return [];
    }

    // Graph returns transcript in VTT-like format or JSON depending on API version
    const data = await res.json() as {
      entries?: Array<{
        speakerDisplayName?: string;
        text?: string;
        timestamp?: string;
      }>;
    };

    if (!data.entries) return [];

    // Get the meeting ID from the resource path for sequence tracking
    const meetingMatch = resource.match(/onlineMeetings\/([^/]+)/);
    const meetingId = meetingMatch?.[1] ?? 'unknown';
    const counter = sequenceCounters.get(meetingId) ?? 0;

    return data.entries.map((entry, i) => {
      const seq = counter + i + 1;
      sequenceCounters.set(meetingId, seq);
      return {
        speaker: entry.speakerDisplayName ?? 'Unknown',
        text: entry.text ?? '',
        timestamp: entry.timestamp ?? new Date().toISOString(),
        sequenceNumber: seq,
      };
    });
  } catch (err) {
    console.error('[MeetingMonitor] fetchTranscriptContent error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Compose a response using GPT-5 with meeting context
// ---------------------------------------------------------------------------

async function composeMeetingResponse(
  meetingId: string,
  triggerSegment: TranscriptSegment,
  intent: string,
): Promise<string | null> {
  try {
    const openai = getSharedOpenAI();

    const recentTranscript = getTranscriptAsText(meetingId, 15);

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      {
        role: 'system',
        content: `${CASSIDY_SYSTEM_PROMPT}

## Meeting Context
You are currently participating in a live meeting. Someone just mentioned your name.
CRITICAL RULES for meeting responses:
- Be **concise** — 2-4 sentences max. This is a live meeting, not an email.
- Respond like a colleague speaking up in a meeting — natural, direct, helpful.
- If data is needed, use tools to get REAL data and include the key numbers.
- Do NOT ramble or over-explain. Get to the point.
- Use bold (**text**) for key numbers and names.
- If you can't answer immediately, say "Let me look that up" and provide what you have.`,
      },
      {
        role: 'user',
        content: `Meeting transcript (recent):
${recentTranscript}

---
${triggerSegment.speaker} just said: "${triggerSegment.text}"
Detected intent: ${intent}

Respond to what was asked. Be brief and meeting-appropriate.`,
      },
    ];

    // Meeting context has no TurnContext — only static (non-MCP) tools are available.
    // OBO-dependent MCP tools require a TurnContext and are excluded here.
    const tools = getAllTools();

    // Single-turn tool call + response (meetings need speed)
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      max_completion_tokens: 500,
    });

    const choice = response.choices[0];

    // If tools were called, execute them and get a final response
    if (choice.message.tool_calls?.length) {
      const extendedMessages: ChatCompletionMessageParam[] = [...messages, choice.message];

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
      extendedMessages.push(...toolResults);

      // Get the final response
      const followUp = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
        messages: extendedMessages,
        max_completion_tokens: 500,
      });

      return followUp.choices[0]?.message?.content?.trim() ?? null;
    }

    return choice.message.content?.trim() ?? null;
  } catch (err) {
    console.error('[MeetingMonitor] composeMeetingResponse error:', err);
    return `Sorry, I heard my name but hit an error looking that up. I'll follow up after the meeting.`;
  }
}

// ---------------------------------------------------------------------------
// Post response to meeting chat via Graph
// ---------------------------------------------------------------------------

export async function postToMeetingChat(chatId: string, message: string): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getGraphToken();

    const res = await fetch(`https://graph.microsoft.com/v1.0/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: {
          contentType: 'html',
          content: message,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[MeetingMonitor] postToMeetingChat failed (${res.status}):`, text);
      return { success: false, error: text };
    }

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Simple heuristic detectors
// ---------------------------------------------------------------------------

function extractActionDescription(text: string): string {
  // Extract just the action verb + object from a longer statement
  const actionMatch = text.match(
    /(?:please|can you|could you|i'll|i will|we should|we need to|let's)\s+([^.!?]+)/i
  );
  return actionMatch?.[1]?.trim() ?? text.slice(0, 150);
}

function detectActionItemPhrase(text: string): boolean {
  const patterns = [
    /\b(?:action item|todo|to-do)\b/i,
    /\b(?:can you|could you|please)\s+(?:make sure|ensure|follow up|create|schedule|send|update)\b/i,
    /\bI(?:'ll|'ll| will)\s+(?:do|handle|take care of|follow up on)\b/i,
    /\b(?:let's|we need to|we should|someone needs to)\s+/i,
    /\bby\s+(?:end of|next|this|Monday|Tuesday|Wednesday|Thursday|Friday)\b/i,
  ];
  return patterns.some(p => p.test(text));
}

function detectTopicPhrase(text: string): string | null {
  const patterns = [
    /\b(?:let's talk about|moving on to|next topic|let's discuss|regarding|about the)\s+(.{5,50})/i,
    /\b(?:agenda item|next up)\s*[:-]?\s*(.{5,50})/i,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[1].trim().replace(/[.!?]+$/, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function getActiveSubscriptions(): Array<{ meetingId: string; subscriptionId: string; expires: string }> {
  return Array.from(activeSubscriptions.entries()).map(([meetingId, sub]) => ({
    meetingId,
    subscriptionId: sub.id,
    expires: sub.expirationDateTime,
  }));
}

export function isMonitoringMeeting(meetingId: string): boolean {
  return activeSubscriptions.has(meetingId);
}
