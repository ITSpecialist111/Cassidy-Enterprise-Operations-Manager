// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Orchestrator Tools — GPT-5 tool definitions for multi-agent orchestration.
// Cassidy can consult specialist agents and coordinate cross-functional queries.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';

export const ORCHESTRATOR_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'askSpecialistAgent',
      description: 'Send a question to a specialist agent in the organisation. Cassidy will route the query to the most appropriate agent (e.g. Finance agent for budget questions, HR agent for headcount data). The agent will process the query and return domain-specific data.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The question to ask the specialist agent (e.g. "What is the current budget utilisation for Project Alpha?").',
          },
          agent_id: {
            type: 'string',
            description: 'Optional: specific agent ID to route to (e.g. "morgan-finance"). If omitted, Cassidy will auto-route based on the query content.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultMultipleAgents',
      description: 'Send a query to multiple specialist agents in parallel and receive aggregated results. Useful for cross-functional questions that span multiple domains (e.g. "What is the status of Project Alpha?" — may need ops, finance, and HR data).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The cross-functional question to ask.',
          },
          agent_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: specific agent IDs to consult. If omitted, Cassidy auto-detects relevant agents.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listSpecialistAgents',
      description: 'List all registered specialist agents in the organisation — their name, expertise, status, and reliability stats.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkAgentHealth',
      description: 'Check the health and availability of all registered specialist agents. Returns online/offline status for each.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
