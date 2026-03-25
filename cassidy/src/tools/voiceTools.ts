// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Voice Tools — GPT-5 tool definitions for voice call capabilities.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';

export const VOICE_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'callUser',
      description: 'Initiate a Microsoft Teams voice call to a user. Cassidy will call them, speak a greeting, and have a voice conversation about the specified topic. Use this for critical/urgent situations or when a Teams chat message hasn\'t received a response.',
      parameters: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The Azure AD user ID of the person to call. Use findUser first if you only have a name.',
          },
          display_name: {
            type: 'string',
            description: 'Display name of the person being called.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason for the call (e.g. "critical approval stalled for 7 days", "budget overrun on Project Alpha").',
          },
        },
        required: ['user_id', 'display_name', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'endVoiceCall',
      description: 'End an active voice call that Cassidy initiated.',
      parameters: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: 'The call ID to end.',
          },
        },
        required: ['call_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transferCall',
      description: 'Transfer an active voice call to another person (e.g. transfer from Cassidy to a human manager).',
      parameters: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: 'The call ID to transfer.',
          },
          transfer_to_user_id: {
            type: 'string',
            description: 'Azure AD user ID of the person to transfer to.',
          },
        },
        required: ['call_id', 'transfer_to_user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getVoiceStatus',
      description: 'Check whether voice calling is available and get information about any active calls Cassidy is in.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
