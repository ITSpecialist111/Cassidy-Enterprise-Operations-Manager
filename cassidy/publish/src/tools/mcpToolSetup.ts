// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatCompletionTool } from 'openai/resources/chat';
import { TurnContext } from '@microsoft/agents-hosting';
import { McpToolServerConfigurationService, Utility as ToolingUtility } from '@microsoft/agents-a365-tooling';
import type { MCPServerConfig, McpClientTool, ToolOptions } from '@microsoft/agents-a365-tooling';
import { AgenticAuthenticationService } from '@microsoft/agents-a365-runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { features, config as appConfig } from '../featureConfig';

// ---------------------------------------------------------------------------
// MCP Service (singleton per process)
// ---------------------------------------------------------------------------

const mcpService = new McpToolServerConfigurationService();

let _serverConfigCache: MCPServerConfig[] | null = null;
let _serverConfigExpiry = 0;
const SERVER_CONFIG_TTL_MS = 5 * 60 * 1000; // 5 min

// Only load tools from servers we explicitly configured — the gateway may return
// additional canary/v1/preview servers we don't want.
const CONFIGURED_SERVERS = new Set([
  'mcp_CalendarTools',
  'mcp_PlannerServer',
  'mcp_MailTools',
  'mcp_TeamsServer',
  'mcp_SharePointServer',
  'mcp_OneDriveServer',
]);

let _toolDefinitionCache: ChatCompletionTool[] | null = null;
const _toolServerMap: Map<string, MCPServerConfig> = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isMcpAvailable(): boolean {
  return features.mcpAvailable;
}

function getAuthHandlerName(): string {
  return process.env.agentic_connectionName ?? 'AgenticAuthConnection';
}

function getToolOptions(): ToolOptions | undefined {
  const orchestratorName = process.env.AGENTIC_ORCHESTRATOR_NAME ?? process.env.WEBSITE_SITE_NAME;
  return orchestratorName ? { orchestratorName } : undefined;
}

function normalizeServerConfig(config: MCPServerConfig, context?: TurnContext): MCPServerConfig {
  const tenantId =
    context?.activity?.conversation?.tenantId ??
    process.env.connections__service_connection__settings__tenantId ??
    process.env.MicrosoftAppTenantId;

  if (!tenantId) return config;

  const headers = { ...(config.headers ?? {}) };
  const tenantHeaderKeys = ['x-ms-tenant-id', 'x-tenant-id', 'tenant-id', 'tenantId'];

  let hasTenantHeader = false;
  for (const key of tenantHeaderKeys) {
    if (Object.prototype.hasOwnProperty.call(headers, key)) {
      hasTenantHeader = true;
      const value = headers[key]?.trim();
      if (!value) headers[key] = tenantId;
    }
  }

  if (!hasTenantHeader) {
    headers['x-ms-tenant-id'] = tenantId;
  }

  return { ...config, headers };
}

const MCP_PLATFORM_SCOPE = 'ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default';

/**
 * Obtain OBO token for the MCP platform and build proper request headers.
 * The tooling gateway returns server configs without auth headers — the caller
 * (getMcpClientTools) needs these headers to authenticate to each MCP server.
 */
