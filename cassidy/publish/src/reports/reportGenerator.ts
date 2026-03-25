// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Report Generator — orchestrates data gathering, GPT-5 narrative composition,
// and document creation via MCP tools (Word, Excel, PowerPoint).
// ---------------------------------------------------------------------------

import { AzureOpenAI } from 'openai';
import { cognitiveServicesTokenProvider } from '../auth';
import { TurnContext } from '@microsoft/agents-hosting';
import {
  getTemplate,
  listTemplates,
  ReportTemplate,
  ReportSection,
  OutputFormat,
} from './reportTemplates';
import {
  getOverdueTasks,
  getTeamWorkload,
  getPendingApprovals,
  generateStandupReport,
  generateProjectStatusReport,
  sendEmail,
  formatForTeams,
} from '../tools/index';
import { invokeMcpTool, hasMcpToolServer } from '../tools/mcpToolSetup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportResult {
  success: boolean;
  templateId: string;
  templateName: string;
  outputFormat: OutputFormat;
  content: string;            // the full rendered content (markdown/text)
  fileUrl?: string;           // SharePoint/OneDrive URL if document was created
  fileId?: string;            // document ID if created through MCP
  generatedAt: string;
  error?: string;
}

export interface DistributeResult {
  success: boolean;
  recipientCount: number;
  sentTo: string[];
  failures: string[];
}

// ---------------------------------------------------------------------------
// Data source dispatcher
// ---------------------------------------------------------------------------

function gatherSectionData(section: ReportSection): unknown {
  const { dataSource, dataParams } = section;

  switch (dataSource) {
    case 'getOverdueTasks':
      return getOverdueTasks(dataParams as Parameters<typeof getOverdueTasks>[0]);
    case 'getTeamWorkload':
      return getTeamWorkload(dataParams as Parameters<typeof getTeamWorkload>[0]);
    case 'getPendingApprovals':
      return getPendingApprovals(dataParams as Parameters<typeof getPendingApprovals>[0]);
    case 'generateStandupReport': {
      const params = { ...dataParams } as { date: string; include_blockers: boolean };
      if (!params.date) params.date = new Date().toISOString().slice(0, 10);
      return generateStandupReport(params);
    }
    case 'generateProjectStatusReport': {
      const params = { ...dataParams } as { project_name: string; period: string };
      if (!params.period) params.period = new Date().toISOString().slice(0, 7); // YYYY-MM
      return generateProjectStatusReport(params);
    }
    default:
      return { error: `Unknown data source: ${dataSource}` };
  }
}

// ---------------------------------------------------------------------------
// GPT-5 narrative composition
// ---------------------------------------------------------------------------

function getOpenAI(): AzureOpenAI {
  return new AzureOpenAI({
    azureADTokenProvider: cognitiveServicesTokenProvider,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2025-04-01-preview',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
  });
}

async function composeNarrative(
  section: ReportSection,
  data: unknown,
): Promise<string> {
  if (!section.narrativePrompt) {
    // No narrative needed — just format the data
    return formatDataAsText(section, data);
  }

  const openai = getOpenAI();

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
    messages: [
      {
        role: 'system',
        content: `You are Cassidy, an Operations Manager AI composing a section of a business report.
Write professional, data-driven content suitable for enterprise distribution.
Be concise, specific, and action-oriented. Use data from the context provided.
Do NOT use markdown tables — use bullet points or bold-label format instead.`,
      },
      {
        role: 'user',
        content: `Section: "${section.title}"
Instruction: ${section.narrativePrompt}

Source data:
${JSON.stringify(data, null, 2)}`,
      },
    ],
    max_completion_tokens: 1000,
  });

  return response.choices[0]?.message?.content?.trim() ?? formatDataAsText(section, data);
}

// ---------------------------------------------------------------------------
// Data formatting helpers
// ---------------------------------------------------------------------------

