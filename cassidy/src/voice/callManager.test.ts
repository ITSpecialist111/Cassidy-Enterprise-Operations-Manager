import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth module
vi.mock('../auth', () => ({
  getGraphToken: vi.fn(async () => 'mock-graph-token'),
  sharedCredential: {
    getToken: vi.fn(async () => ({ token: 'mock-storage-token' })),
  },
}));

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  initiateCall,
  endCall,
  handleCallNotification,
  playPromptInCall,
  getActiveCall,
  getActiveCalls,
  getCallByUserId,
} from './callManager';

describe('callManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  describe('initiateCall', () => {
    it('creates a call via Graph API and tracks it', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'call-123', state: 'creating' }),
      });

      const result = await initiateCall({
        targetUserId: 'user-1',
        targetDisplayName: 'Test User',
        reason: 'Overdue tasks',
      });

      expect(result.success).toBe(true);
      expect(result.callId).toBe('call-123');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/communications/calls',
        expect.objectContaining({ method: 'POST' }),
      );

      // Call should be tracked
      const activeCall = getActiveCall('call-123');
      expect(activeCall).not.toBeNull();
      expect(activeCall!.targetUserId).toBe('user-1');
      expect(activeCall!.state).toBe('creating');
    });

    it('returns error on Graph API failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await initiateCall({
        targetUserId: 'user-1',
        targetDisplayName: 'Test User',
        reason: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');
    });
  });

  describe('endCall', () => {
    it('returns error for unknown call ID', async () => {
      const result = await endCall('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active call');
    });
  });

  describe('handleCallNotification', () => {
    it('returns play_prompt when call connects', async () => {
      // First initiate a call to get it tracked
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'call-notify-1', state: 'creating' }),
      });
      await initiateCall({
        targetUserId: 'user-2',
        targetDisplayName: 'Notify User',
        reason: 'Test',
      });

      const result = await handleCallNotification({
        value: [{
          changeType: 'updated',
          resourceUrl: '/communications/calls/call-notify-1',
          resourceData: { id: 'call-notify-1', state: 'connected' },
        }],
      });

      expect(result.action).toBe('play_prompt');
      expect(result.state).toBe('connected');
    });

    it('returns end on termination', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'call-term-1', state: 'creating' }),
      });
      await initiateCall({
        targetUserId: 'user-3',
        targetDisplayName: 'Term User',
        reason: 'Test',
      });

      const result = await handleCallNotification({
        value: [{
          changeType: 'updated',
          resourceUrl: '/communications/calls/call-term-1',
          resourceData: { id: 'call-term-1', state: 'terminated' },
        }],
      });

      expect(result.action).toBe('end');
      expect(getActiveCall('call-term-1')).toBeNull();
    });
  });

  describe('playPromptInCall', () => {
    it('uploads audio to blob and sends playPrompt with URI', async () => {
      // Mock container creation (409 = already exists)
      fetchMock.mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'Conflict' });
      // Mock blob upload
      fetchMock.mockResolvedValueOnce({ ok: true });
      // Mock Graph token (getGraphToken)
      // Mock Graph playPrompt
      fetchMock.mockResolvedValueOnce({ ok: true });

      const audioData = Buffer.from('fake-audio-data');
      const result = await playPromptInCall('call-audio-1', 'Hello there', audioData);

      expect(result.success).toBe(true);
      // Should have called blob upload with correct content type
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('cassidy-audio/tts-call-audio-1'),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'audio/mpeg',
            'x-ms-blob-type': 'BlockBlob',
          }),
        }),
      );
    });

    it('returns failure when no audio data provided', async () => {
      const result = await playPromptInCall('call-no-audio', 'Hello', undefined);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No audio data');
    });
  });

  describe('status helpers', () => {
    it('getCallByUserId finds call by user', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'call-user-lookup', state: 'creating' }),
      });
      await initiateCall({
        targetUserId: 'lookup-user',
        targetDisplayName: 'Lookup',
        reason: 'Test',
      });

      const call = getCallByUserId('lookup-user');
      expect(call).not.toBeNull();
      expect(call!.callId).toBe('call-user-lookup');
    });

    it('getCallByUserId returns null for unknown user', () => {
      expect(getCallByUserId('unknown')).toBeNull();
    });

    it('getActiveCalls returns all tracked calls', async () => {
      const before = getActiveCalls().length;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'call-list-1', state: 'creating' }),
      });
      await initiateCall({
        targetUserId: 'list-user',
        targetDisplayName: 'List',
        reason: 'Test',
      });

      expect(getActiveCalls().length).toBe(before + 1);
    });
  });
});
