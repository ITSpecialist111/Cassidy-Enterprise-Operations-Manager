// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Call Manager — manages Teams voice calls via Microsoft Graph
// Communications API. Cassidy can initiate outbound calls to users when
// critical operational situations require immediate attention.
// ---------------------------------------------------------------------------

import { getGraphToken } from '../auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallState = 'creating' | 'ringing' | 'connected' | 'terminating' | 'terminated' | 'failed';

export interface CassidyCall {
  callId: string;
  targetUserId: string;
  targetDisplayName: string;
  state: CallState;
  reason: string;
  startedAt: string;
  connectedAt?: string;
  endedAt?: string;
  context: Record<string, unknown>;
}

interface GraphCallResponse {
  id: string;
  state: string;
  resultInfo?: { code: number; subcode: number; message: string };
}

// Active calls tracked in memory (calls are ephemeral)
const activeCalls = new Map<string, CassidyCall>();

// Reap stale calls that never received a termination webhook (4-hour TTL)
const CALL_TTL_MS = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, call] of activeCalls) {
    if (now - new Date(call.startedAt).getTime() > CALL_TTL_MS) {
      console.warn(`[CallManager] Reaping stale call: ${id} (started ${call.startedAt})`);
      activeCalls.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Bot's service URL for callback notifications
const CALLBACK_URL = process.env.BASE_URL
  ? `${process.env.BASE_URL}/api/calls/notifications`
  : 'https://cassidyopsagent-webapp.azurewebsites.net/api/calls/notifications';

const BOT_APP_ID = process.env.MicrosoftAppId ?? '';

// ---------------------------------------------------------------------------
// Initiate an outbound call via Graph Communications API
// ---------------------------------------------------------------------------

export async function initiateCall(params: {
  targetUserId: string;
  targetDisplayName: string;
  reason: string;
  context?: Record<string, unknown>;
}): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    const token = await getGraphToken();

    const callBody = {
      '@odata.type': '#microsoft.graph.call',
      callbackUri: CALLBACK_URL,
      targets: [
        {
          '@odata.type': '#microsoft.graph.invitationParticipantInfo',
          identity: {
            '@odata.type': '#microsoft.graph.identitySet',
            user: {
              '@odata.type': '#microsoft.graph.identity',
              id: params.targetUserId,
              displayName: params.targetDisplayName,
            },
          },
        },
      ],
      requestedModalities: ['audio'],
      mediaConfig: {
        '@odata.type': '#microsoft.graph.serviceHostedMediaConfig',
      },
      source: {
        '@odata.type': '#microsoft.graph.participantInfo',
        identity: {
          '@odata.type': '#microsoft.graph.identitySet',
          application: {
            '@odata.type': '#microsoft.graph.identity',
            id: BOT_APP_ID,
            displayName: 'Cassidy',
          },
        },
      },
      tenantId: process.env.MicrosoftAppTenantId,
    };

    const res = await fetch('https://graph.microsoft.com/v1.0/communications/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(callBody),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[CallManager] Graph call initiation failed (${res.status}):`, text);
      return { success: false, error: `Graph API ${res.status}: ${text}` };
    }

    const data = await res.json() as GraphCallResponse;
    const call: CassidyCall = {
      callId: data.id,
      targetUserId: params.targetUserId,
      targetDisplayName: params.targetDisplayName,
      state: 'creating',
      reason: params.reason,
      startedAt: new Date().toISOString(),
      context: params.context ?? {},
    };

    activeCalls.set(data.id, call);
    console.log(`[CallManager] Call initiated to ${params.targetDisplayName} (${data.id}) — reason: ${params.reason}`);
    return { success: true, callId: data.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[CallManager] initiateCall error:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// End a call
// ---------------------------------------------------------------------------

export async function endCall(callId: string): Promise<{ success: boolean; error?: string }> {
  const call = activeCalls.get(callId);
  if (!call) return { success: false, error: `No active call with ID ${callId}` };

  try {
    const token = await getGraphToken();

    await fetch(`https://graph.microsoft.com/v1.0/communications/calls/${callId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    call.state = 'terminated';
    call.endedAt = new Date().toISOString();
    activeCalls.delete(callId);

    console.log(`[CallManager] Call ended: ${callId}`);
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[CallManager] endCall error:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Transfer a call to a human
// ---------------------------------------------------------------------------

export async function transferCall(callId: string, transferToUserId: string): Promise<{ success: boolean; error?: string }> {
  const call = activeCalls.get(callId);
  if (!call) return { success: false, error: `No active call with ID ${callId}` };

  try {
    const token = await getGraphToken();

    const transferBody = {
      transferTarget: {
        '@odata.type': '#microsoft.graph.invitationParticipantInfo',
        identity: {
          '@odata.type': '#microsoft.graph.identitySet',
          user: {
            '@odata.type': '#microsoft.graph.identity',
            id: transferToUserId,
          },
        },
      },
    };

    const res = await fetch(`https://graph.microsoft.com/v1.0/communications/calls/${callId}/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(transferBody),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Transfer failed: ${text}` };
    }

    console.log(`[CallManager] Call ${callId} transferred to ${transferToUserId}`);
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Handle call notification webhooks from Graph
// ---------------------------------------------------------------------------

export interface CallNotification {
  value: Array<{
    '@odata.type'?: string;
    changeType: string;
    resourceUrl: string;
    resourceData?: {
      '@odata.type'?: string;
      id?: string;
      state?: string;
      resultInfo?: { code: number; subcode: number; message: string };
      [key: string]: unknown;
    };
  }>;
}

export async function handleCallNotification(notification: CallNotification): Promise<{
  callId?: string;
  state?: CallState;
  action?: 'play_prompt' | 'listen' | 'end' | 'none';
}> {
  for (const item of notification.value) {
    const callId = item.resourceData?.id;
    if (!callId) continue;

    const call = activeCalls.get(callId);
    if (!call) continue;

    const newState = item.resourceData?.state as CallState | undefined;
    if (newState) {
      call.state = newState;

      if (newState === 'connected' && !call.connectedAt) {
        call.connectedAt = new Date().toISOString();
        console.log(`[CallManager] Call connected: ${callId} -> ${call.targetDisplayName}`);
        // Call connected — the voice agent should start speaking
        return { callId, state: newState, action: 'play_prompt' };
      }

      if (newState === 'terminated') {
        call.endedAt = new Date().toISOString();
        activeCalls.delete(callId);
        console.log(`[CallManager] Call terminated: ${callId}`);
        return { callId, state: newState, action: 'end' };
      }
    }
  }

  return { action: 'none' };
}

// ---------------------------------------------------------------------------
// Play audio prompt in a call (TTS via Graph media)
// ---------------------------------------------------------------------------

export async function playPromptInCall(callId: string, text: string): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getGraphToken();

    // TODO(Phase 4 enhancement): Generate audio via Azure Speech SDK, then stream
    // as mediaInfo.uri. For MVP, we attempt Graph's media prompt and fall back to
    // posting the text to the user's Teams chat if media play is unavailable.
    const textPlayBody = {
      clientContext: `cassidy_tts_${Date.now()}`,
      prompts: [
        {
          '@odata.type': '#microsoft.graph.mediaPrompt',
          loop: 1,
        },
      ],
    };

    console.log(`[CallManager] Play prompt in call ${callId}: "${text.slice(0, 100)}..."`);

    const res = await fetch(`https://graph.microsoft.com/v1.0/communications/calls/${callId}/playPrompt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(textPlayBody),
    });

    if (!res.ok) {
      // Expected to fail in MVP — fall back to chat message
      console.warn(`[CallManager] playPrompt not available (${res.status}), using chat fallback`);
      return { success: false, error: 'Media play not available — use chat fallback' };
    }

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function getActiveCall(callId: string): CassidyCall | null {
  return activeCalls.get(callId) ?? null;
}

export function getActiveCalls(): CassidyCall[] {
  return Array.from(activeCalls.values());
}

export function getCallByUserId(userId: string): CassidyCall | null {
  for (const call of activeCalls.values()) {
    if (call.targetUserId === userId) return call;
  }
  return null;
}
