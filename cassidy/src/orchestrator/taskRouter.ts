// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Task Router — intelligently routes queries to the best specialist agent
// based on the query's domain, agent expertise, and availability.
// Uses GPT-5 to classify the query domain when it's ambiguous.
// ---------------------------------------------------------------------------

import { AzureOpenAI } from 'openai';
import { cognitiveServicesTokenProvider } from '../auth';
import {
  listAgents,
  findAgentByExpertise,
  invokeAgent,
  type RegisteredAgent,
  type AgentInvocationResult,
} from './agentRegistry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  agentId: string;
  agentName: string;
  confidence: number;    // 0-100
  reason: string;
  fallback: boolean;     // true if no perfect match, using best guess
}

export interface MultiAgentResult {
  query: string;
  routing: RoutingDecision[];
  results: AgentInvocationResult[];
  aggregatedResponse: string;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Route a query to the best agent
// ---------------------------------------------------------------------------

export async function routeQuery(query: string): Promise<RoutingDecision | null> {
  const agents = await listAgents();
  if (agents.length === 0) return null;

  const onlineAgents = agents.filter(a => a.status !== 'offline');
  if (onlineAgents.length === 0) return null;

  // Try direct expertise matching first (fast path)
  const keywords = extractKeywords(query);
  for (const keyword of keywords) {
    const agent = await findAgentByExpertise(keyword);
    if (agent) {
      return {
        agentId: agent.rowKey,
        agentName: agent.displayName,
        confidence: 80,
        reason: `Matched on expertise keyword: "${keyword}"`,
        fallback: false,
      };
    }
  }

  // Ambiguous query — use GPT-5 to classify
  return classifyWithGPT5(query, onlineAgents);
}

// ---------------------------------------------------------------------------
// Route to multiple agents and aggregate results
// ---------------------------------------------------------------------------

export async function routeToMultipleAgents(
  query: string,
  targetAgentIds?: string[],
): Promise<MultiAgentResult> {
  const startTime = Date.now();
  const agents = await listAgents();

  let targets: RegisteredAgent[];
  if (targetAgentIds) {
    targets = agents.filter(a => targetAgentIds.includes(a.rowKey));
  } else {
    // Auto-detect which agents should be involved
    targets = await detectRelevantAgents(query, agents);
  }

  const routing: RoutingDecision[] = targets.map(a => ({
    agentId: a.rowKey,
    agentName: a.displayName,
    confidence: 70,
    reason: 'Multi-agent query — all relevant agents consulted',
    fallback: false,
  }));

  // Invoke all agents in parallel
  const results = await Promise.all(
    targets.map(a => invokeAgent(a.rowKey, query).catch(err => ({
      success: false,
      agentId: a.rowKey,
      agentName: a.displayName,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    } as AgentInvocationResult)))
  );

  // Aggregate responses
  const aggregatedResponse = aggregateResults(query, results);

  return {
    query,
    routing,
    results,
    aggregatedResponse,
    totalDurationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Single agent query with routing
// ---------------------------------------------------------------------------

export async function askAgent(query: string, agentId?: string): Promise<AgentInvocationResult> {
  if (agentId) {
    return invokeAgent(agentId, query);
  }

  const routing = await routeQuery(query);
  if (!routing) {
    return {
      success: false,
      agentId: '',
      agentName: '',
      durationMs: 0,
      error: 'No suitable agent found for this query. Try asking Cassidy directly.',
    };
  }

  console.log(`[TaskRouter] Routing "${query.slice(0, 60)}..." to ${routing.agentName} (confidence: ${routing.confidence}%)`);
  return invokeAgent(routing.agentId, query);
}

// ---------------------------------------------------------------------------
// GPT-5 classification for ambiguous queries
// ---------------------------------------------------------------------------

async function classifyWithGPT5(
  query: string,
  agents: RegisteredAgent[],
): Promise<RoutingDecision | null> {
  const openai = new AzureOpenAI({
    azureADTokenProvider: cognitiveServicesTokenProvider,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2025-04-01-preview',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
  });

  const agentDescriptions = agents.map(a => {
    const expertise = JSON.parse(a.expertise || '[]') as string[];
    return `- ${a.rowKey}: ${a.displayName} — ${a.description} (expertise: ${expertise.join(', ')})`;
  }).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `You are a task router. Given a user query and available specialist agents, determine which agent should handle this query.

Available agents:
${agentDescriptions}

Respond in JSON: { "agentId": "id", "confidence": 0-100, "reason": "why this agent" }
If NO agent is suitable, respond: { "agentId": null, "confidence": 0, "reason": "no match" }`,
        },
        { role: 'user', content: query },
      ],
      max_completion_tokens: 150,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const result = JSON.parse(content) as { agentId: string | null; confidence: number; reason: string };
    if (!result.agentId || result.confidence < 30) return null;

    const agent = agents.find(a => a.rowKey === result.agentId);
    if (!agent) return null;

    return {
      agentId: result.agentId,
      agentName: agent.displayName,
      confidence: result.confidence,
      reason: result.reason,
      fallback: result.confidence < 60,
    };
  } catch (err) {
    console.error('[TaskRouter] GPT-5 classification failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detect which agents are relevant for a multi-agent query
// ---------------------------------------------------------------------------

async function detectRelevantAgents(query: string, agents: RegisteredAgent[]): Promise<RegisteredAgent[]> {
  const relevant: RegisteredAgent[] = [];
  const keywords = extractKeywords(query);

  for (const agent of agents) {
    if (agent.status === 'offline') continue;

    try {
      const expertise = JSON.parse(agent.expertise) as string[];
      const isRelevant = keywords.some(k =>
        expertise.some(e => e.toLowerCase().includes(k) || k.includes(e.toLowerCase()))
      ) || agent.description.toLowerCase().split(' ').some(w => keywords.includes(w));

      if (isRelevant) relevant.push(agent);
    } catch (err) {
      console.warn(`[TaskRouter] Failed to parse expertise for agent ${agent.rowKey}:`, err);
    }
  }

  return relevant;
}

// ---------------------------------------------------------------------------
// Aggregate multi-agent results into a coherent response
// ---------------------------------------------------------------------------

function aggregateResults(query: string, results: AgentInvocationResult[]): string {
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);

  if (successes.length === 0) {
    return `I consulted ${results.length} specialist agent(s) but none could provide an answer. ${failures.map(f => `${f.agentName}: ${f.error}`).join('; ')}`;
  }

  const parts: string[] = [];
  for (const r of successes) {
    parts.push(`**${r.agentName}** (${r.durationMs}ms): ${r.response ?? 'No response text'}`);
  }

  if (failures.length > 0) {
    parts.push(`\n_Note: ${failures.length} agent(s) were unavailable: ${failures.map(f => f.agentName).join(', ')}_`);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Keyword extraction (fast, heuristic-based)
// ---------------------------------------------------------------------------

function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'must', 'need', 'want',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'and', 'but', 'or', 'not', 'no', 'if', 'then',
    'than', 'too', 'very', 'just', 'about', 'this', 'that', 'these',
    'those', 'such', 'what', 'which', 'who', 'whom', 'when', 'where',
    'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
    'some', 'other', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
    'he', 'she', 'it', 'they', 'them', 'their', 'its',
    'get', 'give', 'go', 'make', 'know', 'take', 'come', 'see', 'look',
    'find', 'tell', 'ask', 'use', 'work', 'call', 'try', 'let', 'help',
    'show', 'also', 'much', 'many', 'well', 'only', 'still', 'even',
    'cassidy', 'please', 'thanks', 'hi', 'hey', 'hello',
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}
