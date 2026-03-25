// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Report Templates — defines report structures, data sources, and output formats.
// Each template describes what data to gather, how to format it, and who to send it to.
// ---------------------------------------------------------------------------

export type OutputFormat = 'word' | 'excel' | 'powerpoint' | 'teams_message';

export type RenderStyle = 'text' | 'table' | 'chart' | 'bullet_list' | 'kpi_card';

export interface ReportSection {
  title: string;
  dataSource: string;           // tool name to call for data
  dataParams: Record<string, unknown>;
  renderAs: RenderStyle;
  narrativePrompt?: string;     // GPT-5 prompt to generate prose for this section
}

export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  outputFormat: OutputFormat;
  sections: ReportSection[];
  distributionList?: string[];   // default email recipients (can be overridden)
  schedule?: string;             // human-readable schedule description
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'weekly-ops-status',
    name: 'Weekly Operations Status Report',
    description: 'Comprehensive weekly report: executive summary, overdue tasks, approvals, team workload, and action items. Generated as a Word document.',
    outputFormat: 'word',
    schedule: 'Every Friday at 4 PM',
    sections: [
      {
        title: 'Executive Summary',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'text',
        narrativePrompt: 'Write a 3-4 sentence executive summary of the operations status. Mention the total overdue tasks, critical blockers, and overall team health. Be direct and action-oriented.',
      },
      {
        title: 'Overdue Tasks',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'table',
      },
      {
        title: 'Pending Approvals',
        dataSource: 'getPendingApprovals',
        dataParams: { older_than_days: 0 },
        renderAs: 'table',
      },
      {
        title: 'Team Workload',
        dataSource: 'getTeamWorkload',
        dataParams: {},
        renderAs: 'table',
      },
      {
        title: 'Recommended Actions',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: false },
        renderAs: 'bullet_list',
        narrativePrompt: 'Based on the overdue tasks and stalled approvals, list 3-5 specific recommended actions for the management team this week. Each action should name a person, a task, and a deadline.',
      },
    ],
  },
  {
    id: 'project-health-dashboard',
    name: 'Project Health Dashboard',
    description: 'Per-project status overview with health indicators, timelines, and risk assessment. Generated as a PowerPoint deck.',
    outputFormat: 'powerpoint',
    schedule: 'On demand',
    sections: [
      {
        title: 'Portfolio Overview',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'kpi_card',
        narrativePrompt: 'Summarise the overall project portfolio health in 2 sentences. How many projects are on track vs at risk?',
      },
      {
        title: 'Project Status Cards',
        dataSource: 'generateProjectStatusReport',
        dataParams: { project_name: '', period: '' }, // filled at generation time
        renderAs: 'chart',
      },
      {
        title: 'Risk Register',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: false },
        renderAs: 'table',
        narrativePrompt: 'Identify the top 3 risks to project delivery this week based on overdue tasks and blocked items. For each risk, state the impact and a mitigation suggestion.',
      },
    ],
  },
  {
    id: 'team-capacity-report',
    name: 'Team Capacity Report',
    description: 'Detailed workload analysis with task distribution, overdue counts, and capacity indicators. Generated as an Excel workbook.',
    outputFormat: 'excel',
    schedule: 'Every Monday at 9 AM',
    sections: [
      {
        title: 'Team Overview',
        dataSource: 'getTeamWorkload',
        dataParams: {},
        renderAs: 'table',
      },
      {
        title: 'Task Distribution',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'table',
      },
      {
        title: 'Capacity Analysis',
        dataSource: 'getTeamWorkload',
        dataParams: {},
        renderAs: 'chart',
        narrativePrompt: 'Analyse the team capacity data. Which team members are over-allocated? Who has bandwidth for additional work? Provide specific rebalancing recommendations.',
      },
    ],
  },
  {
    id: 'monthly-executive-brief',
    name: 'Monthly Executive Briefing',
    description: 'High-level monthly summary for senior leadership: KPIs, trends, notable achievements, and strategic risks. Generated as a Word document.',
    outputFormat: 'word',
    schedule: 'Last Friday of each month',
    sections: [
      {
        title: 'Month in Review',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'text',
        narrativePrompt: 'Write a 200-word executive summary of operations this month. Cover: tasks completed vs overdue, approval throughput, team capacity trends, and notable wins or challenges. Write for a C-level audience — be strategic, not tactical.',
      },
      {
        title: 'Key Performance Indicators',
        dataSource: 'getTeamWorkload',
        dataParams: {},
        renderAs: 'kpi_card',
      },
      {
        title: 'Overdue & At-Risk Items',
        dataSource: 'getOverdueTasks',
        dataParams: { include_at_risk: true },
        renderAs: 'table',
      },
      {
        title: 'Approval Pipeline',
        dataSource: 'getPendingApprovals',
        dataParams: { older_than_days: 0 },
        renderAs: 'table',
      },
      {
        title: 'Strategic Recommendations',
        dataSource: 'getTeamWorkload',
        dataParams: {},
        renderAs: 'bullet_list',
        narrativePrompt: 'Based on this month\'s operational data, provide 3-4 strategic recommendations for leadership. Focus on process improvements, resource allocation, and risk mitigation. Be specific with data-backed suggestions.',
      },
    ],
  },
  {
    id: 'daily-standup-document',
    name: 'Daily Standup Document',
    description: 'Formatted daily standup as a Teams message or document. Quick-reference for the team.',
    outputFormat: 'teams_message',
    schedule: 'Every weekday at 9 AM',
    sections: [
      {
        title: 'Today\'s Standup',
        dataSource: 'generateStandupReport',
        dataParams: { date: '', include_blockers: true }, // date filled at runtime
        renderAs: 'text',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Template lookup
// ---------------------------------------------------------------------------

export function getTemplate(templateId: string): ReportTemplate | null {
  return REPORT_TEMPLATES.find(t => t.id === templateId) ?? null;
}

export function listTemplates(): Array<{ id: string; name: string; description: string; format: OutputFormat; schedule?: string }> {
  return REPORT_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    format: t.outputFormat,
    schedule: t.schedule,
  }));
}
