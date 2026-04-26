// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ACS Call Automation <-> Foundry Realtime audio bridge.
 *
 * Flow:
 *   1. /voice/invite POSTs -> initiateOutboundTeamsCall(aadOid)
 *   2. ACS rings the user's Teams client (Teams Calls app pops a call card)
 *   3. User answers; ACS POSTs CallConnected to /api/calls/acs-events
 *   4. We start bidirectional media streaming -> WebSocket lands on
 *      /api/calls/acs-media/<callConnectionId>
 *   5. For each ACS audio frame (PCM16 mono 24kHz) we push it to the upstream
 *      Foundry Realtime WebSocket as input_audio_buffer.append.
 *   6. response.audio.delta from Foundry -> we push the audio back to ACS,
 *      which plays it into the Teams call. The user hears Cassidy.
 *
 * Sample rates aligned at 24 kHz on both sides (ACS supports 16k OR 24k;
 * Foundry Realtime requires 24k). No resampling needed.
 *
 * Auth:
 *   - ACS Call Automation: connection string from app setting
 *     ACS_CONNECTION_STRING (key-based; cleanest for the SDK).
 *   - Foundry Realtime: AAD bearer via shared `credential` (system MI).
 */

import {
  CallAutomationClient,
  type CallInvite,
  type CreateCallOptions,
  type MediaStreamingOptions,
  type CallConnection,
} from '@azure/communication-call-automation';
import { CommunicationIdentityClient } from '@azure/communication-identity';
import type { CommunicationUserIdentifier } from '@azure/communication-common';
import WebSocket, { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'http';
import { credential } from '../agent';
import { config } from '../featureConfig';
import { logger } from '../logger';
import { recordEvent } from '../agentEvents';

const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING || '';
// Optional: a pre-provisioned ACS user id to use as the source identity for
// outbound calls. If unset, we lazily provision one and cache it in-memory.
// Persisting it to an app setting (ACS_SOURCE_USER_ID) is recommended so it
// survives restarts — but in-memory still satisfies Teams interop's source
// identity requirement (clears 403#10391 for createCall → Teams user).
let ACS_SOURCE_USER_ID = process.env.ACS_SOURCE_USER_ID || '';
const PUBLIC_HOSTNAME =
  process.env.PUBLIC_HOSTNAME ||
  process.env.WEBSITE_HOSTNAME ||
  'cassidyopsagent-webapp.azurewebsites.net';
const VOICE_DEPLOYMENT = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || 'gpt-realtime-mini';
const VOICE_REGION = process.env.AZURE_OPENAI_REALTIME_REGION || 'eastus2';
const REALTIME_API_VERSION = '2025-04-01-preview';

let acsClient: CallAutomationClient | null = null;

/**
 * Lazily provision (or reuse) an ACS user identity that we use as the source
 * for outbound calls. ACS Call Automation → Teams interop requires a valid
 * `sourceIdentity` (CommunicationUserIdentifier) on the client; without one,
 * Teams flight-proxy returns 403#10391 (Forbidden) on createCall.
 */
async function ensureSourceIdentity(): Promise<CommunicationUserIdentifier> {
  if (ACS_SOURCE_USER_ID) {
    return { communicationUserId: ACS_SOURCE_USER_ID };
  }
  const idClient = new CommunicationIdentityClient(ACS_CONNECTION_STRING);
  const user = await idClient.createUser();
  ACS_SOURCE_USER_ID = user.communicationUserId;
  logger.info('ACS source identity provisioned', {
    module: 'voice.acs',
    communicationUserId: ACS_SOURCE_USER_ID,
    note: 'Set ACS_SOURCE_USER_ID app setting to persist across restarts',
  });
  return user;
}

async function getAcsClient(): Promise<CallAutomationClient> {
  if (acsClient) return acsClient;
  if (!ACS_CONNECTION_STRING) {
    throw new Error('ACS_CONNECTION_STRING app setting not configured');
  }
  const sourceIdentity = await ensureSourceIdentity();
  acsClient = new CallAutomationClient(ACS_CONNECTION_STRING, { sourceIdentity });
  return acsClient;
}

// Map callConnectionId -> per-call state so the events webhook and the media
// WebSocket can share metadata (greeting, requester name, started timestamp).
interface CallState {
  callConnectionId: string;
  targetTeamsOid: string;
  requestedBy?: string;
  instructions: string;
  voice: string;
  startedAt: number;
}
const activeCalls = new Map<string, CallState>();

/** Place an outbound voice call to a Microsoft Teams user. */
export async function initiateOutboundTeamsCall(opts: {
  teamsUserAadOid: string;
  requestedBy?: string;
  instructions?: string;
  voice?: string;
}): Promise<{ callConnectionId: string; serverCallId?: string }> {
  const client = await getAcsClient();
  const callbackUri = `https://${PUBLIC_HOSTNAME}/api/calls/acs-events`;
  const transportUri = `wss://${PUBLIC_HOSTNAME}/api/calls/acs-media`;

  // Foundry Realtime wants AAD; ACS Cognitive Services link wants the AOAI host
  const cognitiveServicesEndpoint = config.openAiEndpoint?.replace(/\/$/, '') || '';

  const invite: CallInvite = {
    targetParticipant: { microsoftTeamsUserId: opts.teamsUserAadOid },
    // Required for ACS-to-Teams interop calls — controls the toast on the
    // Teams client and is part of the source-identity payload that Teams
    // validates against the AllowedAcsResources policy.
    sourceDisplayName: opts.requestedBy
      ? `Cassidy (for ${opts.requestedBy})`
      : 'Cassidy — Autonomous Chief of Staff',
  };

  const mediaStreamingOptions: MediaStreamingOptions = {
    transportUrl: transportUri,
    transportType: 'websocket',
    contentType: 'audio',
    audioChannelType: 'mixed',
    startMediaStreaming: true,
    enableBidirectional: true,
    audioFormat: 'Pcm24KMono',
  };

  const createOptions: CreateCallOptions = {
    callIntelligenceOptions: cognitiveServicesEndpoint
      ? { cognitiveServicesEndpoint }
      : undefined,
    mediaStreamingOptions,
  };

  logger.info('ACS createCall — outbound to Teams user', {
    module: 'voice.acs',
    target: opts.teamsUserAadOid,
    callbackUri,
    transportUri,
    sourceDisplayName: invite.sourceDisplayName,
  });

  let result;
  try {
    result = await client.createCall(invite, callbackUri, createOptions);
  } catch (err: any) {
    // Surface the full ACS error response so 403#NNNNN sub-codes are visible.
    const detail = {
      module: 'voice.acs',
      target: opts.teamsUserAadOid,
      message: err?.message,
      statusCode: err?.statusCode,
      code: err?.code,
      requestId: err?.request?.requestId,
      body: err?.response?.bodyAsText || err?.details,
    };
    logger.error('ACS createCall failed', detail);
    recordEvent({
      kind: 'proactive.tick',
      label: `❌ ACS createCall failed (${err?.statusCode || '?'} ${err?.code || ''})`,
      status: 'error',
      data: detail,
    });
    throw err;
  }
  const callConnectionId = result.callConnectionProperties?.callConnectionId || '';
  const serverCallId = result.callConnectionProperties?.serverCallId;

  activeCalls.set(callConnectionId, {
    callConnectionId,
    targetTeamsOid: opts.teamsUserAadOid,
    requestedBy: opts.requestedBy,
    instructions:
      opts.instructions ||
      `You are Cassidy, the user's autonomous chief of staff. Greet ${
        opts.requestedBy || 'them'
      } warmly by first name. Be concise and direct. Offer to brief them on today's plan.`,
    voice: opts.voice || 'verse',
    startedAt: Date.now(),
  });

  recordEvent({
    kind: 'proactive.tick',
    label: `📞 ACS outbound call placed → Teams user`,
    status: 'ok',
    data: { module: 'voice.acs', callConnectionId, target: opts.teamsUserAadOid },
  });

  return { callConnectionId, serverCallId };
}

/**
 * Answer an inbound ACS call (delivered via Event Grid IncomingCall event).
 *
 * Wires the same Foundry Realtime media-streaming bridge as outbound calls —
 * the caller hears Cassidy speak as soon as the call connects.
 */
export async function answerInboundCall(opts: {
  incomingCallContext: string;
  callerId?: string;
  callerDisplayName?: string;
  instructions?: string;
  voice?: string;
}): Promise<{ callConnectionId: string }> {
  const client = await getAcsClient();
  const callbackUri = `https://${PUBLIC_HOSTNAME}/api/calls/acs-events`;
  const transportUri = `wss://${PUBLIC_HOSTNAME}/api/calls/acs-media`;
  const cognitiveServicesEndpoint = config.openAiEndpoint?.replace(/\/$/, '') || '';

  const mediaStreamingOptions: MediaStreamingOptions = {
    transportUrl: transportUri,
    transportType: 'websocket',
    contentType: 'audio',
    audioChannelType: 'mixed',
    startMediaStreaming: true,
    enableBidirectional: true,
    audioFormat: 'Pcm24KMono',
  };

  logger.info('ACS answerCall — inbound', {
    module: 'voice.acs',
    callerId: opts.callerId,
    callerDisplayName: opts.callerDisplayName,
    callbackUri,
    transportUri,
  });

  const result = await client.answerCall(opts.incomingCallContext, callbackUri, {
    callIntelligenceOptions: cognitiveServicesEndpoint ? { cognitiveServicesEndpoint } : undefined,
    mediaStreamingOptions,
  });
  const callConnectionId = result.callConnectionProperties?.callConnectionId || '';

  activeCalls.set(callConnectionId, {
    callConnectionId,
    targetTeamsOid: opts.callerId || 'inbound-caller',
    requestedBy: opts.callerDisplayName,
    instructions:
      opts.instructions ||
      `You are Cassidy, an autonomous chief of staff. ${
        opts.callerDisplayName ? `${opts.callerDisplayName} just called you. Greet them warmly by first name.` : 'Greet the caller warmly.'
      } Listen, then respond conversationally and concisely.`,
    voice: opts.voice || 'verse',
    startedAt: Date.now(),
  });

  recordEvent({
    kind: 'agent.message',
    label: `📞 Inbound Teams call answered — ${opts.callerDisplayName || opts.callerId || 'unknown'}`,
    status: 'ok',
    data: { module: 'voice.acs', callConnectionId, callerId: opts.callerId },
  });

  return { callConnectionId };
}

/**
 * Handle Event Grid SubscriptionValidation + IncomingCall events.
 *
 * Returns one of:
 *   - { validationResponse: '<code>' } if it was the EG handshake (caller MUST echo back as JSON)
 *   - { answered: true, callConnectionId } if Cassidy auto-answered an inbound call
 *   - { ignored: true, reason } if the event wasn't relevant
 */
export async function handleIncomingCallEvent(body: unknown): Promise<
  | { validationResponse: string }
  | { answered: true; callConnectionId: string }
  | { ignored: true; reason: string }
> {
  const events = Array.isArray(body) ? body : [body];
  for (const evRaw of events) {
    const ev = evRaw as {
      eventType?: string;
      data?: {
        validationCode?: string;
        incomingCallContext?: string;
        from?: { rawId?: string; displayName?: string; kind?: string };
        to?: { rawId?: string; kind?: string };
        callerDisplayName?: string;
      };
    };
    const type = ev.eventType || '';
    if (type === 'Microsoft.EventGrid.SubscriptionValidationEvent' && ev.data?.validationCode) {
      logger.info('Event Grid subscription validation handshake', {
        module: 'voice.acs',
        validationCode: ev.data.validationCode,
      });
      return { validationResponse: ev.data.validationCode };
    }
    if (type === 'Microsoft.Communication.IncomingCall' && ev.data?.incomingCallContext) {
      const callerDisplayName = ev.data.callerDisplayName || ev.data.from?.displayName;
      const callerId = ev.data.from?.rawId;
      try {
        const r = await answerInboundCall({
          incomingCallContext: ev.data.incomingCallContext,
          callerId,
          callerDisplayName,
        });
        return { answered: true, callConnectionId: r.callConnectionId };
      } catch (err: unknown) {
        logger.error('Failed to answer inbound call', {
          module: 'voice.acs',
          error: String(err),
          callerId,
        });
        return { ignored: true, reason: `answerCall failed: ${String(err)}` };
      }
    }
  }
  return { ignored: true, reason: 'no relevant event' };
}

/** ACS callback events arrive here as Cloud Events JSON arrays. */
export function handleAcsEvent(body: unknown): void {
  const events = Array.isArray(body) ? body : [body];
  for (const evRaw of events) {
    const ev = evRaw as {
      type?: string;
      data?: {
        callConnectionId?: string;
        resultInformation?: { code?: number; subCode?: number; message?: string };
      };
    };
    const type = ev.type || '(unknown)';
    const callConnectionId = ev.data?.callConnectionId;
    const resultInformation = ev.data?.resultInformation;
    logger.info('ACS callback event', {
      module: 'voice.acs',
      type,
      callConnectionId,
      resultInformation,
      rawData: ev.data,
    });

    if (type.endsWith('CallConnected') && callConnectionId) {
      recordEvent({
        kind: 'agent.message',
        label: '📞 Teams call connected — Cassidy speaking',
        status: 'ok',
        data: { module: 'voice.acs', callConnectionId },
      });
    } else if (type.endsWith('CallDisconnected') && callConnectionId) {
      const state = activeCalls.get(callConnectionId);
      const durationSec = state ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      activeCalls.delete(callConnectionId);
      recordEvent({
        kind: 'agent.message',
        label: `📞 Teams call ended (${durationSec}s)`,
        status: 'ok',
        data: { module: 'voice.acs', callConnectionId, durationSec, resultInformation },
      });
    } else if (type.endsWith('CreateCallFailed') || type.endsWith('AddParticipantFailed')) {
      logger.warn('ACS call failed', { module: 'voice.acs', type, callConnectionId, resultInformation, rawData: ev.data });
      recordEvent({
        kind: 'agent.message',
        label: `⚠️ ACS call failed: ${type} — ${resultInformation?.message || 'no detail'} (code ${resultInformation?.code || '?'}/sub ${resultInformation?.subCode || '?'})`,
        status: 'error',
        data: { module: 'voice.acs', event: ev },
      });
    }
  }
}

/**
 * Attach a WebSocket server to the existing HTTP server for ACS media streaming.
 * ACS connects to wss://<host>/api/calls/acs-media — we read PCM frames and
 * forward to Foundry Realtime, then pipe Realtime audio.delta back to ACS.
 */
export function attachAcsMediaWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/api/calls/acs-media')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAcsMediaSocket(ws).catch((err: unknown) => {
        logger.error('ACS media socket handler crashed', {
          module: 'voice.acs',
          error: String(err),
        });
        try { ws.close(); } catch { /* ignore */ }
      });
    });
  });

  logger.info('ACS media WebSocket attached', {
    module: 'voice.acs',
    path: '/api/calls/acs-media',
  });
}

