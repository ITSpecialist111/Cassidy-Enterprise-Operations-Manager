// Voice panel — connects to Microsoft Foundry Realtime API (gpt-realtime-mini)
// over WebRTC. Mic in, speaker out, full-duplex, ~100ms latency.
//
// Architecture:
//   1. POST /api/dashboard/voice/session  → ephemeral key + WebRTC URL
//   2. RTCPeerConnection adds mic track, opens "oai-events" data channel
//   3. SDP offer → POST to {webrtcUrl}?model=...   (Bearer = ephemeral key)
//   4. SDP answer comes back → setRemoteDescription
//   5. Every event on data channel → POST /api/dashboard/voice/event
//      (so Codebase tab voice nodes light up)

import { useEffect, useRef, useState } from 'react';

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'closing' | 'error';

interface SessionResponse {
  sessionId: string;
  ephemeralKey: string;
  expiresAt: number;
  webrtcUrl: string;
  deployment: string;
  voice: string;
  apiVersion: string;
}

interface TranscriptLine {
  id: string;
  who: 'you' | 'cassidy';
  text: string;
  done: boolean;
}

export function VoicePanel() {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [lastEventType, setLastEventType] = useState<string>('');
  const [inviteState, setInviteState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [inviteMsg, setInviteMsg] = useState<string>('');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => { stopCall(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reportEvent(type: string, label: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await fetch('/api/dashboard/voice/event', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label, data }),
      });
    } catch { /* ignore — telemetry must never break the call */ }
  }

  function appendDelta(who: 'you' | 'cassidy', responseId: string, delta: string): void {
    setTranscript((prev) => {
      const idx = prev.findIndex((l) => l.id === responseId && !l.done);
      if (idx === -1) return [...prev, { id: responseId, who, text: delta, done: false }];
      const next = prev.slice();
      next[idx] = { ...next[idx], text: next[idx].text + delta };
      return next;
    });
  }

  function markDone(responseId: string): void {
    setTranscript((prev) =>
      prev.map((l) => (l.id === responseId ? { ...l, done: true } : l))
    );
  }

  async function startCall(): Promise<void> {
    setError(null);
    setTranscript([]);
    setEventCount(0);
    setStatus('connecting');
    try {
      // 1. Mint session
      const sessionRes = await fetch('/api/dashboard/voice/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: 'verse' }),
      });
      if (!sessionRes.ok) {
        const body = await sessionRes.text();
        throw new Error(`Session mint failed: ${sessionRes.status} ${body.slice(0, 200)}`);
      }
      const session: SessionResponse = await sessionRes.json();
      if (!session.ephemeralKey) throw new Error('No ephemeral key returned');

      // 2. Build PeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Audio out
      pc.ontrack = (ev) => {
        if (audioElRef.current) {
          audioElRef.current.srcObject = ev.streams[0];
          audioElRef.current.play().catch(() => { /* user gesture required first */ });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('connected');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setStatus('error');
      };

      // Mic in
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // Data channel for events
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        // Configure session — system instructions already set server-side at mint
        const cfg = {
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
            input_audio_transcription: { model: 'whisper-1' },
          },
        };
        try { dc.send(JSON.stringify(cfg)); } catch { /* ignore */ }
      };

      dc.onmessage = (msg) => {
        let ev: { type?: string; delta?: string; transcript?: string; response_id?: string; item_id?: string } = {};
        try { ev = JSON.parse(msg.data); } catch { return; }
        const type = ev.type || 'unknown';
        setEventCount((n) => n + 1);
        setLastEventType(type);

        // Build transcript from streaming events
        const id = ev.response_id || ev.item_id || 'live';
        if (type === 'response.audio_transcript.delta' && ev.delta) {
          appendDelta('cassidy', id, ev.delta);
        } else if (type === 'response.audio_transcript.done' && ev.transcript) {
          // Replace tentative line with final transcript
          setTranscript((prev) => {
            const idx = prev.findIndex((l) => l.id === id);
            if (idx === -1) return [...prev, { id, who: 'cassidy', text: ev.transcript || '', done: true }];
            const next = prev.slice();
            next[idx] = { id, who: 'cassidy', text: ev.transcript || next[idx].text, done: true };
            return next;
          });
        } else if (type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          setTranscript((prev) => [...prev, { id: `you-${id}`, who: 'you', text: ev.transcript || '', done: true }]);
        } else if (type === 'response.done') {
          markDone(id);
        }

        // Forward to backend so Codebase tab voice nodes pulse
        const label = type.replace(/^response\./, '').replace(/^input_audio_buffer\./, 'mic.');
        void reportEvent(type, label, {
          responseId: ev.response_id,
          itemId: ev.item_id,
          deltaLen: ev.delta?.length,
        });
      };

      // 3. SDP offer/answer
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
        const body = await sdpRes.text();
        throw new Error(`WebRTC SDP exchange failed: ${sdpRes.status} ${body.slice(0, 200)}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      void reportEvent('voice.client.connected', 'WebRTC connected', { sessionId: session.sessionId });
    } catch (e) {
      setError(String(e));
      setStatus('error');
      stopCall();
    }
  }

  function stopCall(): void {
    setStatus((prev) => (prev === 'idle' ? 'idle' : 'closing'));
    try { dcRef.current?.close(); } catch { /* ignore */ }
    try { pcRef.current?.close(); } catch { /* ignore */ }
    try { localStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    dcRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    setStatus('idle');
  }

  async function sendTeamsInvite(): Promise<void> {
    setInviteState('sending');
    setInviteMsg('');
    try {
      const res = await fetch('/api/dashboard/voice/invite', {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteState('error');
        setInviteMsg(body.error || `HTTP ${res.status}`);
        return;
      }
      setInviteState('sent');
      setInviteMsg('Check Teams — message sent to your chat with Cassidy.');
    } catch (e) {
      setInviteState('error');
      setInviteMsg(String(e));
    }
  }

  // Auto-start if URL has ?voice=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('voice') === '1' && status === 'idle') {
      // Don't auto-start mic without user gesture — show panel ready
      // User still needs to click "Start" once for browser permission flow.
    }
  }, [status]);

  return (
    <div className="voice-panel">
      <div className="voice-header">
        <h2 style={{ margin: 0 }}>🎙️ Voice — Foundry Realtime</h2>
        <div className="voice-meta">
          gpt-realtime-mini · WebRTC · ~100ms · {status}
          {eventCount > 0 && <> · {eventCount} events · last: <code>{lastEventType}</code></>}
        </div>
      </div>

      <div className="voice-controls">
        {status === 'idle' && (
          <button className="btn-primary" onClick={startCall}>
            🎙️ Start voice call
          </button>
        )}
        {status === 'connecting' && (
          <button className="btn-primary" disabled>Connecting…</button>
        )}
        {status === 'connected' && (
          <button className="btn-primary voice-btn-stop" onClick={stopCall}>
            ⏹ End call
          </button>
        )}
        {status === 'error' && (
          <button className="btn-primary" onClick={startCall}>Retry</button>
        )}

        <button
          className="btn-secondary"
          onClick={sendTeamsInvite}
          disabled={inviteState === 'sending'}
          title="Cassidy will DM you on Teams with a link to this voice console"
        >
          📞 {inviteState === 'sending' ? 'Sending…' : 'Call me on Teams'}
        </button>
      </div>

      {inviteMsg && (
        <div className={inviteState === 'error' ? 'error' : 'voice-info'} style={{ marginBottom: 12 }}>
          {inviteMsg}
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <audio ref={audioElRef} autoPlay playsInline />

      <div className="voice-transcript">
        {transcript.length === 0 && (
          <div className="empty">
            {status === 'connected'
              ? 'Listening… say hi to Cassidy.'
              : 'Click Start, allow mic access, then speak to Cassidy. Live transcript and ant-trails will appear on the Codebase tab.'}
          </div>
        )}
        {transcript.map((line) => (
          <div key={line.id + line.who} className={`voice-line voice-line-${line.who}`}>
            <span className="voice-who">{line.who === 'you' ? 'You' : 'Cassidy'}</span>
            <span className="voice-text">{line.text}{!line.done && <span className="voice-cursor">▍</span>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
