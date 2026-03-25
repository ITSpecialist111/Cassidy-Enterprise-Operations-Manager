import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies — we're testing DISPATCH logic, not the underlying tools
// ---------------------------------------------------------------------------

vi.mock('../featureConfig', () => ({
  config: {
    plannerGroupId: '',
    plannerPlanId: '',
    openAiEndpoint: '',
    openAiDeployment: 'gpt-5',
    baseUrl: 'https://test.example.com',
    storageAccount: '',
  },
  features: { openAiConfigured: false, isDevelopment: true },
}));

vi.mock('../auth', () => ({
  getGraphToken: vi.fn(async () => 'mock-token'),
  getSharedOpenAI: vi.fn(() => ({
    chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '[]' } }] })) } },
  })),
  sharedCredential: {},
}));

vi.mock('../memory/tableStorage', () => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    upsertEntity: vi.fn(async (_t: string, entity: Record<string, unknown>) => {
      store.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
    }),
    getEntity: vi.fn(async () => null),
    listEntities: vi.fn(async () => []),
    deleteEntity: vi.fn(async () => {}),
    __store: store,
  };
});

// Lightweight mock for MCP setup — no real MCP servers
vi.mock('./mcpToolSetup', () => ({
  getMcpTools: vi.fn(async () => ({ tools: [], message: 'No MCP servers' })),
  findUser: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  sendTeamsMessage: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  sendEmail: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  createPlannerTask: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  updatePlannerTask: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  scheduleCalendarEvent: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  readSharePointList: vi.fn(async () => ({ success: false, message: 'MCP unavailable' })),
  invokeMcpTool: vi.fn(async () => ({})),
  hasMcpToolServer: vi.fn(() => false),
  MCP_TOOL_DEFINITIONS: [],
}));

// Mock report generator / distributor
vi.mock('../reports/reportGenerator', () => ({
  generateReport: vi.fn(async () => ({
    success: true, templateId: 'test', templateName: 'Test', outputFormat: 'teams_message',
    content: '# Test Report', generatedAt: new Date().toISOString(),
  })),
  distributeReport: vi.fn(async () => ({ success: true, recipientCount: 0, sentTo: [], failures: [] })),
  postReportToTeams: vi.fn(async () => ({ success: true })),
}));

vi.mock('../reports/reportTemplates', () => ({
  listTemplates: vi.fn(() => [{ id: 'standup', name: 'Daily Standup' }]),
  getTemplate: vi.fn(() => null),
  REPORT_TOOL_DEFINITIONS: [],
}));

vi.mock('../reports/distributionManager', () => ({
  createDistributionList: vi.fn(async () => ({ success: true, message: 'Created' })),
  getDistributionList: vi.fn(async () => null),
  listDistributionLists: vi.fn(async () => []),
}));

vi.mock('../meetings/meetingMonitor', () => ({
  subscribeToMeeting: vi.fn(async () => ({ success: true })),
  unsubscribeFromMeeting: vi.fn(async () => ({ success: true })),
  postToMeetingChat: vi.fn(async () => ({ success: true })),
  getActiveSubscriptions: vi.fn(() => []),
  MEETING_TOOL_DEFINITIONS: [],
}));

vi.mock('../meetings/meetingContext', () => ({
  getMeetingSummary: vi.fn(async () => null),
  addActionItem: vi.fn(async () => ({ success: true })),
  getActiveMeetings: vi.fn(() => []),
  getMeetingSession: vi.fn(() => null),
}));

vi.mock('../voice/callManager', () => ({
  initiateCall: vi.fn(async () => ({ success: true, callId: 'test-call' })),
  endCall: vi.fn(async () => ({ success: true })),
  transferCall: vi.fn(async () => ({ success: true })),
  getActiveCalls: vi.fn(() => []),
}));

vi.mock('../voice/speechProcessor', () => ({
  isVoiceAvailable: vi.fn(() => false),
  getVoiceConfig: vi.fn(() => ({ available: false })),
}));

vi.mock('../intelligence/predictiveEngine', () => ({
  getOperationalRiskScore: vi.fn(async () => ({ riskScore: 45, factors: [] })),
  getActivePredictions: vi.fn(async () => []),
  acknowledgePrediction: vi.fn(async () => ({ success: true })),
  INTELLIGENCE_TOOL_DEFINITIONS: [],
}));

vi.mock('../intelligence/orgGraph', () => ({
  getOrgNode: vi.fn(async () => null),
  getEscalationChain: vi.fn(async () => []),
  getDepartmentSummary: vi.fn(async () => null),
  findExpertise: vi.fn(async () => []),
  getTeamInfo: vi.fn(async () => null),
}));