async function handleAcsMediaSocket(acsWs: WebSocket): Promise<void> {
  logger.info('ACS media WS opened', { module: 'voice.acs' });

  // The first ACS message contains the call metadata; we stash it but don't
  // need it to start the upstream Realtime connection.
  let callConnectionId: string | undefined;
  let realtimeWs: WebSocket | null = null;
  let realtimeReady = false;
  const pendingAudio: string[] = [];

  // --- Open upstream Foundry Realtime WS ---
  try {
    const tokenResp = await credential.getToken('https://cognitiveservices.azure.com/.default');
    if (!tokenResp?.token) throw new Error('No AAD token for Foundry Realtime');

    // Use the Azure OpenAI resource host for AAD-authenticated realtime WS.
    // The `realtimeapi-preview.ai.azure.com` host is only for WebRTC + ephemeral
    // keys (returns 401 on AAD bearer). The AOAI resource accepts AAD on
    // /openai/realtime?deployment=...
    const aoaiHost = (config.openAiEndpoint || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!aoaiHost) throw new Error('AZURE_OPENAI_ENDPOINT not configured for Realtime WS');
    const realtimeUrl = `wss://${aoaiHost}/openai/realtime?deployment=${encodeURIComponent(
      VOICE_DEPLOYMENT,
    )}&api-version=${REALTIME_API_VERSION}`;

    logger.info('Foundry Realtime WS connecting', { module: 'voice.acs', url: realtimeUrl });
    realtimeWs = new WebSocket(realtimeUrl, {
      headers: { Authorization: `Bearer ${tokenResp.token}` },
    });

    realtimeWs.on('open', () => {
      logger.info('Foundry Realtime WS open', { module: 'voice.acs' });
      // Initial session.update to set audio formats and instructions
      const state = callConnectionId ? activeCalls.get(callConnectionId) : undefined;
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          voice: state?.voice || 'verse',
          instructions:
            state?.instructions ||
            'You are Cassidy, an autonomous chief of staff. Greet the caller warmly and concisely. Wait for them to speak.',
          turn_detection: { type: 'server_vad' },
        },
      };
      realtimeWs?.send(JSON.stringify(sessionUpdate));
      realtimeReady = true;
      // Drain any audio that arrived before the upstream was ready
      while (pendingAudio.length) {
        const audio = pendingAudio.shift()!;
        realtimeWs?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      }
      // Greet first
      realtimeWs?.send(
        JSON.stringify({ type: 'response.create', response: { modalities: ['audio', 'text'] } }),
      );
    });

    let audioDeltaCount = 0;
    realtimeWs.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'response.audio.delta' && typeof msg.delta === 'string') {
          audioDeltaCount++;
          if (audioDeltaCount === 1 || audioDeltaCount % 50 === 0) {
            logger.info('Foundry → ACS audio delta', {
              module: 'voice.acs',
              count: audioDeltaCount,
              bytes: msg.delta.length,
            });
          }
          // Send audio back into the ACS call
          const envelope = {
            kind: 'AudioData',
            audioData: { data: msg.delta },
          };
          if (acsWs.readyState === WebSocket.OPEN) acsWs.send(JSON.stringify(envelope));
        } else if (msg.type === 'input_audio_buffer.speech_started') {
          // Barge-in: tell ACS to stop playback
          if (acsWs.readyState === WebSocket.OPEN) {
            acsWs.send(JSON.stringify({ kind: 'StopAudio', stopAudio: {} }));
          }
        } else if (msg.type === 'error') {
          logger.error('Foundry Realtime server error', {
            module: 'voice.acs',
            error: msg.error,
          });
        } else if (
          msg.type === 'session.created' ||
          msg.type === 'session.updated' ||
          msg.type === 'response.created' ||
          msg.type === 'response.done' ||
          msg.type === 'response.cancelled' ||
          msg.type === 'response.audio.done' ||
          msg.type === 'response.audio_transcript.done'
        ) {
          logger.info('Foundry Realtime event', {
            module: 'voice.acs',
            type: msg.type,
            transcript: msg.transcript ? String(msg.transcript).slice(0, 200) : undefined,
            status: msg.response?.status,
            statusDetails: msg.response?.status_details,
          });
        }
      } catch {
        /* ignore parse errors on binary frames */
      }
    });

    realtimeWs.on('close', () => {
      logger.info('Foundry Realtime WS closed', { module: 'voice.acs' });
      try { acsWs.close(); } catch { /* ignore */ }
    });
    realtimeWs.on('error', (err: Error) => {
      logger.error('Foundry Realtime WS error', { module: 'voice.acs', error: String(err) });
    });
  } catch (err: unknown) {
    logger.error('Failed to open Foundry Realtime WS', {
      module: 'voice.acs',
      error: String(err),
    });
    try { acsWs.close(); } catch { /* ignore */ }
    return;
  }

  // --- Read ACS frames ---
  acsWs.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        kind?: string;
        audioData?: { data?: string };
        audioMetadata?: { mediaSubscriptionId?: string };
      };
      if (msg.kind === 'AudioData' && msg.audioData?.data) {
        if (realtimeReady && realtimeWs?.readyState === WebSocket.OPEN) {
          realtimeWs.send(
            JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audioData.data }),
          );
        } else {
          pendingAudio.push(msg.audioData.data);
        }
      } else if (msg.kind === 'AudioMetadata' && msg.audioMetadata?.mediaSubscriptionId) {
        callConnectionId = msg.audioMetadata.mediaSubscriptionId;
        logger.info('ACS media metadata', {
          module: 'voice.acs',
          mediaSubscriptionId: callConnectionId,
        });
      }
    } catch {
      /* ignore non-JSON */
    }
  });

  acsWs.on('close', () => {
    logger.info('ACS media WS closed', { module: 'voice.acs' });
    try { realtimeWs?.close(); } catch { /* ignore */ }
  });
  acsWs.on('error', (err: Error) => {
    logger.warn('ACS media WS error', { module: 'voice.acs', error: String(err) });
  });
}

export function isAcsConfigured(): boolean {
  return Boolean(ACS_CONNECTION_STRING);
}

/** Snapshot of active server-side bridged calls (for diagnostics). */
export function getActiveCallSnapshot(): Array<{
  callConnectionId: string;
  targetTeamsOid: string;
  requestedBy?: string;
  voice: string;
  startedAt: number;
  ageSec: number;
}> {
  const now = Date.now();
  return Array.from(activeCalls.values()).map((c) => ({
    callConnectionId: c.callConnectionId,
    targetTeamsOid: c.targetTeamsOid,
    requestedBy: c.requestedBy,
    voice: c.voice,
    startedAt: c.startedAt,
    ageSec: Math.round((now - c.startedAt) / 1000),
  }));
}

// Re-export for tests / diagnostics
export const _internal = { activeCalls };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _UnusedConn = CallConnection;
