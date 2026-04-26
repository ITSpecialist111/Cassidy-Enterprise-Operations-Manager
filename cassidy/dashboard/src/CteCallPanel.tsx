// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// CTE (Custom Teams Endpoint) call panel — Cassidy as a real Teams user.
//
// Two operating modes:
//
//   1. "Browser mic" — pipes the browser microphone to the Teams callee.
//      Useful for verifying the federation path end-to-end.
//
//   2. "AI voice (Foundry Realtime)" — Cassidy actually speaks. A second
//      WebRTC peer connection to Azure OpenAI Realtime is opened in
//      parallel; its inbound audio (GPT TTS) becomes the ACS uplink, and
//      the ACS downlink (caller's voice) becomes the Realtime uplink, so
//      the model hears the caller and responds in real time.
//
//      Bridge wiring:
//          ┌──── Foundry Realtime PC ────┐
//          │                              │
//   caller │  send (caller → AI)          │ ← ACS RemoteAudio (caller voice)
//   speech │                              │
//          │  recv (AI TTS)               │ → ACS LocalAudioStream (Cassidy)
//          └──────────────────────────────┘
//
//      The dashboard never plays the AI track locally, and the local mic
//      is never wired into ACS — so there is no echo loop.

import { useEffect, useRef, useState } from 'react';
import {
  CallClient,
  LocalAudioStream,
  type TeamsCall,
  type TeamsCallAgent,
  type RemoteAudioStream,
} from '@azure/communication-calling';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';

type CallStatus = 'idle' | 'minting' | 'connecting' | 'ringing' | 'connected' | 'ending' | 'error';

interface CteTokenResponse {
  token: string;
  expiresOn: string;
  userObjectId: string;
  defaultTargetTeamsUserId: string | null;
}

interface RealtimeSession {
  sessionId: string;
  ephemeralKey: string;
  webrtcUrl: string;
  deployment: string;
}

