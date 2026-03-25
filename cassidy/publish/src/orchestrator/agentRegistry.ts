// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Agent Registry — manages connections to specialist agents in the org.
// Cassidy acts as an orchestrator, routing questions to domain-specific
// agents (Finance, HR, Legal, etc.) and aggregating their responses.
//
// Uses the Agent 365 SDK A2A (Agent-to-Agent) protocol for communication.
// ---------------------------------------------------------------------------

import { upsertEntity, getEntity, listEntities, deleteEntity } from '../memory/tableStorage';

const TABLE = 'CassidyAgentRegistry';
const PARTITION = 'agents';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = 'online' | 'offline' | 'degraded' | 'unknown';

export interface RegisteredAgent {
  partitionKey: string;
  rowKey: string;              // agent ID (unique slug)
  displayName: string;         // Human-readable name (e.g. "Morgan — Finance Agent")
  description: string;         // What this agent specialises in
  expertise: string;           // JSON array of expertise areas
  endpoint: string;            // A2A endpoint URL (e.g. "https://morgan-agent.azurewebsites.net/api/agent-messages")
  appId: string;               // Azure AD app ID for authentication
  status: AgentStatus;
  lastHealthCheck: string;     // ISO timestamp
  averageResponseMs: number;   // Average response time
  successRate: number;         // 0-100 success percentage
  totalInvocations: number;
  capabilities: string;        // JSON array of capability tags
  registeredAt: string;
  registeredBy: string;
  [key: string]: unknown;
}

export interface AgentInvocationResult {
  success: boolean;
  agentId: string;
  agentName: string;
  response?: string;
  data?: unknown;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Register / update agents
// ---------------------------------------------------------------------------

export async function registerAgent(params: {
  id: string;
  displayName: string;
  description: string;
  expertise: string[];
  endpoint: string;
  appId: string;
  capabilities?: string[];
  registeredBy?: string;
}): Promise<{ success: boolean; message: string }> {
  const agent: RegisteredAgent = {
    partitionKey: PARTITION,
    rowKey: params.id,
    displayName: params.displayName,
    description: params.description,
    expertise: JSON.stringify(params.expertise),
    endpoint: params.endpoint,
    appId: params.appId,
    status: 'unknown',
    lastHealthCheck: '',
    averageResponseMs: 0,
    successRate: 100,
    totalInvocations: 0,
    capabilities: JSON.stringify(params.capabilities ?? []),
    registeredAt: new Date().toISOString(),
    registeredBy: params.registeredBy ?? 'system',
  };

  await upsertEntity(TABLE, agent);
  console.log(`[AgentRegistry] Registered agent: ${params.displayName} (${params.id})`);
  return { success: true, message: `Agent "${params.displayName}" registered successfully.` };
}

export async function unregisterAgent(agentId: string): Promise<{ success: boolean }> {
  await deleteEntity(TABLE, PARTITION, agentId);
  console.log(`[AgentRegistry] Unregistered agent: ${agentId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Discovery & lookup
// ---------------------------------------------------------------------------

export async function getAgent(agentId: string): Promise<RegisteredAgent | null> {
  return getEntity<RegisteredAgent>(TABLE, PARTITION, agentId);
}

export async function listAgents(): Promise<RegisteredAgent[]> {
  return listEntities<RegisteredAgent>(TABLE, PARTITION);
}

export async function findAgentByExpertise(area: string): Promise<RegisteredAgent | null> {
  const agents = await listAgents();
  const lowerArea = area.toLowerCase();

  // Score each agent by expertise match
  let bestAgent: RegisteredAgent | null = null;
  let bestScore = 0;

  for (const agent of agents) {
    if (agent.status === 'offline') continue;

    let score = 0;
    try {
      const expertise = JSON.parse(agent.expertise) as string[];
      for (const exp of expertise) {
        if (exp.toLowerCase().includes(lowerArea) || lowerArea.includes(exp.toLowerCase())) {
          score += 10;
        }
      }
    } catch (err) {
      console.warn(`[AgentRegistry] Failed to parse expertise for agent ${agent.rowKey}:`, err);
    }

    // Also check description
    if (agent.description.toLowerCase().includes(lowerArea)) score += 5;

    // Prefer agents with better reliability
    score += (agent.successRate / 100) * 3;

    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }

  return bestAgent;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function healthCheckAgent(agentId: string): Promise<AgentStatus> {
  const agent = await getAgent(agentId);
  if (!agent) return 'unknown';

  try {
    const healthUrl = agent.endpoint.replace('/api/agent-messages', '/api/health');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const status: AgentStatus = res.ok ? 'online' : 'degraded';
    await upsertEntity(TABLE, {
      ...agent,
      status,
      lastHealthCheck: new Date().toISOString(),
    });

    return status;
  } catch {
    await upsertEntity(TABLE, {
      ...agent,
      status: 'offline' as AgentStatus,
      lastHealthCheck: new Date().toISOString(),
    });
    return 'offline';
  }
}

export async function healthCheckAllAgents(): Promise<Array<{ id: string; name: string; status: AgentStatus }>> {
  const agents = await listAgents();
  const results: Array<{ id: string; name: string; status: AgentStatus }> = [];

  for (const agent of agents) {
    const status = await healthCheckAgent(agent.rowKey);
    results.push({ id: agent.rowKey, name: agent.displayName, status });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Invoke an agent via A2A protocol
// ---------------------------------------------------------------------------

export async function invokeAgent(
  agentId: string,
  query: string,
  context?: Record<string, unknown>,
): Promise<AgentInvocationResult> {
  const agent = await getAgent(agentId);
  if (!agent) {
    return { success: false, agentId, agentName: 'unknown', durationMs: 0, error: `Agent "${agentId}" not found` };
  }

  const startTime = Date.now();

  try {
    // Build A2A message payload (Agent 365 SDK format)
    const payload = {
      type: 'message',
      text: query,
      from: {
        id: process.env.MicrosoftAppId ?? '',
        name: 'Cassidy',
      },
      channelId: 'a2a',
      context: {
        ...context,
        orchestratorId: 'cassidy-ops-agent',
        requestType: 'query',
      },
    };

    const res = await fetch(agent.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': process.env.MicrosoftAppId ?? 'cassidy-ops-agent',
        'X-Correlation-Id': `cassidy_${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });

    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      const errorText = await res.text();
      await updateAgentStats(agent, false, durationMs);
      return { success: false, agentId, agentName: agent.displayName, durationMs, error: `Agent returned ${res.status}: ${errorText}` };
    }

