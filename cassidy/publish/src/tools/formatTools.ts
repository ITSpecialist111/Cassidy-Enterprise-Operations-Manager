// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatCompletionTool } from 'openai/resources/chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert markdown tables (which Teams bot messages do NOT render) into
 * readable bold-label lines.
 */
function convertMarkdownTables(md: string): string {
  return md.replace(
    /^\|(.+)\|\r?\n\|[-|: ]+\|\r?\n((?:^\|.+\|\r?\n?)*)/gm,
    (fullMatch) => {
      const lines = fullMatch.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 3) return fullMatch;

      const headers = lines[0].split('|').filter(c => c.trim()).map(c => c.trim());
      const dataRows = lines.slice(2);

      const converted = dataRows.map(line => {
        const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
        if (headers.length === 2) {
          return `**${cells[0] ?? ''}**: ${cells[1] ?? ''}`;
        }
        return cells.map((cell, i) =>
          i === 0 ? `**${cell}**` : `${headers[i] ?? i}: ${cell}`
        ).join(' · ');
      });

      return converted.join('\n') + '\n';
    },
  );
}

// ---------------------------------------------------------------------------
// 1. formatForTeams
// ---------------------------------------------------------------------------

export function formatForTeams(params: {
  content: string;
  message_type: 'alert' | 'report' | 'info' | 'standup' | 'approval';
}): string {
  const typeHeader: Record<string, string> = {
    alert:    '🚨 **OPERATIONS ALERT**',
    report:   '📊 **OPERATIONS REPORT**',
    info:     'ℹ️ **OPERATIONS UPDATE**',
    standup:  '📋 **DAILY STANDUP**',
    approval: '✅ **APPROVAL REQUEST**',
  };

  const header = typeHeader[params.message_type] ?? typeHeader.info;

  const trimmed = params.content
    .replace(/^#{1,6}\s+/gm, '**')
    .replace(/---+/g, '─────────────────────────')
    .slice(0, 20_000);

  const formatted = convertMarkdownTables(trimmed);

  return [
    header,
    '',
    formatted,
    '',
    '─────────────────────────',
    `*Sent by Cassidy · ${new Date().toUTCString()}*`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI Tool Definitions
// ---------------------------------------------------------------------------

export const FORMAT_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'formatForTeams',
      description: 'Convert a Markdown operations report or message into a Teams-friendly format with a type-specific header (alert / report / info / standup / approval).',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The Markdown content to format for Teams.',
          },
          message_type: {
            type: 'string',
            enum: ['alert', 'report', 'info', 'standup', 'approval'],
            description: 'Message type determines the header: "alert" for urgent, "report" for status reports, "standup" for daily standups, "approval" for approval requests.',
          },
        },
        required: ['content', 'message_type'],
      },
    },
  },
];