export function CteCallPanel() {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>('');
  const [callerObjectId, setCallerObjectId] = useState<string>('');
  const [defaultTarget, setDefaultTarget] = useState<string>('');
  const [callState, setCallState] = useState<string>('');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [remoteCount, setRemoteCount] = useState<number>(0);
  const [useAi, setUseAi] = useState<boolean>(true);
  const [bridgeState, setBridgeState] = useState<string>('');
  const [serverMode, setServerMode] = useState<boolean>(false);
  const [serverCallId, setServerCallId] = useState<string>('');

  const clientRef = useRef<CallClient | null>(null);
  const agentRef = useRef<TeamsCallAgent | null>(null);
  const callRef = useRef<TeamsCall | null>(null);

  // AI-bridge resources
  const realtimePcRef = useRef<RTCPeerConnection | null>(null);
  const realtimeDcRef = useRef<RTCDataChannel | null>(null);
  const aiAudioStreamRef = useRef<MediaStream | null>(null);
  const callerStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const silentTrackRef = useRef<MediaStreamTrack | null>(null);
  const callerSenderRef = useRef<RTCRtpSender | null>(null);
  const cteAudioStreamRef = useRef<LocalAudioStream | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/dashboard/voice/cte-token', {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
        const body: CteTokenResponse = await res.json();
        setCallerObjectId(body.userObjectId);
        if (body.defaultTargetTeamsUserId) {
          setDefaultTarget(body.defaultTargetTeamsUserId);
          setTarget(body.defaultTargetTeamsUserId);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('CTE token prefetch failed', e);
      }
    })();
    return () => { void hangUp(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mintCteToken(): Promise<CteTokenResponse> {
    const res = await fetch('/api/dashboard/voice/cte-token', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`CTE token mint failed: ${res.status} ${txt.slice(0, 200)}`);
    }
    return res.json();
  }

  async function mintRealtimeSession(): Promise<RealtimeSession> {
    const res = await fetch('/api/dashboard/voice/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice: 'verse',
        instructions:
          'You are Cassidy, an autonomous chief of staff joining a Microsoft Teams call. ' +
          'Greet the user warmly by first name when the call connects, then listen and respond ' +
          'conversationally. Keep replies short unless asked for detail.',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Realtime session mint failed: ${res.status} ${txt.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Build the Foundry Realtime WebRTC connection.
   *
   * Returns the remote audio MediaStream (GPT TTS). The function also
   * stages a "caller sender" on the Realtime peer connection; later,
   * when the ACS call connects, we replace its track with caller audio.
   */
  async function buildRealtimePc(session: RealtimeSession): Promise<MediaStream> {
    const pc = new RTCPeerConnection();
    realtimePcRef.current = pc;

    // Outbound (browser → Realtime) — placeholder silent track. We swap it
    // for the caller's actual voice as soon as ACS gives us the remote
    // audio stream.
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const dest = audioCtxRef.current.createMediaStreamDestination();
    const osc = audioCtxRef.current.createOscillator();
    const gain = audioCtxRef.current.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(dest);
    osc.start();
    const silentTrack = dest.stream.getAudioTracks()[0];
    silentTrackRef.current = silentTrack;

    const sender = pc.addTrack(silentTrack, dest.stream);
    callerSenderRef.current = sender;

    // Inbound (Realtime → browser) — this becomes Cassidy's outbound voice.
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0].getAudioTracks().forEach((t) => remoteStream.addTrack(t));
    };

    // Data channel for events.
    const dc = pc.createDataChannel('oai-events');
    realtimeDcRef.current = dc;
    dc.onopen = () => {
      try {
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
            input_audio_transcription: { model: 'whisper-1' },
          },
        }));
      } catch { /* ignore */ }
      try {
        dc.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio', 'text'] },
        }));
      } catch { /* ignore */ }
    };
    dc.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as { type?: string };
        if (ev.type === 'session.created') setBridgeState('Realtime session up');
        if (ev.type === 'response.created') setBridgeState('Cassidy is speaking');
        if (ev.type === 'input_audio_buffer.speech_started') setBridgeState('Caller speaking');
      } catch { /* ignore */ }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpUrl = `${session.webrtcUrl}?model=${encodeURIComponent(session.deployment)}`;
    const sdpRes = await fetch(sdpUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${session.ephemeralKey}`,
        'Content-Type': 'application/sdp',
      },
    });
    if (!sdpRes.ok) {
      throw new Error(`Realtime SDP exchange failed: ${sdpRes.status}`);
    }
    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Wait briefly for the remote track to arrive.
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (remoteStream.getAudioTracks().length > 0) return resolve();
        if (Date.now() - start > 5000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });

    return remoteStream;
  }

  /** Subscribe to ACS remote audio so the caller's voice flows into Realtime. */
  function bridgeCallerAudioToRealtime(call: TeamsCall): void {
    const tryWire = (streams: ReadonlyArray<RemoteAudioStream>): boolean => {
      if (streams.length === 0) return false;
      void (async () => {
        try {
          const ms = await streams[0].getMediaStream();
          const track = ms.getAudioTracks()[0];
          if (!track || !callerSenderRef.current) return;
          await callerSenderRef.current.replaceTrack(track);
          callerStreamRef.current = ms;
          setBridgeState('Bridge live (caller → AI)');
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Caller-audio bridge failed', e);
        }
      })();
      return true;
    };

    if (tryWire(call.remoteAudioStreams)) return;
    const handler = (): void => {
      if (tryWire(call.remoteAudioStreams)) call.off('remoteAudioStreamsUpdated', handler);
    };
    call.on('remoteAudioStreamsUpdated', handler);
  }

  async function dial(): Promise<void> {
    setError(null);
    setCallState('');
    setBridgeState('');
    setServerCallId('');
    setStatus('minting');
    try {
      const targetId = target.trim();
      if (!targetId) throw new Error('Target Teams user ID is required');

      // Server-side bridge: Cassidy is the ACS endpoint and Foundry Realtime
      // is bridged in Node. The dashboard tab is just a remote control — you
      // can close it and the call keeps running.
      if (serverMode) {
        setBridgeState('Asking server to place call…');
        setStatus('connecting');
        const res = await fetch('/api/dashboard/voice/server-call', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamsUserAadOid: targetId }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Server call failed: ${res.status} ${txt.slice(0, 300)}`);
        }
        const body = await res.json() as { callConnectionId: string };
        setServerCallId(body.callConnectionId || '');
        setBridgeState('Call placed — ringing in Teams');
        setStatus('ringing');
        // We don't have a per-call WebSocket back to the dashboard yet, so we
        // just leave the panel in 'ringing' state. Server-side activity shows
        // up in the Activity tab via recordEvent (Cassidy ringing / connected /
        // ended). Refresh state via /server-calls poll.
        void pollServerCalls();
        return;
      }

      // Browser CTE path — Cassidy as federated Teams user.
      const cte = await mintCteToken();
      setCallerObjectId(cte.userObjectId);

      const credential = new AzureCommunicationTokenCredential({
        tokenRefresher: async () => (await mintCteToken()).token,
        token: cte.token,
        refreshProactively: true,
      });

      const client = clientRef.current ?? new CallClient();
      clientRef.current = client;

      const deviceManager = await client.getDeviceManager();
      const perms = await deviceManager.askDevicePermission({ audio: true, video: false });
      if (!perms.audio) {
        throw new Error('Microphone permission denied — grant it in the browser address bar and retry.');
      }

      const agent = await client.createTeamsCallAgent(credential);
      agentRef.current = agent;

      let cteAudioStream: LocalAudioStream | undefined;
      if (useAi) {
        setBridgeState('Connecting to Foundry Realtime…');
        const session = await mintRealtimeSession();
        const aiStream = await buildRealtimePc(session);
        aiAudioStreamRef.current = aiStream;
        if (aiStream.getAudioTracks().length === 0) {
          throw new Error('Foundry Realtime did not return an audio track');
        }
        cteAudioStream = new LocalAudioStream(aiStream);
        cteAudioStreamRef.current = cteAudioStream;
        setBridgeState('Realtime ready — placing call');
      }

      setStatus('connecting');

      const call = agent.startCall({ microsoftTeamsUserId: targetId }, {
        audioOptions: cteAudioStream ? { localAudioStreams: [cteAudioStream] } : undefined,
      });
      callRef.current = call;

      call.on('stateChanged', () => {
        setCallState(call.state);
        if (call.state === 'Ringing') setStatus('ringing');
        else if (call.state === 'Connected') {
          setStatus('connected');
          if (useAi) bridgeCallerAudioToRealtime(call);
        }
        else if (call.state === 'Disconnected') {
          setStatus('idle');
          callRef.current = null;
          tearDownRealtime();
        }
      });
      call.on('isMutedChanged', () => setIsMuted(call.isMuted));
      call.on('remoteParticipantsUpdated', () => setRemoteCount(call.remoteParticipants.length));
      setCallState(call.state);
      setIsMuted(call.isMuted);
      setRemoteCount(call.remoteParticipants.length);
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setStatus('error');
      await hangUp();
    }
  }

  function tearDownRealtime(): void {
    try { realtimeDcRef.current?.close(); } catch { /* ignore */ }
    try { realtimePcRef.current?.close(); } catch { /* ignore */ }
    try { silentTrackRef.current?.stop(); } catch { /* ignore */ }
    try { aiAudioStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    realtimeDcRef.current = null;
    realtimePcRef.current = null;
    silentTrackRef.current = null;
    callerSenderRef.current = null;
    aiAudioStreamRef.current = null;
    callerStreamRef.current = null;
    cteAudioStreamRef.current = null;
    setBridgeState('');
  }

  async function pollServerCalls(): Promise<void> {
    // Poll every 3s while we believe a server call is up, so the panel can
    // reflect Connected / Disconnected even though we don't own the bridge.
    let stopped = false;
    const pid = window.setInterval(async () => {
      try {
        const r = await fetch('/api/dashboard/voice/server-calls', { credentials: 'include' });
        if (!r.ok) return;
        const body = await r.json() as { calls: Array<{ callConnectionId: string; ageSec: number }> };
        const ours = body.calls.find((c) => c.callConnectionId === serverCallId) || body.calls[0];
        if (ours) {
          if (status === 'ringing' || status === 'connecting') setStatus('connected');
          setBridgeState(`Server bridge live (${ours.ageSec}s)`);
        } else if (status !== 'idle' && status !== 'error') {
          setStatus('idle');
          setBridgeState('Server call ended');
          stopped = true;
          window.clearInterval(pid);
        }
      } catch {
        /* ignore */
      }
      if (stopped) window.clearInterval(pid);
    }, 3000);
  }

  async function hangUp(): Promise<void> {
    setStatus((s) => (s === 'idle' ? s : 'ending'));
    try { await callRef.current?.hangUp({ forEveryone: false }); } catch { /* ignore */ }
    try { await agentRef.current?.dispose(); } catch { /* ignore */ }
    callRef.current = null;
    agentRef.current = null;
    tearDownRealtime();
    setStatus('idle');
    setCallState('');
    setServerCallId('');
  }

  const busy = status !== 'idle' && status !== 'error';

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>📞 Teams Call (CTE — federated)</h3>
      <p style={{ color: 'var(--muted)', marginTop: 0, fontSize: 13 }}>
        Cassidy signs in as a real Teams user and calls the target via federation —
        their Teams rings natively. No Teams Phone licence required.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Target Teams user ID</label>
        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={defaultTarget || 'AAD object ID of target Teams user'}
          style={{ flex: 1, minWidth: 320, fontFamily: 'monospace', padding: '6px 8px' }}
          disabled={busy}
        />
        {!busy && (
          <button className="btn-primary" onClick={() => void dial()} disabled={!target.trim()}>
            Dial
          </button>
        )}
        {busy && (
          <button onClick={() => void hangUp()}>Hang up</button>
        )}
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="cte-use-ai"
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
            disabled={busy || serverMode}
          />
          <label htmlFor="cte-use-ai" style={{ fontSize: 13, color: serverMode ? 'var(--muted)' : 'inherit' }}>
            🧠 Use AI voice (Foundry Realtime)
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="cte-server-mode"
            type="checkbox"
            checked={serverMode}
            onChange={(e) => setServerMode(e.target.checked)}
            disabled={busy}
          />
          <label htmlFor="cte-server-mode" style={{ fontSize: 13 }}>
            🖥️ Server-side bridge (24/7 — survives tab close, identity = ACS)
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <div>Status: <strong style={{ color: status === 'error' ? 'var(--bad)' : 'var(--fg)' }}>{status}</strong></div>
        {callState && <div>Call: <strong style={{ color: 'var(--fg)' }}>{callState}</strong></div>}
        {status === 'connected' && !useAi && <div>Mic: <strong style={{ color: isMuted ? 'var(--bad)' : 'var(--good, #4ade80)' }}>{isMuted ? 'MUTED' : 'live'}</strong></div>}
        {status === 'connected' && <div>Remote participants: <strong style={{ color: 'var(--fg)' }}>{remoteCount}</strong></div>}
        {bridgeState && <div>Bridge: <strong style={{ color: 'var(--fg)' }}>{bridgeState}</strong></div>}
        {callerObjectId && !serverMode && <div>As: <code>{callerObjectId.slice(0, 8)}…</code></div>}
        {serverCallId && <div>Server call: <code>{serverCallId.slice(0, 8)}…</code></div>}
      </div>

      {status === 'connected' && !useAi && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => { void (isMuted ? callRef.current?.unmute() : callRef.current?.mute()); }}>
            {isMuted ? 'Unmute' : 'Mute'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--bad)', marginTop: 8, fontSize: 13, fontFamily: 'monospace' }}>
          {error}
        </div>
      )}
    </div>
  );
}
