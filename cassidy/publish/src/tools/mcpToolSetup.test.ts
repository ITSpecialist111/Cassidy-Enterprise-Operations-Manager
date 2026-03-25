import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP service and tooling dependencies BEFORE importing the module
vi.mock('@microsoft/agents-a365-tooling', () => ({
  McpToolServerConfigurationService: class {
    getServerConfigurations() { return []; }
  },
  Utility: {
    GetToolRequestHeaders: vi.fn(() => ({})),
  },
}));

vi.mock('@microsoft/agents-a365-runtime', () => ({
  AgenticAuthenticationService: {
    GetAgenticUserToken: vi.fn(),
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  },
}));

vi.mock('@microsoft/agents-hosting', () => ({
  TurnContext: class {},
}));

import {
  sendTeamsMessage,
  sendEmail,
  createPlannerTask,
  updatePlannerTask,
  scheduleCalendarEvent,
  readSharePointList,
} from '../tools/mcpToolSetup';

describe('mcpToolSetup — DEMO fallbacks (no MCP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendTeamsMessage', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await sendTeamsMessage({
        channel_id: 'ch-1',
        message: 'Hello team',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP TeamsServer unavailable');
      expect(result.error).toContain('NOT sent');
    });
  });

  describe('sendEmail', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await sendEmail({
        to: 'alice@example.com',
        subject: 'Test',
        body: 'Test body',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP MailTools unavailable');
      expect(result.error).toContain('NOT sent');
    });
  });

  describe('createPlannerTask', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await createPlannerTask({
        title: 'Test Task',
        assigned_to: 'alice@example.com',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP PlannerServer unavailable');
      expect(result.error).toContain('NOT created');
    });
  });

  describe('updatePlannerTask', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await updatePlannerTask({
        task_id: 'task-123',
        percent_complete: 50,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP PlannerServer unavailable');
      expect(result.error).toContain('NOT updated');
    });
  });

  describe('scheduleCalendarEvent', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await scheduleCalendarEvent({
        title: 'Team Meeting',
        attendees: ['alice@example.com'],
        start_datetime: '2026-04-01T09:00:00',
        end_datetime: '2026-04-01T10:00:00',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP CalendarTools unavailable');
      expect(result.error).toContain('NOT created');
    });
  });

  describe('readSharePointList', () => {
    it('returns failure when MCP unavailable', async () => {
      const result = await readSharePointList({
        site_url: 'https://contoso.sharepoint.com',
        list_name: 'Tasks',
      });
      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error).toContain('MCP SharePointListsTools unavailable');
    });
  });
});