async function getOboToolHeaders(context: TurnContext): Promise<Record<string, string>> {
  try {
    const { agentApplication } = require('../agent') as {
      agentApplication: { authorization: import('@microsoft/agents-hosting').Authorization };
    };
    const token = await AgenticAuthenticationService.GetAgenticUserToken(
      agentApplication.authorization,
      getAuthHandlerName(),
      context,
      [MCP_PLATFORM_SCOPE],
    );
    if (!token) {
      console.warn('[MCP] OBO token exchange returned empty token for tool headers');
      return {};
    }
    return ToolingUtility.GetToolRequestHeaders(token, context, getToolOptions());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MCP] Could not obtain OBO tool headers: ${msg}`);
    return {};
  }
}

async function discoverViaClientCredentials(blueprintId: string): Promise<MCPServerConfig[]> {
  if (!process.env.MicrosoftAppTenantId || !process.env.MicrosoftAppId || !process.env.MicrosoftAppPassword) {
    return [];
  }

  const { ClientSecretCredential } = await import('@azure/identity');
  const credential = new ClientSecretCredential(
    process.env.MicrosoftAppTenantId,
    process.env.MicrosoftAppId,
    process.env.MicrosoftAppPassword,
  );
  const tokenResult = await credential.getToken('ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default');
  return mcpService.listToolServers(blueprintId, tokenResult.token, getToolOptions());
}

async function getServerConfigs(context?: TurnContext): Promise<MCPServerConfig[]> {
  const now = Date.now();
  if (_serverConfigCache && now < _serverConfigExpiry) return _serverConfigCache;

  const blueprintId = process.env.MicrosoftAppId ?? process.env.agent_id ?? '';
  let discovered: MCPServerConfig[];

  try {
    if (context) {
      // Preferred: TurnContext overload — performs OBO token exchange automatically.
      const { agentApplication } = require('../agent') as { agentApplication: { authorization: import('@microsoft/agents-hosting').Authorization } };
      discovered = await mcpService.listToolServers(
        context,
        agentApplication.authorization,
        getAuthHandlerName(),
        undefined,
        getToolOptions(),
      );

      // If OBO returns no servers, try app-only discovery as a fallback to avoid empty tool turns.
      if (discovered.length === 0) {
        console.warn('[MCP] OBO discovery returned 0 servers; trying app-only fallback');
        discovered = await discoverViaClientCredentials(blueprintId);
      }
    } else {
      discovered = await discoverViaClientCredentials(blueprintId);
    }

    _serverConfigCache = discovered;
    _serverConfigExpiry = now + SERVER_CONFIG_TTL_MS;
    console.log(`[MCP] Discovered ${_serverConfigCache.length} server(s) from tooling gateway`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Second chance: if the preferred path failed, try app-only discovery before giving up.
    if (context) {
      try {
        const fallback = await discoverViaClientCredentials(blueprintId);
        _serverConfigCache = fallback;
        _serverConfigExpiry = now + SERVER_CONFIG_TTL_MS;
        console.warn(`[MCP] Context discovery failed (${msg}). App-only fallback discovered ${fallback.length} server(s).`);
        return _serverConfigCache;
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.warn(`[MCP] Fallback discovery also failed: ${fallbackMsg}`);
      }
    }

    console.warn(`[MCP] Failed to discover servers: ${msg}. Tool definitions will be empty.`);
    _serverConfigCache = _serverConfigCache ?? [];
    _serverConfigExpiry = now + SERVER_CONFIG_TTL_MS;
  }

  return _serverConfigCache;
}

async function buildToolDefinitions(context?: TurnContext): Promise<ChatCompletionTool[]> {
  if (_toolDefinitionCache) return _toolDefinitionCache;

  const configs = await getServerConfigs(context);
  const tools: ChatCompletionTool[] = [];
  _toolServerMap.clear();

  // Obtain OBO-derived auth headers to enrich each server config.
  // The gateway returns configs without auth headers; the MCP servers need them.
  const oboHeaders = context ? await getOboToolHeaders(context) : {};
  if (Object.keys(oboHeaders).length > 0) {
    console.log(`[MCP] OBO tool headers obtained: [${Object.keys(oboHeaders).join(', ')}]`);
  } else {
    console.warn('[MCP] No OBO tool headers available — MCP servers may reject requests');
  }

  // Filter to only our configured servers
  const filteredConfigs = configs.filter(c => CONFIGURED_SERVERS.has(c.mcpServerName));
  if (filteredConfigs.length < configs.length) {
    const skipped = configs.filter(c => !CONFIGURED_SERVERS.has(c.mcpServerName)).map(c => c.mcpServerName);
    console.log(`[MCP] Skipping unconfigured server(s): ${skipped.join(', ')}`);
  }

  for (const config of filteredConfigs) {
    try {
      // Merge: OBO-derived headers as base, overlay with non-empty gateway headers
      const mergedHeaders: Record<string, string> = { ...oboHeaders };
      for (const [k, v] of Object.entries(config.headers ?? {})) {
        if (v?.trim()) mergedHeaders[k] = v;
      }
      const enrichedConfig: MCPServerConfig = { ...config, headers: mergedHeaders };
      const normalizedConfig = normalizeServerConfig(enrichedConfig, context);

      console.log(`[MCP] Connecting to ${normalizedConfig.mcpServerName}, headers: [${Object.keys(normalizedConfig.headers ?? {}).join(', ')}]`);

      const mcpTools: McpClientTool[] = await mcpService.getMcpClientTools(
        normalizedConfig.mcpServerName,
        normalizedConfig,
      );
      for (const t of mcpTools) {
        const tool: ChatCompletionTool = {
          type: 'function',
          function: {
            name: t.name,
            description: t.description ?? `${normalizedConfig.mcpServerName} tool: ${t.name}`,
            parameters: {
              type: t.inputSchema.type,
              properties: t.inputSchema.properties ?? {},
              required: t.inputSchema.required ?? [],
            },
          },
        };
        tools.push(tool);
        _toolServerMap.set(t.name, normalizedConfig);
      }
      console.log(`[MCP] Loaded ${mcpTools.length} tool(s) from ${normalizedConfig.mcpServerName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MCP] Failed to load tools from ${config.mcpServerName}: ${msg}`);
    }
  }

  _toolDefinitionCache = tools;
  return tools;
}

// ---------------------------------------------------------------------------
// Invoke an MCP tool by name using StreamableHTTP transport
// ---------------------------------------------------------------------------

const MCP_TOOL_TIMEOUT_MS = appConfig.mcpToolTimeoutMs; // per MCP tool call

export async function invokeMcpTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  const serverConfig = _toolServerMap.get(toolName);
  if (!serverConfig) {
    throw new Error(`[MCP] No server found for tool "${toolName}"`);
  }

  const client = new Client({ name: 'cassidy-ops-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: { headers: serverConfig.headers ?? {} },
  });

  try {
    await client.connect(transport);
    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: params }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[MCP] Tool "${toolName}" timeout after ${MCP_TOOL_TIMEOUT_MS / 1000}s`)), MCP_TOOL_TIMEOUT_MS)
      ),
    ]);
    return result;
  } finally {
    try { await client.close(); } catch (closeErr) { console.debug('[MCP] Client close error (non-blocking):', closeErr); }
  }
}