function formatDataAsText(section: ReportSection, data: unknown): string {
  if (typeof data === 'string') return data;

  const obj = data as Record<string, unknown>;

  switch (section.renderAs) {
    case 'table':
      return formatAsLabeledList(obj);
    case 'bullet_list':
      return formatAsBullets(obj);
    case 'kpi_card':
      return formatAsKpiCard(obj);
    case 'chart':
      return formatAsLabeledList(obj); // charts render as data tables in fallback
    default:
      return JSON.stringify(data, null, 2);
  }
}

function formatAsLabeledList(data: Record<string, unknown>): string {
  const lines: string[] = [];

  // Handle arrays of items (tasks, approvals, team members)
  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks as Array<Record<string, unknown>>) {
      lines.push(`- **${t.title}** · Owner: ${t.owner} · Due: ${t.dueDate} · Status: ${t.status}`);
    }
  } else if (Array.isArray(data.approvals)) {
    for (const a of data.approvals as Array<Record<string, unknown>>) {
      lines.push(`- **${a.title}** · Requestor: ${a.requestor} · Approver: ${a.approver} · ${a.submittedDaysAgo}d pending`);
    }
  } else if (Array.isArray(data.members)) {
    for (const m of data.members as Array<Record<string, unknown>>) {
      lines.push(`- **${m.name}** (${m.role}) · ${m.activeTasks} active · ${m.overdueCount} overdue · Capacity: ${m.capacity}`);
    }
  } else {
    // Generic key-value
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'object') {
        lines.push(`**${key}**: ${val}`);
      }
    }
  }

  return lines.join('\n');
}

