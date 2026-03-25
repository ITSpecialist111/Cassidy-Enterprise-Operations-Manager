// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Report Tools — GPT-5 tool definitions for report generation and distribution.
// ---------------------------------------------------------------------------

import type { ChatCompletionTool } from 'openai/resources/chat';

export const REPORT_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'generateReport',
      description: 'Generate a formatted report from a built-in template (weekly status, project health, team capacity, monthly brief) or from a custom specification. Returns structured content and optionally creates a Word/Excel/PowerPoint document in SharePoint.',
      parameters: {
        type: 'object',
        properties: {
          template_id: {
            type: 'string',
            description: 'Report template ID. Available: "weekly-ops-status" (Word), "project-health-dashboard" (PowerPoint), "team-capacity-report" (Excel), "monthly-executive-brief" (Word), "daily-standup-document" (Teams message).',
          },
          project_name: {
            type: 'string',
            description: 'Project name for project-specific reports (e.g. "IT Procurement").',
          },
          period: {
            type: 'string',
            description: 'Reporting period (e.g. "March 2026", "Q1 2026", "Week 12").',
          },
          date: {
            type: 'string',
            description: 'Specific date for daily reports (ISO format, e.g. "2026-03-21").',
          },
        },
        required: ['template_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listReportTemplates',
      description: 'List all available report templates with their names, descriptions, output formats, and schedules.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distributeReport',
      description: 'Email a previously generated report to a distribution list or specific email addresses. If a list_name is given, uses the saved distribution list. Otherwise, emails the addresses in the recipients array.',
      parameters: {
        type: 'object',
        properties: {
          template_id: {
            type: 'string',
            description: 'The template ID of the report to generate and distribute.',
          },
          list_name: {
            type: 'string',
            description: 'Name of a saved distribution list to send to.',
          },
          recipients: {
            type: 'array',
            items: { type: 'string' },
            description: 'Email addresses to send the report to (used if list_name is not provided).',
          },
          project_name: { type: 'string', description: 'Project name for project-specific reports.' },
          period: { type: 'string', description: 'Reporting period.' },
        },
        required: ['template_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createDistributionList',
      description: 'Create a named email distribution list for recurring report delivery. E.g. "leadership team" with 5 executive email addresses.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the distribution list (e.g. "leadership team", "project managers").' },
          members: {
            type: 'array',
            items: { type: 'string' },
            description: 'Email addresses of list members.',
          },
        },
        required: ['name', 'members'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listDistributionLists',
      description: 'List all saved distribution lists with their members.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'postReportToTeamsChannel',
      description: 'Generate a report and post it directly to the Operations Teams channel.',
      parameters: {
        type: 'object',
        properties: {
          template_id: { type: 'string', description: 'The report template ID to generate and post.' },
          channel_id: { type: 'string', description: 'Teams channel ID (defaults to Operations channel).' },
          project_name: { type: 'string', description: 'Project name for project-specific reports.' },
          period: { type: 'string', description: 'Reporting period.' },
        },
        required: ['template_id'],
      },
    },
  },
];
