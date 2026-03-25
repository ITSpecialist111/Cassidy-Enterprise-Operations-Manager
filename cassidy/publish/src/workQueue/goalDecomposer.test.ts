import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @azure/identity
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: vi.fn(() => async () => 'mock-token'),
}));

// Mock OpenAI
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  AzureOpenAI: class {
    chat = { completions: { create: mockCreate } };
  },
}));

import { decomposeGoal, isComplexGoal } from './goalDecomposer';

describe('goalDecomposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isComplexGoal', () => {
    it('detects "set up" + meeting/process goals', () => {
      expect(isComplexGoal('Set up a weekly review meeting for the team')).toBe(true);
    });

    it('detects "run ... workflow" goals', () => {
      expect(isComplexGoal('Run the onboarding process for the new hire')).toBe(true);
    });

    it('detects "follow up ... every/daily" goals', () => {
      expect(isComplexGoal('Follow up on the approval every day until done')).toBe(true);
    });

    it('detects "monitor and escalate" goals', () => {
      expect(isComplexGoal('Monitor the deployment and alert me if it fails')).toBe(true);
    });

    it('detects "ensure ... approved" goals', () => {
      expect(isComplexGoal('Make sure the budget is approved by Friday')).toBe(true);
    });

    it('detects recurring schedule goals', () => {
      expect(isComplexGoal('Send a status report every Monday morning')).toBe(true);
    });

    it('rejects simple queries', () => {
      expect(isComplexGoal('What is my next meeting?')).toBe(false);
      expect(isComplexGoal('Show me tasks')).toBe(false);
      expect(isComplexGoal('Hi')).toBe(false);
      expect(isComplexGoal('How are you?')).toBe(false);
    });
  });

  describe('decomposeGoal', () => {
    it('returns subtasks from GPT-5 response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify([
              { id: 's1', description: 'Research venue options', toolHint: 'findUser', dependsOn: [] },
              { id: 's2', description: 'Send invitations', toolHint: 'sendEmail', dependsOn: ['s1'] },
            ]),
          },
        }],
      });

      const subtasks = await decomposeGoal('Plan the Q3 customer summit');
      expect(subtasks).toHaveLength(2);
      expect(subtasks[0].description).toBe('Research venue options');
      expect(subtasks[0].status).toBe('pending');
      expect(subtasks[1].dependsOn).toEqual(['s1']);
    });

    it('handles GPT-5 response with code fence wrappers', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '```json\n[{"id":"s1","description":"Do the thing","dependsOn":[]}]\n```',
          },
        }],
      });

      const subtasks = await decomposeGoal('Do something complex');
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].description).toBe('Do the thing');
    });

    it('falls back to single subtask on malformed JSON', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: { content: 'This is not JSON at all' },
        }],
      });

      // Fallback: returns the original goal as a single subtask
      const subtasks = await decomposeGoal('Plan something complex');
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].description).toBe('Plan something complex');
      expect(subtasks[0].status).toBe('pending');
    });

    it('falls back to single subtask on API error', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API unavailable'));

      const subtasks = await decomposeGoal('Coordinate the team offsite');
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0].description).toBe('Coordinate the team offsite');
    });
  });
});