function formatAsBullets(data: Record<string, unknown>): string {
  const lines: string[] = [];
  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks as Array<Record<string, unknown>>) {
      lines.push(`- ${t.title} (${t.owner}, ${t.daysOverdue}d overdue)`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(data, null, 2);
}

function formatAsKpiCard(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const entries = Object.entries(data).filter(([, v]) => typeof v !== 'object');
  for (const [key, val] of entries) {
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
    lines.push(`**${label}**: ${val}`);
  }
  return lines.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Main report generation
// ---------------------------------------------------------------------------

export async function generateReport(
  templateId: string,
  params?: { project_name?: string; period?: string; date?: string },
  context?: TurnContext,
): Promise<ReportResult> {
  const template = getTemplate(templateId);
  if (!template) {
    return {
      success: false,
      templateId,
      templateName: 'Unknown',
      outputFormat: 'teams_message',
      content: '',
      generatedAt: new Date().toISOString(),
      error: `Unknown report template: "${templateId}". Available: ${listTemplates().map(t => t.id).join(', ')}`,
    };
  }

  console.log(`[ReportGen] Generating "${template.name}" (${template.outputFormat})`);

  // Gather data and compose narrative for each section
  const sectionContents: string[] = [];

  for (const section of template.sections) {
    // Override params at runtime
    const sectionWithParams = { ...section };
    if (params?.project_name && sectionWithParams.dataParams.project_name !== undefined) {
      sectionWithParams.dataParams = { ...sectionWithParams.dataParams, project_name: params.project_name };
    }
    if (params?.period && sectionWithParams.dataParams.period !== undefined) {
      sectionWithParams.dataParams = { ...sectionWithParams.dataParams, period: params.period };
    }
    if (params?.date && sectionWithParams.dataParams.date !== undefined) {
      sectionWithParams.dataParams = { ...sectionWithParams.dataParams, date: params.date };
    }

    try {
      const data = gatherSectionData(sectionWithParams);
      const narrative = await composeNarrative(sectionWithParams, data);
      sectionContents.push(`## ${section.title}\n\n${narrative}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ReportGen] Section "${section.title}" failed:`, msg);
      sectionContents.push(`## ${section.title}\n\n_Data unavailable: ${msg}_`);
    }
  }

  const fullContent = [
    `# ${template.name}`,
    `**Generated by Cassidy** · ${new Date().toUTCString()}`,
    '',
    '---',
    '',
    ...sectionContents,
    '',
    '---',
    `_Report generated by Cassidy, Operations Manager · Template: ${template.id}_`,
  ].join('\n');

  // Try to create document via MCP if available
  let fileUrl: string | undefined;
  let fileId: string | undefined;

  if (template.outputFormat !== 'teams_message') {
    const docResult = await createDocument(template.outputFormat, template.name, fullContent, context);
    if (docResult) {
      fileUrl = docResult.fileUrl;
      fileId = docResult.fileId;
    }
  }

  console.log(`[ReportGen] "${template.name}" generated (${sectionContents.length} sections, ${fullContent.length} chars)`);

  return {
    success: true,
    templateId: template.id,
    templateName: template.name,
    outputFormat: template.outputFormat,
    content: fullContent,
    fileUrl,
    fileId,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Document creation via MCP
// ---------------------------------------------------------------------------

async function createDocument(
  format: OutputFormat,
  title: string,
  content: string,
  context?: TurnContext,
): Promise<{ fileUrl?: string; fileId?: string } | null> {
  // Map format to MCP tool names
  const toolMap: Record<string, string> = {
    word: 'mcp_WordServer_createDocument',
    excel: 'mcp_ExcelServer_createWorkbook',
    powerpoint: 'mcp_PowerPointServer_createPresentation',
  };

  const toolName = toolMap[format];
  if (!toolName || !hasMcpToolServer(toolName)) {
    console.log(`[ReportGen] MCP tool "${toolName}" not available — document not created (content returned as text)`);
    return null;
  }

  try {
    const result = await invokeMcpTool(toolName, {
      title,
      content,
      fileName: `${title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}`,
    }) as { fileUrl?: string; fileId?: string; id?: string; webUrl?: string };

    return {
      fileUrl: result?.fileUrl ?? result?.webUrl,
      fileId: result?.fileId ?? result?.id,
    };
  } catch (err) {
    console.error(`[ReportGen] Failed to create ${format} document:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email distribution
// ---------------------------------------------------------------------------

export async function distributeReport(
  report: ReportResult,
  recipients: string[],
  context?: TurnContext,
): Promise<DistributeResult> {
  const sentTo: string[] = [];
  const failures: string[] = [];

  if (recipients.length === 0) {
    return { success: false, recipientCount: 0, sentTo, failures: ['No recipients specified'] };
  }

  // Compose email body
  const body = report.fileUrl
    ? [
        `${report.templateName}`,
        '',
        `Cassidy has generated the ${report.templateName}. You can view and download it here:`,
        '',
        report.fileUrl,
        '',
        '---',
        '',
        'Summary:',
        report.content.slice(0, 2000), // Include first 2000 chars as preview
        report.content.length > 2000 ? '\n\n_(Full report available at the link above)_' : '',
        '',
        '— Cassidy, Operations Manager',
      ].join('\n')
    : [
        `${report.templateName}`,
        '',
        report.content,
        '',
        '— Cassidy, Operations Manager',
      ].join('\n');

  for (const recipient of recipients) {
    try {
      const result = await sendEmail({
        to: recipient,
        subject: `[Cassidy] ${report.templateName} — ${new Date().toISOString().slice(0, 10)}`,
        body,
        importance: 'normal',
      }, context);

      if (result.success) {
        sentTo.push(recipient);
      } else {
        failures.push(`${recipient}: ${result.error ?? 'unknown error'}`);
      }
    } catch (err) {
      failures.push(`${recipient}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[ReportGen] Distributed "${report.templateName}" to ${sentTo.length}/${recipients.length} recipients`);

  return {
    success: sentTo.length > 0,
    recipientCount: sentTo.length,
    sentTo,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Post to Teams channel
// ---------------------------------------------------------------------------

export async function postReportToTeams(
  report: ReportResult,
  channelId?: string,
  context?: TurnContext,
): Promise<{ success: boolean; messageId?: string }> {
  const { sendTeamsMessage } = await import('../tools/mcpToolSetup');

  const teamsContent = formatForTeams({
    content: report.content,
    message_type: 'report',
  });

  const channel = channelId ?? process.env.OPS_TEAMS_CHANNEL_ID ?? 'demo-channel';

  return sendTeamsMessage({
    channel_id: channel,
    message: teamsContent,
    subject: report.templateName,
  }, context);
}