// ---------------------------------------------------------------------------
// Public API — called by tools/index.ts
// ---------------------------------------------------------------------------

export async function getLiveMcpToolDefinitions(context?: TurnContext): Promise<ChatCompletionTool[]> {
  if (!isMcpAvailable()) return [];
  return buildToolDefinitions(context);
}

export function hasMcpToolServer(toolName: string): boolean {
  return _toolServerMap.has(toolName);
}

export function invalidateMcpCache(): void {
  _serverConfigCache = null;
  _toolDefinitionCache = null;
  _toolServerMap.clear();
  console.log('[MCP] Cache invalidated');
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  available: boolean;
  endpoint: string;
  serverCount: number;
  toolCount: number;
}

export interface TeamsMessageResult { success: boolean; messageId?: string; error?: string; }
export interface EmailResult { success: boolean; messageId?: string; error?: string; }
export interface PlannerTaskResult { success: boolean; taskId?: string; taskUrl?: string; error?: string; }
export interface CalendarEventResult { success: boolean; eventId?: string; joinUrl?: string; error?: string; }
export interface SharePointListResult { success: boolean; data: unknown; source: 'mcp' | 'mock'; error?: string; }

// ---------------------------------------------------------------------------
// getMcpTools — status check
// ---------------------------------------------------------------------------

export async function getMcpTools(context?: TurnContext): Promise<McpToolInfo> {
  if (!isMcpAvailable()) {
    return { available: false, endpoint: '', serverCount: 0, toolCount: 0 };
  }
  const tools = await getLiveMcpToolDefinitions(context);
  const servers = new Set(
    tools.map(t => _toolServerMap.get((t as { function?: { name?: string } }).function?.name ?? '')?.mcpServerName)
  ).size;
  return {
    available: true,
    endpoint: process.env.MCP_PLATFORM_ENDPOINT!,
    serverCount: servers,
    toolCount: tools.length,
  };
}