vi.mock('../memory/longTermMemory', () => ({
  rememberFact: vi.fn(async () => ({ stored: true })),
  rememberDecision: vi.fn(async () => ({ stored: true })),
  rememberPreference: vi.fn(async () => ({ stored: true })),
  recall: vi.fn(async () => []),
  forgetMemory: vi.fn(async () => ({ deleted: true })),
  getMemoryStats: vi.fn(async () => ({ total: 0 })),
}));

vi.mock('../orchestrator/agentRegistry', () => ({
  listAgents: vi.fn(async () => []),
  healthCheckAllAgents: vi.fn(async () => []),
  seedDefaultAgents: vi.fn(async () => {}),
  ORCHESTRATOR_TOOL_DEFINITIONS: [],
}));

vi.mock('../orchestrator/taskRouter', () => ({
  askAgent: vi.fn(async () => ({ success: true, response: 'test' })),
  routeToMultipleAgents: vi.fn(async () => ({ responses: [] })),
}));

vi.mock('../proactive/userRegistry', () => ({
  updateUserPrefs: vi.fn(async () => ({ success: true, message: 'Updated' })),
  getUser: vi.fn(async () => null),
  getNotificationPrefsFromProfile: vi.fn(() => ({})),
}));

vi.mock('./reportTools', () => ({ REPORT_TOOL_DEFINITIONS: [] }));
vi.mock('./meetingTools', () => ({ MEETING_TOOL_DEFINITIONS: [] }));
vi.mock('./voiceTools', () => ({ VOICE_TOOL_DEFINITIONS: [] }));
vi.mock('./intelligenceTools', () => ({ INTELLIGENCE_TOOL_DEFINITIONS: [] }));
vi.mock('./orchestratorTools', () => ({ ORCHESTRATOR_TOOL_DEFINITIONS: [] }));

import { getAllTools, executeTool } from './index';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tools/index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAllTools', () => {
    it('returns an array of tool definitions', () => {
      const tools = getAllTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('each tool has function type and valid name', () => {
      const tools = getAllTools();
      for (const t of tools) {
        expect(t.type).toBe('function');
        expect(typeof t.function.name).toBe('string');
        expect(t.function.name.length).toBeGreaterThan(0);
      }
    });

    it('has no duplicate tool names', () => {
      const tools = getAllTools();
      const names = tools.map(t => t.function.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('executeTool — operations', () => {
    it('dispatches getOverdueTasks', async () => {
      const result = await executeTool('getOverdueTasks', {});
      const parsed = JSON.parse(result);
      expect(parsed.source).toBe('demo');
      expect(typeof parsed.total).toBe('number');
    });

    it('dispatches getTeamWorkload', async () => {
      const result = await executeTool('getTeamWorkload', {});
      const parsed = JSON.parse(result);
      expect(parsed.source).toBe('demo');
      expect(Array.isArray(parsed.members)).toBe(true);
    });

    it('dispatches getPendingApprovals', async () => {
      const result = await executeTool('getPendingApprovals', {});
      const parsed = JSON.parse(result);
      expect(parsed.source).toBe('demo');
      expect(typeof parsed.total).toBe('number');
    });

    it('dispatches prioritizeBacklog', async () => {
      const result = await executeTool('prioritizeBacklog', {
        tasks: [{ id: '1', title: 'Test', due_date: '2020-01-01' }],
      });
      const parsed = JSON.parse(result);
      expect(parsed.prioritized.length).toBe(1);
    });
  });

  describe('executeTool — utility tools', () => {
    it('dispatches get_current_date', async () => {
      const result = await executeTool('get_current_date', {});
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('isoDate');
      expect(parsed).toHaveProperty('localDate');
    });

    it('dispatches get_organization_context', async () => {
      const result = await executeTool('get_organization_context', {});
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('description');
    });
  });

  describe('executeTool — MCP tools', () => {
    it('dispatches getMcpTools', async () => {
      const result = await executeTool('getMcpTools', {});
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('tools');
    });

    it('dispatches sendEmail (returns MCP unavailable)', async () => {
      const result = await executeTool('sendEmail', { to: 'a@b.com', subject: 'Hi', body: 'Test' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe('executeTool — report tools', () => {
    it('dispatches listReportTemplates', async () => {
      const result = await executeTool('listReportTemplates', {});
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('executeTool — memory tools', () => {
    it('dispatches rememberThis', async () => {
      const result = await executeTool('rememberThis', { content: 'Test fact', category: 'fact' });
      const parsed = JSON.parse(result);
      expect(parsed.stored).toBe(true);
    });

    it('dispatches recallMemory', async () => {
      const result = await executeTool('recallMemory', { query: 'test' });
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('executeTool — unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const result = await executeTool('nonexistent_tool', {});
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeTruthy();
    });
  });

  describe('executeTool — error handling', () => {
    it('returns error JSON when a tool throws', async () => {
      // Force an error by passing invalid params to a tool that would fail
      const result = await executeTool('formatForTeams', { content: undefined as unknown as string });
      // Should return valid JSON (not throw)
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });
});
