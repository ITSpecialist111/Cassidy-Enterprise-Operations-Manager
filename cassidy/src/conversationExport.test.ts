// ---------------------------------------------------------------------------
// Tests — Conversation Export / Audit Trail
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const mockListEntities = vi.fn();
vi.mock('./memory/tableStorage', () => ({
  listEntities: (...args: unknown[]) => mockListEntities(...args),
}));

import { exportConversations } from './conversationExport';

const NOW = '2025-06-15T12:00:00.000Z';

function makeEntity(rowKey: string, updatedAt: string, messages: Array<{ role: string; content: string }>) {
  return {
    partitionKey: 'cassidy',
    rowKey,
    updatedAt,
    history: JSON.stringify(messages),
  };
}

describe('exportConversations', () => {
  beforeEach(() => {
    mockListEntities.mockReset();
  });

  it('exports all conversations', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('conv1', NOW, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }]),
    ]);

    const result = await exportConversations();
    expect(result).toHaveLength(1);
    expect(result[0].conversationId).toBe('conv1');
    expect(result[0].messageCount).toBe(2);
  });

  it('filters by fromDate', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('old', '2025-01-01T00:00:00.000Z', [{ role: 'user', content: 'old' }]),
      makeEntity('new', '2025-06-15T00:00:00.000Z', [{ role: 'user', content: 'new' }]),
    ]);

    const result = await exportConversations({ fromDate: '2025-06-01T00:00:00.000Z' });
    expect(result).toHaveLength(1);
    expect(result[0].conversationId).toBe('new');
  });

  it('filters by toDate', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('old', '2025-01-01T00:00:00.000Z', [{ role: 'user', content: 'old' }]),
      makeEntity('new', '2025-06-15T00:00:00.000Z', [{ role: 'user', content: 'new' }]),
    ]);

    const result = await exportConversations({ toDate: '2025-03-01T00:00:00.000Z' });
    expect(result).toHaveLength(1);
    expect(result[0].conversationId).toBe('old');
  });

  it('applies limit', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('c1', '2025-06-15T12:00:00.000Z', []),
      makeEntity('c2', '2025-06-15T11:00:00.000Z', []),
      makeEntity('c3', '2025-06-15T10:00:00.000Z', []),
    ]);

    const result = await exportConversations({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('sorts by updatedAt descending', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('oldest', '2025-06-10T00:00:00.000Z', []),
      makeEntity('newest', '2025-06-15T00:00:00.000Z', []),
      makeEntity('middle', '2025-06-12T00:00:00.000Z', []),
    ]);

    const result = await exportConversations();
    expect(result[0].conversationId).toBe('newest');
    expect(result[2].conversationId).toBe('oldest');
  });

  it('redacts email addresses', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('c1', NOW, [{ role: 'user', content: 'Email me at john@example.com' }]),
    ]);

    const result = await exportConversations({ redact: true });
    expect(result[0].messages[0].content).toContain('[EMAIL]');
    expect(result[0].messages[0].content).not.toContain('john@example.com');
  });

  it('redacts phone numbers', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('c1', NOW, [{ role: 'user', content: 'Call me at 555-123-4567' }]),
    ]);

    const result = await exportConversations({ redact: true });
    expect(result[0].messages[0].content).toContain('[PHONE]');
  });

  it('redacts SSNs', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('c1', NOW, [{ role: 'user', content: 'SSN: 123-45-6789' }]),
    ]);

    const result = await exportConversations({ redact: true });
    expect(result[0].messages[0].content).toContain('[SSN]');
    expect(result[0].messages[0].content).not.toContain('123-45-6789');
  });

  it('redacts card numbers', async () => {
    mockListEntities.mockResolvedValue([
      makeEntity('c1', NOW, [{ role: 'user', content: 'Card: 4111 1111 1111 1111' }]),
    ]);

    const result = await exportConversations({ redact: true });
    expect(result[0].messages[0].content).toContain('[CARD]');
  });

  it('handles malformed history JSON gracefully', async () => {
    mockListEntities.mockResolvedValue([
      { partitionKey: 'cassidy', rowKey: 'bad', updatedAt: NOW, history: 'NOT JSON' },
    ]);

    const result = await exportConversations();
    expect(result[0].messageCount).toBe(0);
    expect(result[0].messages).toEqual([]);
  });

  it('returns empty array on table storage error', async () => {
    mockListEntities.mockRejectedValue(new Error('Storage unavailable'));
    const result = await exportConversations();
    expect(result).toEqual([]);
  });
});