// ---------------------------------------------------------------------------
// sendTeamsMessage — TeamsServer
// ---------------------------------------------------------------------------

export async function sendTeamsMessage(
  params: { channel_id: string; message: string; subject?: string },
  context?: TurnContext,
): Promise<TeamsMessageResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const result = await invokeMcpTool('mcp_TeamsServer_sendChannelMessage', {
        channelId: params.channel_id,
        content: params.message,
        subject: params.subject,
      }) as { messageId?: string };
      console.log(`[MCP] Teams message sent to channel ${params.channel_id}`);
      return { success: true, messageId: result?.messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] sendTeamsMessage failed: ${error}`);
      return { success: false, error };
    }
  }
  console.warn(`[Cassidy] sendTeamsMessage unavailable — MCP servers not connected (no TurnContext). channel:${params.channel_id}`);
  return { success: false, error: 'MCP TeamsServer unavailable — cannot send Teams messages without an active user session. The message was NOT sent.' };
}

// ---------------------------------------------------------------------------
// sendEmail — MailTools
// ---------------------------------------------------------------------------

export async function sendEmail(
  params: { to: string; subject: string; body: string; importance?: 'normal' | 'high' },
  context?: TurnContext,
): Promise<EmailResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const result = await invokeMcpTool('mcp_MailTools_sendMail', {
        to: params.to,
        subject: params.subject,
        body: params.body,
        importance: params.importance ?? 'normal',
      }) as { messageId?: string };
      console.log(`[MCP] Email sent to ${params.to}`);
      return { success: true, messageId: result?.messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] sendEmail failed: ${error}`);
      return { success: false, error };
    }
  }
  console.warn(`[Cassidy] sendEmail unavailable — MCP servers not connected (no TurnContext). to:${params.to}`);
  return { success: false, error: 'MCP MailTools unavailable — cannot send email without an active user session. The email was NOT sent.' };
}

// ---------------------------------------------------------------------------
// createPlannerTask — PlannerServer
// ---------------------------------------------------------------------------

export async function createPlannerTask(
  params: {
    title: string;
    assigned_to?: string;
    due_date?: string;
    bucket_name?: string;
    notes?: string;
    priority?: number;
  },
  context?: TurnContext,
): Promise<PlannerTaskResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const result = await invokeMcpTool('mcp_PlannerServer_createTask', {
        title: params.title,
        assignedTo: params.assigned_to,
        dueDate: params.due_date,
        bucketName: params.bucket_name,
        notes: params.notes,
        priority: params.priority ?? 5,
      }) as { taskId?: string; taskUrl?: string };
      console.log(`[MCP] Planner task created: "${params.title}"`);
      return { success: true, taskId: result?.taskId, taskUrl: result?.taskUrl };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] createPlannerTask failed: ${error}`);
      return { success: false, error };
    }
  }
  console.warn(`[Cassidy] createPlannerTask unavailable — MCP servers not connected (no TurnContext). task:"${params.title}"`);
  return { success: false, error: 'MCP PlannerServer unavailable — cannot create Planner tasks without an active user session. The task was NOT created.' };
}

// ---------------------------------------------------------------------------
// updatePlannerTask — PlannerServer
// ---------------------------------------------------------------------------

export async function updatePlannerTask(
  params: {
    task_id: string;
    title?: string;
    percent_complete?: number;
    due_date?: string;
    notes?: string;
  },
  context?: TurnContext,
): Promise<PlannerTaskResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const result = await invokeMcpTool('mcp_PlannerServer_updateTask', {
        taskId: params.task_id,
        title: params.title,
        percentComplete: params.percent_complete,
        dueDate: params.due_date,
        notes: params.notes,
      }) as { taskId?: string };
      console.log(`[MCP] Planner task updated: ${params.task_id}`);
      return { success: true, taskId: result?.taskId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] updatePlannerTask failed: ${error}`);
      return { success: false, error };
    }
  }
  console.warn(`[Cassidy] updatePlannerTask unavailable — MCP servers not connected (no TurnContext). id:${params.task_id}`);
  return { success: false, error: 'MCP PlannerServer unavailable — cannot update Planner tasks without an active user session. The task was NOT updated.' };
}

