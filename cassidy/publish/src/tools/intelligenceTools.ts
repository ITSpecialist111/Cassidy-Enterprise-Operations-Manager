// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Intelligence Tools — GPT-5 tool definitions for self-awareness capabilities:
// user profiling, org graph, predictive analytics, and long-term memory.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';

export const INTELLIGENCE_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  // --- Predictive Analytics ---
  {
    type: 'function',
    function: {
      name: 'getOperationalRiskScore',
      description: 'Get the current operational risk score (0-100) with contributing factors. Returns a traffic-light level (green/yellow/orange/red) and specific risk factors.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPredictions',
      description: 'Get active predictions about future operational issues — task delays, capacity crunches, approval bottlenecks, and trend shifts. Each prediction includes severity, confidence, and recommended action.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'acknowledgePrediction',
      description: 'Acknowledge a prediction, indicating the user has seen it and is aware.',
      parameters: {
        type: 'object',
        properties: {
          prediction_id: { type: 'string', description: 'The prediction ID to acknowledge.' },
        },
        required: ['prediction_id'],
      },
    },
  },

  // --- Org Graph ---
  {
    type: 'function',
    function: {
      name: 'getOrgChart',
      description: 'Get organisational information about a person — their manager, direct reports, team members, department, and escalation chain. Also useful for understanding reporting structure.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to look up. Use findUser first if you only have a name.' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getEscalationPath',
      description: 'Get the management escalation chain for a user — who their manager is, and their manager\'s manager, up to 5 levels.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to get the escalation path for.' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDepartmentOverview',
      description: 'Get a summary of all departments in the organisation — headcount, managers, and structure.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findExpert',
      description: 'Find people in the organisation with expertise in a specific area — searches job titles and documented expertise areas.',
      parameters: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'The expertise area to search for (e.g. "cloud architecture", "compliance", "data engineering").' },
        },
        required: ['area'],
      },
    },
  },

  // --- Long-Term Memory ---
  {
    type: 'function',
    function: {
      name: 'rememberThis',
      description: 'Store an important fact, decision, or preference in Cassidy\'s long-term memory so it can be recalled in future conversations. Use this when someone states a fact ("our vendor is Acme Corp"), makes a decision ("we\'re going with option B"), or expresses a preference ("send me reports on Mondays").',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact, decision, or preference to remember.' },
          category: { type: 'string', enum: ['fact', 'decision', 'preference'], description: 'Category of the memory.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags for easier recall (e.g. ["project-alpha", "vendor"]).' },
        },
        required: ['content', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recallMemory',
      description: 'Search Cassidy\'s long-term memory for relevant facts, decisions, and preferences. Use this when you need context that was discussed in a previous conversation.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in memory (natural language query).' },
          category: { type: 'string', enum: ['fact', 'decision', 'preference'], description: 'Optional: restrict search to a specific category.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forgetThis',
      description: 'Remove a specific memory from Cassidy\'s long-term memory. Use when a fact is no longer true or a decision has been reversed.',
      parameters: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'The memory ID to forget.' },
        },
        required: ['memory_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMemoryStats',
      description: 'Get statistics about Cassidy\'s long-term memory — total memories stored, breakdown by category, oldest and newest entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
