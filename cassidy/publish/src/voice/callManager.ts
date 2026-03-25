// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Call Manager — manages Teams voice calls via Microsoft Graph
// Communications API. Cassidy can initiate outbound calls to users when
// critical operational situations require immediate attention.
// ---------------------------------------------------------------------------

import { getGraphToken } from '../auth';
import { sharedCredential } from '../auth';

// Storage account for hosting TTS audio blobs (same account as Table Storage)
const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT ?? 'cassidyschedsa';
const AUDIO_CONTAINER = 'cassidy-audio';

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
// Upload audio to Azure Blob Storage (REST API — no SDK dependency)
// Returns a publicly accessible URL for the audio file.
// ---------------------------------------------------------------------------

let containerEnsured = false;

async function ensureAudioContainer(): Promise<void> {
  if (containerEnsured) return;
  try {
    const tokenResult = await sharedCredential.getToken('https://storage.azure.com/.default');
    const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${AUDIO_CONTAINER}?restype=container`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        'x-ms-version': '2023-11-03',
      },
    });
    // 201 = created, 409 = already exists — both are fine
    if (res.ok || res.status === 409) {
      containerEnsured = true;
      console.log(`[CallManager] Audio container ensured: ${AUDIO_CONTAINER}`);
    } else {
      console.warn(`[CallManager] Container creation returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.warn('[CallManager] Failed to ensure audio container:', err);
  }
}

async function uploadAudioBlob(audioData: Buffer, blobName: string): Promise<string | null> {
  try {
    await ensureAudioContainer();
    const tokenResult = await sharedCredential.getToken('https://storage.azure.com/.default');
    const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${AUDIO_CONTAINER}/${blobName}`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        'x-ms-version': '2023-11-03',
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioData.length),
      },
      body: new Uint8Array(audioData),
    });

    if (!res.ok) {
      console.error(`[CallManager] Blob upload failed (${res.status}): ${await res.text()}`);
      return null;
    }

    console.log(`[CallManager] Audio uploaded: ${blobName} (${audioData.length} bytes)`);
    return url;
  } catch (err) {
    console.error('[CallManager] uploadAudioBlob error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Play audio prompt in a call (TTS via Graph media)
// ---------------------------------------------------------------------------

export async function playPromptInCall(
  callId: string,
  text: string,
  audioData?: Buffer,
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await getGraphToken();

    // If we have synthesized audio, upload it and use the URI in the media prompt
    let audioUri: string | null = null;
    if (audioData && audioData.length > 0) {
      const blobName = `tts-${callId}-${Date.now()}.mp3`;
      audioUri = await uploadAudioBlob(audioData, blobName);
    }

    if (audioUri) {
      // Full audio prompt with hosted URI
      const audioPlayBody = {
        clientContext: `cassidy_tts_${Date.now()}`,
        prompts: [
          {
            '@odata.type': '#microsoft.graph.mediaPrompt',
            mediaInfo: {
              '@odata.type': '#microsoft.graph.mediaInfo',
              uri: audioUri,
              resourceId: `cassidy-audio-${Date.now()}`,
            },
            loop: 1,
          },
        ],
      };

      console.log(`[CallManager] Playing audio in call ${callId}: "${text.slice(0, 80)}..." (${audioData!.length} bytes)`);

      const res = await fetch(`https://graph.microsoft.com/v1.0/communications/calls/${callId}/playPrompt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(audioPlayBody),
      });

      if (res.ok) {
        return { success: true };
      }

      // If audio play failed, log and fall through to text fallback
      console.warn(`[CallManager] Audio playPrompt failed (${res.status}): ${await res.text()}`);
    }

    // Fallback: send the text as a chat message to the call participant
    const call = activeCalls.get(callId);
    if (call) {
      console.warn(`[CallManager] Using chat fallback for call ${callId} to ${call.targetDisplayName}`);
      // We can't send a chat message from here without a conversation reference,
      // but we log clearly so the voiceAgent can handle the fallback
    }

    return { success: false, error: audioUri ? 'Graph playPrompt rejected audio' : 'No audio data — cannot play prompt' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[CallManager] playPromptInCall error:', error);
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
