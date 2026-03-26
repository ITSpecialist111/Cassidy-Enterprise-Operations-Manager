// ---------------------------------------------------------------------------
// Tests — Conversation Memory (Table Storage persistence)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tableStorage', () => ({
  upsertEntity: vi.fn().mockResolvedValue(undefined),
  getEntity: vi.fn().mockResolvedValue(null),
}));

import { loadHistory, saveHistory, type HistoryMessage } from './conversationMemory';
import { upsertEntity, getEntity } from './tableStorage';

const mockGetEntity = vi.mocked(getEntity);
const mockUpsertEntity = vi.mocked(upsertEntity);

describe('conversationMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadHistory', () => {
    it('returns empty array when no entity exists', async () => {
      mockGetEntity.mockResolvedValueOnce(null);
      const result = await loadHistory('conv-1');
      expect(result).toEqual([]);
    });

    it('returns empty array when entity has no history', async () => {
      mockGetEntity.mockResolvedValueOnce({ partitionKey: 'cassidy', rowKey: 'conv-1', history: '' } as never);
      const result = await loadHistory('conv-1');
      expect(result).toEqual([]);
    });

    it('deserializes stored history', async () => {
      const stored: HistoryMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      mockGetEntity.mockResolvedValueOnce({
        partitionKey: 'cassidy',
        rowKey: 'conv-1',
        history: JSON.stringify(stored),
      } as never);

      const result = await loadHistory('conv-1');
      expect(result).toEqual(stored);
      expect(result).toHaveLength(2);
    });

    it('returns empty array on storage error', async () => {
      mockGetEntity.mockRejectedValueOnce(new Error('Storage unavailable'));
      const result = await loadHistory('conv-1');
      expect(result).toEqual([]);
    });

    it('sanitizes conversation ID for table storage key', async () => {
      await loadHistory('conv/with#special?chars\\here');
      expect(mockGetEntity).toHaveBeenCalledWith(
        'CassidyConversations',
        'cassidy',
        'conv_with_special_chars_here',
      );
    });
  });

  describe('saveHistory', () => {
    it('upserts entity with serialized history', async () => {
      const history: HistoryMessage[] = [
        { role: 'user', content: 'test' },
      ];
      await saveHistory('conv-1', history);

      expect(mockUpsertEntity).toHaveBeenCalledWith('CassidyConversations', expect.objectContaining({
        partitionKey: 'cassidy',
        rowKey: 'conv-1',
        history: JSON.stringify(history),
      }));
    });

    it('trims history to MAX_HISTORY (30)', async () => {
      const history: HistoryMessage[] = Array.from({ length: 50 }, (_, i) => ({
        role: 'user' as const,
        content: `message ${i}`,
      }));
      await saveHistory('conv-1', history);

      const savedEntity = mockUpsertEntity.mock.calls[0][1];
      const savedHistory = JSON.parse(savedEntity.history as string);
      expect(savedHistory).toHaveLength(30);
      expect(savedHistory[0].content).toBe('message 20'); // last 30
    });

    it('does not throw on authorization failure', async () => {
      mockUpsertEntity.mockRejectedValueOnce(new Error('AuthorizationFailure'));
      await expect(saveHistory('conv-1', [{ role: 'user', content: 'test' }])).resolves.toBeUndefined();
    });

    it('does not throw on general storage error', async () => {
      mockUpsertEntity.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(saveHistory('conv-1', [{ role: 'user', content: 'test' }])).resolves.toBeUndefined();
    });

    it('includes updatedAt timestamp', async () => {
      await saveHistory('conv-1', [{ role: 'user', content: 'test' }]);
      const savedEntity = mockUpsertEntity.mock.calls[0][1];
      expect(savedEntity.updatedAt).toBeDefined();
      expect(new Date(savedEntity.updatedAt as string).getTime()).not.toBeNaN();
    });
  });
});
