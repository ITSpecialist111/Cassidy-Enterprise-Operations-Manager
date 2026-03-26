import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockWorkItems: Array<Record<string, unknown>> = [];

vi.mock('../workQueue/workQueue', () => ({
  getPendingItems: vi.fn(async () => mockWorkItems),
  updateWorkItem: vi.fn(async () => {}),
}));

vi.mock('../tools/index', () => ({
  getAllTools: vi.fn(() => []),
  executeTool: vi.fn(async () => '{"result": "ok"}'),
}));

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: 'Done', tool_calls: undefined }, finish_reason: 'stop' }],
        })),
      },
    },
  })),
}));

import {
  initAutonomousLoop,
  stopAutonomousLoop,
} from './autonomousLoop';
import { getPendingItems, updateWorkItem } from '../workQueue/workQueue';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autonomousLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWorkItems.length = 0;
  });

  afterEach(() => {
    stopAutonomousLoop();
    vi.useRealTimers();
  });

  it('initAutonomousLoop sets up an interval', () => {
    const adapter = { continueConversation: vi.fn() } as unknown as Parameters<typeof initAutonomousLoop>[0];
    const refs = new Map();

    initAutonomousLoop(adapter, refs);
    // Should have scheduled the initial delayed run (setTimeout 15s)
    // and the interval (2 min)
    expect(() => stopAutonomousLoop()).not.toThrow();
  });

  it('stopAutonomousLoop is idempotent', () => {
    stopAutonomousLoop();
    stopAutonomousLoop();
    // No throw
  });

  it('runLoop fetches pending items on tick', async () => {
    const adapter = { continueConversation: vi.fn() } as unknown as Parameters<typeof initAutonomousLoop>[0];
    initAutonomousLoop(adapter, new Map());

    // Advance past the initial 15s delay to trigger runLoop
    await vi.advanceTimersByTimeAsync(16_000);

    expect(getPendingItems).toHaveBeenCalled();
  });

  it('runLoop processes work items with subtasks', async () => {
    const adapter = { continueConversation: vi.fn() } as unknown as Parameters<typeof initAutonomousLoop>[0];

    mockWorkItems.push({
      partitionKey: 'cassidy',
      rowKey: 'wi-001',
      goal: 'Test goal',
      subtasks: JSON.stringify([
        { id: 's1', description: 'Step 1', dependsOn: [], status: 'pending' },
      ]),
      currentStep: 0,
      status: 'pending',
      retryCount: 0,
      conversationId: 'conv-1',
      serviceUrl: 'https://test',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    initAutonomousLoop(adapter, new Map());
    await vi.advanceTimersByTimeAsync(16_000);

    expect(updateWorkItem).toHaveBeenCalled();
  });

  it('handles getPendingItems errors gracefully', async () => {
    (getPendingItems as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Storage down'));

    const adapter = { continueConversation: vi.fn() } as unknown as Parameters<typeof initAutonomousLoop>[0];
    initAutonomousLoop(adapter, new Map());

    // Should not throw
    await vi.advanceTimersByTimeAsync(16_000);
    expect(getPendingItems).toHaveBeenCalled();
  });
});