// ---------------------------------------------------------------------------
// scheduleCalendarEvent — CalendarTools
// ---------------------------------------------------------------------------

export async function scheduleCalendarEvent(
  params: {
    title: string;
    attendees: string[];
    start_datetime: string;
    end_datetime: string;
    body?: string;
    is_online_meeting?: boolean;
  },
  context?: TurnContext,
): Promise<CalendarEventResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const result = await invokeMcpTool('mcp_CalendarTools_createEvent', {
        title: params.title,
        attendees: params.attendees,
        startDateTime: params.start_datetime,
        endDateTime: params.end_datetime,
        body: params.body,
        isOnlineMeeting: params.is_online_meeting ?? true,
      }) as { eventId?: string; joinUrl?: string };
      console.log(`[MCP] Calendar event created: "${params.title}"`);
      return { success: true, eventId: result?.eventId, joinUrl: result?.joinUrl };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] scheduleCalendarEvent failed: ${error}`);
      return { success: false, error };
    }
  }
  console.warn(`[Cassidy] scheduleCalendarEvent unavailable — MCP servers not connected (no TurnContext). event:"${params.title}"`);
  return { success: false, error: 'MCP CalendarTools unavailable — cannot schedule calendar events without an active user session. The event was NOT created.' };
}

// ---------------------------------------------------------------------------
// findUser — Microsoft Graph user/people search
// ---------------------------------------------------------------------------

export interface FindUserResult {
  success: boolean;
  users: Array<{ displayName: string; email: string; jobTitle?: string; department?: string }>;
  error?: string;
}

export async function findUser(
  params: { query: string },
  context?: TurnContext,
): Promise<FindUserResult> {
  // Try MCP people search first if available
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      if (_toolServerMap.has('mcp_PeopleTools_searchUsers') || _toolServerMap.has('mcp_DirectoryTools_searchUsers')) {
        const toolName = _toolServerMap.has('mcp_PeopleTools_searchUsers')
          ? 'mcp_PeopleTools_searchUsers'
          : 'mcp_DirectoryTools_searchUsers';
        const result = await invokeMcpTool(toolName, { query: params.query }) as { users?: FindUserResult['users'] };
        return { success: true, users: result?.users ?? [] };
      }
    } catch (mcpErr) { console.warn('[MCP] findUser via MCP failed, falling through to Graph:', mcpErr); }
  }

  // Direct Microsoft Graph call — /v1.0/users?$filter=startsWith(displayName,'...')
  try {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const cred = new DefaultAzureCredential();
    const tokenResult = await cred.getToken('https://graph.microsoft.com/.default');
    // Sanitise single quotes for OData filter (prevent injection)
    const safeQuery = params.query.replace(/'/g, "''");
    const q = encodeURIComponent(safeQuery);
    const url = `https://graph.microsoft.com/v1.0/users?$filter=startsWith(displayName,'${q}') or startsWith(mail,'${q}') or startsWith(userPrincipalName,'${q}')&$select=displayName,mail,userPrincipalName,jobTitle,department&$top=10`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenResult.token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph API ${res.status}: ${text}`);
    }
    const data = await res.json() as { value: Array<{ displayName: string; mail?: string; userPrincipalName?: string; jobTitle?: string; department?: string }> };
    const users = data.value.map(u => ({
      displayName: u.displayName,
      email: u.mail ?? u.userPrincipalName ?? '',
      jobTitle: u.jobTitle ?? undefined,
      department: u.department ?? undefined,
    }));
    console.debug(`[Graph] findUser → ${users.length} result(s)`);
    return { success: true, users };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Graph] findUser failed: ${error}`);
    return { success: false, users: [], error };
  }
}

// ---------------------------------------------------------------------------
// readSharePointList — SharePointListsTools
// ---------------------------------------------------------------------------

export async function readSharePointList(
  params: { site_url: string; list_name: string; filter?: string },
  context?: TurnContext,
): Promise<SharePointListResult> {
  if (isMcpAvailable()) {
    try {
      await buildToolDefinitions(context);
      const data = await invokeMcpTool('mcp_SharePointListsTools_getListItems', {
        siteUrl: params.site_url,
        listName: params.list_name,
        filter: params.filter,
      });
      console.log(`[MCP] SharePoint list read: ${params.site_url}/${params.list_name}`);
      return { success: true, data, source: 'mcp' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] readSharePointList failed: ${error}`);
      return { success: false, data: null, source: 'mcp', error };
    }
  }
  console.warn(`[Cassidy] readSharePointList unavailable — MCP servers not connected (no TurnContext). list:${params.list_name}`);
  return { success: false, data: null, source: 'mock', error: 'MCP SharePointListsTools unavailable — cannot read SharePoint lists without an active user session.' };
}

