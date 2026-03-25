import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockCreate = vi.fn(async () => ({
  choices: [{
    message: { role: 'assistant', content: 'Hello, this is Cassidy calling about your overdue tasks.' },
    finish_reason: 'stop',
  }],
}));

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

vi.mock('./speechProcessor', () => ({
  synthesizeSpeech: vi.fn(async () => ({
    success: true,
    audioData: Buffer.from('test-audio'),
    durationMs: 1000,
  })),
  isVoiceAvailable: vi.fn(() => true),
}));

vi.mock('./callManager', () => ({
  getActiveCall: vi.fn((callId: string) => {
    if (callId === 'active-call') {
      return {
        callId: 'active-call',
        targetUserId: 'user-1',
        targetDisplayName: 'Test User',
        state: 'connected',
        reason: 'Urgent: overdue tasks',
        startedAt: new Date().toISOString(),
        context: { overdueCount: 5 },
      };
    }
    return null;
  }),
  playPromptInCall: vi.fn(async () => ({ success: true })),
  endCall: vi.fn(async () => ({ success: true })),
}));

vi.mock('../tools/index', () => ({
  getAllTools: vi.fn(() => []),
  executeTool: vi.fn(async () => JSON.stringify({ result: 'mock' })),
}));

import {
  startVoiceConversation,
  processUserSpeech,
  endVoiceConversation,
  shouldEscalateToVoice,
} from './voiceAgent';
import { playPromptInCall } from './callManager';

describe('voiceAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startVoiceConversation', () => {
    it('returns opening prompt for active call', async () => {
      const prompt = await startVoiceConversation('active-call');
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
    });

    it('returns null for non-existent call', async () => {
      const result = await startVoiceConversation('nonexistent');
      expect(result).toBeNull();
    });

    it('calls playPromptInCall with audio data', async () => {
      await startVoiceConversation('active-call');
      expect(playPromptInCall).toHaveBeenCalledWith(
        'active-call',
        expect.any(String),
        expect.any(Buffer),
      );
    });
  });

  describe('processUserSpeech', () => {
    it('returns null for non-existent conversation', async () => {
      const result = await processUserSpeech('no-conv', 'Hello');
      expect(result).toBeNull();
    });

    it('generates a spoken response for active conversation', async () => {
      await startVoiceConversation('active-call');
      const response = await processUserSpeech('active-call', 'What tasks are overdue?');
      expect(response).toBeTruthy();
      expect(typeof response).toBe('string');
    });
  });

  describe('endVoiceConversation', () => {
    it('returns null for non-existent conversation', () => {
      const result = endVoiceConversation('no-conv');
      expect(result).toBeNull();
    });

    it('returns stats for active conversation', async () => {
      await startVoiceConversation('active-call');
      const result = endVoiceConversation('active-call');
      expect(result).not.toBeNull();
      expect(result!.turnCount).toBeDefined();
      expect(result!.durationSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shouldEscalateToVoice', () => {
    it('escalates critical urgency after 30 minutes', () => {
      expect(shouldEscalateToVoice('critical', 30)).toBe(true);
      expect(shouldEscalateToVoice('critical', 31)).toBe(true);
    });

    it('does not escalate critical under 30 minutes', () => {
      expect(shouldEscalateToVoice('critical', 29)).toBe(false);
    });

    it('escalates high urgency after 60 minutes', () => {
      expect(shouldEscalateToVoice('high', 60)).toBe(true);
      expect(shouldEscalateToVoice('high', 90)).toBe(true);
    });

    it('does not escalate high under 60 minutes', () => {
      expect(shouldEscalateToVoice('high', 59)).toBe(false);
    });

    it('does not escalate normal urgency', () => {
      expect(shouldEscalateToVoice('normal', 120)).toBe(false);
      expect(shouldEscalateToVoice('low', 120)).toBe(false);
    });
  });
});
