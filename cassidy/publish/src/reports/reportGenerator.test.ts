import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth', () => ({
  getSharedOpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: 'Narrative section content here.' } }],
        })),
      },
    },
  })),
}));

vi.mock('../featureConfig', () => ({
  config: {
    plannerGroupId: '',
    plannerPlanId: '',
    openAiEndpoint: '',
    openAiDeployment: 'gpt-5',
    baseUrl: 'https://test.example.com',
    storageAccount: '',
    orgName: 'TestCorp',
    orgIndustry: 'Technology',
    opsTeamsChannelId: 'chan-1',
    managerEmail: 'mgr@test.com',
    orgTimezone: 'UTC',
  },
  features: { openAiConfigured: false, isDevelopment: true },
}));

vi.mock('../tools/index', () => ({
  getOverdueTasks: vi.fn(async () => ({
    total: 3, criticalCount: 1, overdueCount: 2, atRiskCount: 1, source: 'demo',
    tasks: [
      { title: 'Task A', owner: 'Alice', dueDate: '2026-03-10', daysOverdue: 5, status: 'overdue' },
    ],
  })),
  getTeamWorkload: vi.fn(async () => ({
    source: 'demo', total_members: 2,
    members: [
      { name: 'Alice', activeTasks: 5, overdueCount: 1, capacity: 'normal', role: 'Lead' },
    ],
  })),
  getPendingApprovals: vi.fn(async () => ({
    total: 1, overdueCount: 0, highUrgencyCount: 0, source: 'demo',
    approvals: [{ title: 'Approve budget', requestor: 'Bob', approver: 'Alice', submittedDaysAgo: 2 }],
  })),
  generateStandupReport: vi.fn(async () => '## Standup\n- No blockers'),
  generateProjectStatusReport: vi.fn(async () => '## Project\n- On track'),
  sendEmail: vi.fn(async () => ({ success: true })),
  formatForTeams: vi.fn((p: { content: string }) => p.content),
}));

vi.mock('../tools/mcpToolSetup', () => ({
  invokeMcpTool: vi.fn(async () => ({})),
  hasMcpToolServer: vi.fn(() => false),
  sendTeamsMessage: vi.fn(async () => ({ success: true })),
}));

vi.mock('../intelligence/predictiveEngine', () => ({
  getOperationalRiskScore: vi.fn(async () => ({ score: 45, level: 'yellow', factors: [] })),
  getActivePredictions: vi.fn(async () => []),
  runPredictionCycle: vi.fn(async () => []),
}));

vi.mock('./reportTemplates', () => ({
  getTemplate: vi.fn((id: string) => {
    if (id === 'test-template') {
      return {
        id: 'test-template',
        name: 'Test Report',
        outputFormat: 'teams_message',
        sections: [
          {
            title: 'Overview',
            dataSource: 'getOverdueTasks',
            dataParams: { include_at_risk: true },
            renderAs: 'text',
            narrativePrompt: 'Summarize the overdue tasks.',
          },
        ],
      };
    }
    return null;
  }),
  listTemplates: vi.fn(() => [
    { id: 'test-template', name: 'Test Report', description: 'Test', format: 'teams_message' },
  ]),
}));

import { generateReport, distributeReport, postReportToTeams } from './reportGenerator';
import { sendEmail } from '../tools/index';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reportGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateReport', () => {
    it('generates a report for valid template', async () => {
      const result = await generateReport('test-template');
      expect(result.success).toBe(true);
      expect(result.templateId).toBe('test-template');
      expect(result.templateName).toBe('Test Report');
      expect(result.content).toContain('# Test Report');
    });

    it('returns error for unknown template', async () => {
      const result = await generateReport('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown report template');
    });

    it('includes section content', async () => {
      const result = await generateReport('test-template');
      expect(result.content).toContain('## Overview');
    });

    it('includes demo notice when data is from demo', async () => {
      const result = await generateReport('test-template');
      // getDemoNotice checks source === 'demo'
      expect(result.content).toContain('DEMO DATA');
    });

    it('sets generatedAt timestamp', async () => {
      const result = await generateReport('test-template');
      expect(result.generatedAt).toBeTruthy();
      expect(new Date(result.generatedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('outputFormat matches template', async () => {
      const result = await generateReport('test-template');
      expect(result.outputFormat).toBe('teams_message');
    });
  });

  describe('distributeReport', () => {
    it('sends email to recipients', async () => {
      const report = {
        success: true,
        templateId: 'test',
        templateName: 'Test Report',
        outputFormat: 'teams_message' as const,
        content: '# Test\nContent here',
        generatedAt: new Date().toISOString(),
      };

      const result = await distributeReport(report, ['alice@test.com', 'bob@test.com']);
      expect(result.recipientCount).toBe(2);
      expect(result.sentTo).toContain('alice@test.com');
      expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    it('returns failure when no recipients', async () => {
      const report = {
        success: true,
        templateId: 'test',
        templateName: 'Test',
        outputFormat: 'teams_message' as const,
        content: 'content',
        generatedAt: new Date().toISOString(),
      };

      const result = await distributeReport(report, []);
      expect(result.success).toBe(false);
      expect(result.failures).toContain('No recipients specified');
    });

    it('handles email send failures', async () => {
      (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'MCP down' });

      const report = {
        success: true,
        templateId: 'test',
        templateName: 'Test',
        outputFormat: 'teams_message' as const,
        content: 'content',
        generatedAt: new Date().toISOString(),
      };

      const result = await distributeReport(report, ['alice@test.com']);
      expect(result.recipientCount).toBe(0);
      expect(result.failures.length).toBe(1);
    });

    it('includes fileUrl in email body when available', async () => {
      const report = {
        success: true,
        templateId: 'test',
        templateName: 'Test',
        outputFormat: 'word' as const,
        content: 'content',
        fileUrl: 'https://sharepoint.test/report.docx',
        generatedAt: new Date().toISOString(),
      };

      await distributeReport(report, ['alice@test.com']);
      const emailCall = (sendEmail as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(emailCall[0].body).toContain('sharepoint.test');
    });
  });

  describe('postReportToTeams', () => {
    it('posts report content to Teams channel', async () => {
      const report = {
        success: true,
        templateId: 'test',
        templateName: 'Test',
        outputFormat: 'teams_message' as const,
        content: '# Report Content',
        generatedAt: new Date().toISOString(),
      };

      const result = await postReportToTeams(report);
      expect(result.success).toBe(true);
    });
  });
});