// ---------------------------------------------------------------------------
// Static tool definitions
// ---------------------------------------------------------------------------

export const MCP_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'findUser',
      description: 'Search the organisation directory (Microsoft Graph / Global Address List) for a user by name, email, or display name. Use this before sending any email when you do not have a confirmed email address.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name, partial name, or email to search for, e.g. "mod admin", "Sarah", "alex.k".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMcpTools',
      description: 'Check Work IQ MCP platform status and list available tools (Teams, Mail, Planner, Calendar, SharePoint, etc.).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sendTeamsMessage',
      description: 'Send a message to a Microsoft Teams channel via Work IQ MCP.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Teams channel ID.' },
          message: { type: 'string', description: 'Message body (Markdown supported).' },
          subject: { type: 'string', description: 'Optional message subject/title.' },
        },
        required: ['channel_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sendEmail',
      description: 'Send an email via Microsoft 365 Mail using Work IQ MCP.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address.' },
          subject: { type: 'string', description: 'Email subject.' },
          body: { type: 'string', description: 'Email body (text or HTML).' },
          importance: { type: 'string', enum: ['normal', 'high'], description: 'Importance level.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createPlannerTask',
      description: 'Create a new task in Microsoft Planner via Work IQ MCP.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title.' },
          assigned_to: { type: 'string', description: 'User email or display name to assign the task to.' },
          due_date: { type: 'string', description: 'Due date in ISO format, e.g. "2026-03-25".' },
          bucket_name: { type: 'string', description: 'Planner bucket/column to place the task in.' },
          notes: { type: 'string', description: 'Additional task notes or description.' },
          priority: { type: 'number', description: 'Priority 0–10 (0=urgent, 5=medium, 10=low).' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updatePlannerTask',
      description: 'Update an existing Planner task — change title, progress percentage, due date, or notes.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The Planner task ID to update.' },
          title: { type: 'string', description: 'New task title.' },
          percent_complete: { type: 'number', description: 'Completion percentage (0–100). Use 100 to mark complete.' },
          due_date: { type: 'string', description: 'New due date in ISO format.' },
          notes: { type: 'string', description: 'Updated task notes.' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduleCalendarEvent',
      description: 'Create a calendar event or online meeting in Microsoft 365 Calendar via Work IQ MCP.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event/meeting title.' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses.' },
          start_datetime: { type: 'string', description: 'Start date/time in ISO 8601, e.g. "2026-03-25T10:00:00".' },
          end_datetime: { type: 'string', description: 'End date/time in ISO 8601.' },
          body: { type: 'string', description: 'Meeting agenda or body text.' },
          is_online_meeting: { type: 'boolean', description: 'Create as a Teams online meeting (default: true).' },
        },
        required: ['title', 'attendees', 'start_datetime', 'end_datetime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readSharePointList',
      description: 'Read items from a SharePoint list for project tracking data.',
      parameters: {
        type: 'object',
        properties: {
          site_url: { type: 'string', description: 'SharePoint site URL.' },
          list_name: { type: 'string', description: 'Name of the SharePoint list.' },
          filter: { type: 'string', description: 'OData filter expression, e.g. "Status eq \'Active\'".' },
        },
        required: ['site_url', 'list_name'],
      },
    },
  },
];