    const responseData = await res.json() as {
      text?: string;
      data?: unknown;
    };

    await updateAgentStats(agent, true, durationMs);

    console.log(`[AgentRegistry] ${agent.displayName} responded in ${durationMs}ms`);
    return {
      success: true,
      agentId,
      agentName: agent.displayName,
      response: responseData.text ?? JSON.stringify(responseData),
      data: responseData.data,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);
    await updateAgentStats(agent, false, durationMs);
    console.error(`[AgentRegistry] Agent ${agent.displayName} invocation failed:`, error);
    return { success: false, agentId, agentName: agent.displayName, durationMs, error };
  }
}

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------

async function updateAgentStats(agent: RegisteredAgent, success: boolean, durationMs: number): Promise<void> {
  const total = agent.totalInvocations + 1;
  const successCount = Math.round(agent.successRate / 100 * agent.totalInvocations) + (success ? 1 : 0);
  const avgMs = Math.round(((agent.averageResponseMs * agent.totalInvocations) + durationMs) / total);

  await upsertEntity(TABLE, {
    ...agent,
    totalInvocations: total,
    successRate: Math.round((successCount / total) * 100),
    averageResponseMs: avgMs,
    status: success ? 'online' : agent.status,
    lastHealthCheck: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Pre-seed known agents (called at startup)
// ---------------------------------------------------------------------------

export async function seedDefaultAgents(): Promise<void> {
  const existing = await listAgents();
  if (existing.length > 0) return; // Already seeded

  // Register known agents in the org
  const defaults = [
    {
      id: 'morgan-finance',
      displayName: 'Morgan — Finance Agent',
      description: 'Specialist in financial data: budgets, cost tracking, forecasting, procurement, and expense management.',
      expertise: ['finance', 'budget', 'costs', 'procurement', 'expenses', 'forecasting', 'P&L'],
      endpoint: process.env.FINANCE_AGENT_ENDPOINT ?? 'https://morgan-agent.azurewebsites.net/api/agent-messages',
      appId: process.env.FINANCE_AGENT_APP_ID ?? '',
      capabilities: ['query', 'report'],
    },
    {
      id: 'hr-agent',
      displayName: 'HR Agent',
      description: 'Specialist in people data: headcount, leave management, recruitment, and capacity planning.',
      expertise: ['hr', 'headcount', 'leave', 'recruitment', 'capacity', 'people', 'onboarding'],
      endpoint: process.env.HR_AGENT_ENDPOINT ?? 'https://hr-agent.azurewebsites.net/api/agent-messages',
      appId: process.env.HR_AGENT_APP_ID ?? '',
      capabilities: ['query', 'action'],
    },
  ];

  for (const agent of defaults) {
    await registerAgent(agent).catch(err =>
      console.error(`[AgentRegistry] Failed to seed agent ${agent.id}:`, err)
    );
  }

  console.log(`[AgentRegistry] Seeded ${defaults.length} default agents`);
}
