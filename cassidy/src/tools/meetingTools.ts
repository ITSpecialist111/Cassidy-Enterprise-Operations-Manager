// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Meeting Tools — GPT-5 tool definitions for meeting intelligence.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';

export const MEETING_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'joinMeeting',
      description: 'Start monitoring a Teams meeting by subscribing to its live transcript. Cassidy will listen for her name and respond in the meeting chat. Requires the meeting ID (from a calendar event or Teams meeting URL).',
      parameters: {
        type: 'object',
        properties: {
          meeting_id: {
            type: 'string',
            description: 'The Teams online meeting ID. Can be extracted from a meeting URL or calendar event.',
          },
          organizer_name: {
            type: 'string',
            description: 'Name of the meeting organiser.',
          },
          organizer_email: {
            type: 'string',
            description: 'Email of the meeting organiser.',
          },
          chat_id: {
            type: 'string',
            description: 'The Teams chat thread ID for the meeting (used to post responses).',
          },
        },
        required: ['meeting_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leaveMeeting',
      description: 'Stop monitoring a Teams meeting — Cassidy will unsubscribe from the live transcript and end the session. Returns a summary of the meeting (participants, topics, action items).',
      parameters: {
        type: 'object',
        properties: {
          meeting_id: {
            type: 'string',
            description: 'The meeting ID to stop monitoring.',
          },
        },
        required: ['meeting_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMeetingSummary',
      description: 'Get a summary of a meeting Cassidy is currently monitoring or has recently monitored — duration, participants, topics discussed, action items detected, and recent transcript context.',
      parameters: {
        type: 'object',
        properties: {
          meeting_id: {
            type: 'string',
            description: 'The meeting ID to get a summary for.',
          },
        },
        required: ['meeting_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'postToMeetingChat',
      description: 'Post a message to a meeting\'s chat thread. Use this to proactively share information during a meeting without being asked.',
      parameters: {
        type: 'object',
        properties: {
          meeting_id: {
            type: 'string',
            description: 'The meeting ID whose chat to post to.',
          },
          message: {
            type: 'string',
            description: 'The message to post in the meeting chat.',
          },
        },
        required: ['meeting_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createMeetingActionItem',
      description: 'Manually add an action item detected during a meeting. Cassidy also auto-detects action items from the transcript.',
      parameters: {
        type: 'object',
        properties: {
          meeting_id: {
            type: 'string',
            description: 'The meeting ID to add the action item to.',
          },
          description: {
            type: 'string',
            description: 'Description of the action item.',
          },
          assignee: {
            type: 'string',
            description: 'Name of the person responsible for this action item.',
          },
          due_date: {
            type: 'string',
            description: 'Due date in ISO format (e.g. "2026-03-28").',
          },
        },
        required: ['meeting_id', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listActiveMeetings',
      description: 'List all meetings Cassidy is currently monitoring with their status, participant count, and duration.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
