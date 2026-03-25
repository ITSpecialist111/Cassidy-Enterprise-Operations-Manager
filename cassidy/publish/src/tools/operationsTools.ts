// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatCompletionTool } from 'openai/resources/chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  switch (status.toLowerCase()) {
    case 'overdue': return '🔴';
    case 'at_risk':
    case 'at risk': return '🟡';
    case 'on_track':
    case 'on track':
    case 'complete':
    case 'completed': return '🟢';
    case 'blocked': return '🔵';
    default: return '⚪';
  }
}

function daysUntil(dateStr: string): number {
  const due = new Date(dateStr);
  const now = new Date();
  return Math.floor((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function taskStatus(dueDate?: string, completed?: boolean): string {
  if (completed) return 'complete';
  if (!dueDate) return 'on_track';
  const days = daysUntil(dueDate);
  if (days < 0) return 'overdue';
  if (days <= 2) return 'at_risk';
  return 'on_track';
}

// ---------------------------------------------------------------------------
// Mock data — used when MCP is not available (demo / local dev)
// ⚠️ All functions below return DEMO DATA with fictional names.
// When live MCP tools are connected, GPT-5 prefers those instead.
// ---------------------------------------------------------------------------

const DEMO_DATA_NOTICE = '⚠️ This data is for demonstration purposes only — names and tasks are fictional. Connect MCP tools for live data.';

const MOCK_TASKS = [
  { id: 'task-001', title: 'Vendor contract renewal — IT security review',     dueDate: '2026-03-15', owner: 'Alex Kumar',     project: 'IT Procurement',       completed: false, blocked: false },
  { id: 'task-002', title: 'Q1 OKR sign-off from department heads',            dueDate: '2026-03-18', owner: 'Sarah Chen',     project: 'Q1 Planning',          completed: false, blocked: false },
  { id: 'task-003', title: 'Onboarding checklist — Jordan Lee (starts Mon)',   dueDate: '2026-03-17', owner: 'Pat Rivera',     project: 'HR Operations',        completed: false, blocked: true  },
  { id: 'task-004', title: 'Office fit-out sign-off — Building B Level 3',     dueDate: '2026-03-25', owner: 'Morgan Taylor',  project: 'Facilities',           completed: false, blocked: false },
  { id: 'task-005', title: 'Process map — customer refund workflow',           dueDate: '2026-03-20', owner: 'Alex Kumar',     project: 'Process Improvement',  completed: false, blocked: false },
  { id: 'task-006', title: 'Security audit findings — remediation plan',       dueDate: '2026-03-12', owner: 'Sam Okafor',     project: 'IT Security',          completed: false, blocked: false },
  { id: 'task-007', title: 'Board pack — March appendix data',                 dueDate: '2026-03-28', owner: 'Sarah Chen',     project: 'Executive Reporting',  completed: false, blocked: false },
  { id: 'task-008', title: 'Supplier onboarding — CloudServe Ltd',             dueDate: '2026-03-14', owner: 'Morgan Taylor',  project: 'IT Procurement',       completed: false, blocked: false },
];

const MOCK_APPROVALS = [
  { id: 'apr-001', title: 'Travel approval — APAC conference March 28–31',  requestor: 'Alex Kumar',    approver: 'Sarah Chen',    submittedDaysAgo: 3, urgency: 'normal' },
  { id: 'apr-002', title: 'Budget reallocation — Marketing Q1 overspend',   requestor: 'Morgan Taylor', approver: 'Sam Okafor',    submittedDaysAgo: 5, urgency: 'high'   },
  { id: 'apr-003', title: 'New vendor add — DevToolbox SaaS subscription',  requestor: 'Pat Rivera',    approver: 'Sarah Chen',    submittedDaysAgo: 1, urgency: 'low'    },
];

const MOCK_TEAM = [
  { name: 'Alex Kumar',    role: 'Senior Analyst',       activeTasks: 6, overdueCount: 2, capacity: 'near_limit' },
  { name: 'Sarah Chen',    role: 'Operations Lead',      activeTasks: 4, overdueCount: 1, capacity: 'normal'     },
  { name: 'Pat Rivera',    role: 'Project Coordinator',  activeTasks: 3, overdueCount: 0, capacity: 'normal'     },
  { name: 'Morgan Taylor', role: 'IT Operations',        activeTasks: 7, overdueCount: 2, capacity: 'near_limit' },
  { name: 'Sam Okafor',    role: 'Security & Compliance',activeTasks: 5, overdueCount: 1, capacity: 'normal'     },
];

// ---------------------------------------------------------------------------
// 1. getOverdueTasks
// ---------------------------------------------------------------------------

export interface OverdueTaskResult {
  total: number;
  tasks: Array<{
    id: string;
    title: string;
    dueDate: string;
    daysOverdue: number;
    owner: string;
    project: string;
    blocked: boolean;
    status: string;
  }>;
  blockedCount: number;
  criticalCount: number;
  notice: string;
}

export function getOverdueTasks(params: { project?: string; assignee?: string; include_at_risk?: boolean }): OverdueTaskResult {
  const now = new Date();
  let tasks = MOCK_TASKS.filter(t => !t.completed);

  if (params.project) {
    tasks = tasks.filter(t => t.project.toLowerCase().includes(params.project!.toLowerCase()));
  }
  if (params.assignee) {
    tasks = tasks.filter(t => t.owner.toLowerCase().includes(params.assignee!.toLowerCase()));
  }

  const overdue = tasks.filter(t => {
    const due = new Date(t.dueDate);
    const daysLeft = Math.floor((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return params.include_at_risk ? daysLeft <= 2 : daysLeft < 0;
  });

  const result = overdue.map(t => {
    const due = new Date(t.dueDate);
    const daysOverdue = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    return {
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      daysOverdue: Math.max(0, daysOverdue),
      owner: t.owner,
      project: t.project,
      blocked: t.blocked,
      status: taskStatus(t.dueDate, false),
    };
  });

  return {
    total: result.length,
    tasks: result,
    blockedCount: result.filter(t => t.blocked).length,
    criticalCount: result.filter(t => t.daysOverdue > 3).length,
    notice: DEMO_DATA_NOTICE,
  };
}

// ---------------------------------------------------------------------------
// 2. getTeamWorkload
// ---------------------------------------------------------------------------

export interface TeamWorkloadResult {
  team: string;
  members: Array<{
    name: string;
    role: string;
    activeTasks: number;
    overdueCount: number;
    capacity: string;
    capacityEmoji: string;
  }>;
  totalActiveTasks: number;
  totalOverdue: number;
  atCapacityCount: number;
  notice: string;
}

export function getTeamWorkload(params: { team_name?: string }): TeamWorkloadResult {
  const teamName = params.team_name ?? process.env.DEFAULT_TEAM_NAME ?? 'Operations';

  const members = MOCK_TEAM.map(m => ({
    ...m,
    capacityEmoji: m.capacity === 'near_limit' ? '🟡' : m.capacity === 'over_limit' ? '🔴' : '🟢',
  }));

  return {
    team: teamName,
    members,
    totalActiveTasks: members.reduce((sum, m) => sum + m.activeTasks, 0),
    totalOverdue: members.reduce((sum, m) => sum + m.overdueCount, 0),
    atCapacityCount: members.filter(m => m.capacity !== 'normal').length,
    notice: DEMO_DATA_NOTICE,
  };
}

// ---------------------------------------------------------------------------
// 3. prioritizeBacklog
// ---------------------------------------------------------------------------

export interface PrioritizedTask {
  id: string;
  title: string;
  priorityScore: number;
  priorityLabel: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  dueDate?: string;
  blocked?: boolean;
}

export function prioritizeBacklog(params: {
  tasks: Array<{ id: string; title: string; due_date?: string; priority?: string; blocked?: boolean }>;
}): { prioritized: PrioritizedTask[]; summary: string } {
  const now = new Date();

  const scored = params.tasks.map(t => {
    let score = 0;
    const reasons: string[] = [];

    if (t.due_date) {
      const days = Math.floor((new Date(t.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (days < 0) { score += 100; reasons.push(`${Math.abs(days)}d overdue`); }
      else if (days === 0) { score += 80; reasons.push('due today'); }
      else if (days <= 2) { score += 60; reasons.push(`due in ${days}d`); }
      else if (days <= 7) { score += 30; reasons.push(`due in ${days}d`); }
    }

    if (t.blocked) { score += 50; reasons.push('blocked'); }

    const p = (t.priority ?? '').toLowerCase();
    if (p === 'critical') { score += 40; reasons.push('critical priority'); }
    else if (p === 'high') { score += 20; reasons.push('high priority'); }

    const label: PrioritizedTask['priorityLabel'] =
      score >= 100 ? 'critical' :
      score >= 60 ? 'high' :
      score >= 30 ? 'medium' : 'low';

    return {
      id: t.id,
      title: t.title,
      priorityScore: score,
      priorityLabel: label,
      reason: reasons.length > 0 ? reasons.join(', ') : 'standard',
      dueDate: t.due_date,
      blocked: t.blocked,
    };
  });

  const sorted = scored.sort((a, b) => b.priorityScore - a.priorityScore);
  const criticalCount = sorted.filter(t => t.priorityLabel === 'critical').length;
  const highCount = sorted.filter(t => t.priorityLabel === 'high').length;

  return {
    prioritized: sorted,
    summary: `${sorted.length} tasks ranked. ${criticalCount} critical, ${highCount} high priority requiring immediate action.`,
  };
}

// ---------------------------------------------------------------------------
// 4. getPendingApprovals
// ---------------------------------------------------------------------------

export interface PendingApprovalsResult {
  total: number;
  approvals: Array<{
    id: string;
    title: string;
    requestor: string;
    approver: string;
    submittedDaysAgo: number;
    urgency: string;
    urgencyEmoji: string;
    isOverdue: boolean;
  }>;
  overdueCount: number;
  highUrgencyCount: number;
  notice: string;
}

export function getPendingApprovals(params: { older_than_days?: number; approver?: string }): PendingApprovalsResult {
  let approvals = [...MOCK_APPROVALS];

  if (params.approver) {
    approvals = approvals.filter(a => a.approver.toLowerCase().includes(params.approver!.toLowerCase()));
  }

  const minAge = params.older_than_days ?? 0;
  if (minAge > 0) {
    approvals = approvals.filter(a => a.submittedDaysAgo >= minAge);
  }

  const result = approvals.map(a => ({
    ...a,
    urgencyEmoji: a.urgency === 'high' ? '🔴' : a.urgency === 'normal' ? '🟡' : '🟢',
    isOverdue: a.submittedDaysAgo >= 3,
  }));

  return {
    total: result.length,
    approvals: result,
    overdueCount: result.filter(a => a.isOverdue).length,
    highUrgencyCount: result.filter(a => a.urgency === 'high').length,
    notice: DEMO_DATA_NOTICE,
  };
}

// ---------------------------------------------------------------------------
// 5. generateStandupReport
// ---------------------------------------------------------------------------

export function generateStandupReport(params: { date: string; include_blockers: boolean }): string {
  const overdue = getOverdueTasks({ include_at_risk: true });
  const workload = getTeamWorkload({});
  const approvals = getPendingApprovals({ older_than_days: 2 });

  const lines: string[] = [
    `# 📋 Daily Operations Standup — ${params.date}`,
    `**Prepared by:** Cassidy, Operations Manager  |  **Time:** ${new Date().toUTCString()}`,
    '',
    `> ${DEMO_DATA_NOTICE}`,
    '',
    '---',
    '',
    '## Opening Summary',
    '',
    `${overdue.total > 0 ? `🔴 ${overdue.total} task(s) overdue` : '✅ No overdue tasks'} · ` +
    `${approvals.overdueCount > 0 ? `🟡 ${approvals.overdueCount} approval(s) stalled` : '✅ Approvals on track'} · ` +
    `${workload.atCapacityCount > 0 ? `⚠️ ${workload.atCapacityCount} team member(s) near capacity` : '✅ Team capacity normal'}`,
    '',
    '---',
    '',
    '## 🔴 Overdue Tasks',
    '',
  ];

  if (overdue.tasks.length === 0) {
    lines.push('✅ No tasks are overdue today.', '');
  } else {
    overdue.tasks.forEach(t => {
      const daysLabel = t.daysOverdue > 0 ? `${t.daysOverdue}d overdue` : 'due today';
      const blockedLabel = t.blocked ? ' 🔵 BLOCKED' : '';
      lines.push(`- 🔴 **${t.title}**${blockedLabel}`);
      lines.push(`  Owner: ${t.owner} · Project: ${t.project} · ${daysLabel}`);
    });
    lines.push('');
  }

  if (params.include_blockers && overdue.blockedCount > 0) {
    lines.push(
      '---',
      '',
      '## 🔵 Blocked Items — Management Action Required',
      '',
    );
    overdue.tasks.filter(t => t.blocked).forEach(t => {
      lines.push(`- 🔵 **${t.title}** — Owner: ${t.owner} (${t.project})`);
    });
    lines.push('');
  }

  lines.push(
    '---',
    '',
    '## 🕐 Pending Approvals',
    '',
  );

  if (approvals.approvals.length === 0) {
    lines.push('✅ No approvals pending more than 2 days.', '');
  } else {
    approvals.approvals.forEach(a => {
      lines.push(`- ${a.urgencyEmoji} **${a.title}**`);
      lines.push(`  Requested by: ${a.requestor} · Approver: ${a.approver} · ${a.submittedDaysAgo}d ago`);
    });
    lines.push('');
  }

  lines.push(
    '---',
    '',
    '## 👥 Team Workload',
    '',
  );

  workload.members.forEach(m => {
    lines.push(`- ${m.capacityEmoji} **${m.name}** (${m.role}) · ${m.activeTasks} active · ${m.overdueCount} overdue`);
  });

  lines.push(
    '',
    '---',
    '',
    '## ✅ Today\'s Priority Actions',
    '',
    ...overdue.tasks.slice(0, 3).map(t => `- [ ] **${t.owner}** — resolve "${t.title}" (${t.project})`),
    ...approvals.approvals.filter(a => a.isOverdue).map(a => `- [ ] **${a.approver}** — approve "${a.title}" (${a.submittedDaysAgo}d pending)`),
    '',
    '---',
    `*Automated standup by Cassidy · ${new Date().toUTCString()}*`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 6. generateProjectStatusReport
// ---------------------------------------------------------------------------

export function generateProjectStatusReport(params: { project_name: string; period: string }): string {
  const projectTasks = MOCK_TASKS.filter(t =>
    t.project.toLowerCase().includes(params.project_name.toLowerCase())
  );

  if (projectTasks.length === 0) {
    return `No tasks found for project: "${params.project_name}"`;
  }

  const now = new Date();
  const overdueTasks = projectTasks.filter(t => {
    const due = new Date(t.dueDate);
    return !t.completed && due < now;
  });
  const completedTasks = projectTasks.filter(t => t.completed);
  const blockedTasks = projectTasks.filter(t => t.blocked && !t.completed);
  const onTrackTasks = projectTasks.filter(t => {
    const due = new Date(t.dueDate);
    return !t.completed && due >= now && !t.blocked;
  });

  const completionPct = Math.round((completedTasks.length / projectTasks.length) * 100);
  const overallStatus = overdueTasks.length > 2 ? '🔴 At Risk' : overdueTasks.length > 0 ? '🟡 Monitor' : '🟢 On Track';

  const lines: string[] = [
    `# 📊 Project Status Report — ${params.project_name}`,
    `**Period:** ${params.period}  |  **Overall Status:** ${overallStatus}`,
    `**Prepared by:** Cassidy, Operations Manager  |  **Generated:** ${new Date().toUTCString()}`,
    '',
    `> ${DEMO_DATA_NOTICE}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `**Total Tasks:** ${projectTasks.length}  ·  **Completion:** ${completionPct}%`,
    `**On Track:** ${onTrackTasks.length}  ·  **Overdue:** ${overdueTasks.length}  ·  **Blocked:** ${blockedTasks.length}  ·  **Complete:** ${completedTasks.length}`,
    '',
    '---',
    '',
  ];

  if (overdueTasks.length > 0) {
    lines.push('## 🔴 Overdue Items', '');
    overdueTasks.forEach(t => {
      const days = Math.floor((now.getTime() - new Date(t.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      lines.push(`- **${t.title}** · Owner: ${t.owner} · ${days}d overdue${t.blocked ? ' 🔵 BLOCKED' : ''}`);
    });
    lines.push('');
  }

  if (blockedTasks.length > 0) {
    lines.push('## 🔵 Blocked Items', '');
    blockedTasks.forEach(t => lines.push(`- **${t.title}** · Owner: ${t.owner}`));
    lines.push('');
  }

  lines.push('## ✅ On Track', '');
  onTrackTasks.forEach(t => {
    const days = daysUntil(t.dueDate);
    lines.push(`- **${t.title}** · Owner: ${t.owner} · Due in ${days}d`);
  });

  lines.push(
    '',
    '---',
    `*Report generated by Cassidy — Operations Manager · ${new Date().toUTCString()}*`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI Tool Definitions
// ---------------------------------------------------------------------------

export const OPERATIONS_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getOverdueTasks',
      description: 'Get overdue (and optionally at-risk) tasks across all projects, filtered by project or assignee. Returns tasks with owner, due date, days overdue, and blocked status.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project name (partial match). Omit for all projects.' },
          assignee: { type: 'string', description: 'Filter by task owner name (partial match). Omit for all owners.' },
          include_at_risk: { type: 'boolean', description: 'Include tasks due within 2 days (at-risk), not just overdue.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTeamWorkload',
      description: 'Get current workload and capacity status for all team members. Shows active task counts, overdue items, and capacity indicators.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Team name (defaults to Operations team).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prioritizeBacklog',
      description: 'Analyse and prioritise a list of tasks by due date urgency, blocked status, and declared priority. Returns tasks ranked from most to least critical.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'List of tasks to prioritise.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                due_date: { type: 'string', description: 'ISO date string, e.g. "2026-03-25".' },
                priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                blocked: { type: 'boolean' },
              },
              required: ['id', 'title'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPendingApprovals',
      description: 'Get pending approval requests, optionally filtered by age or approver. Returns approval title, requestor, approver, days pending, and urgency.',
      parameters: {
        type: 'object',
        properties: {
          older_than_days: { type: 'number', description: 'Only return approvals older than this many days.' },
          approver: { type: 'string', description: 'Filter by approver name (partial match).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generateStandupReport',
      description: 'Generate a complete daily operations standup report in Markdown, including overdue tasks, pending approvals, team workload, and priority actions.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date for the standup, e.g. "2026-03-17".' },
          include_blockers: { type: 'boolean', description: 'Include a dedicated blockers section.' },
        },
        required: ['date', 'include_blockers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generateProjectStatusReport',
      description: 'Generate a project status report for a named project, showing completion %, overdue items, blocked tasks, and overall health.',
      parameters: {
        type: 'object',
        properties: {
          project_name: { type: 'string', description: 'Project name to report on (partial match).' },
          period: { type: 'string', description: 'Reporting period, e.g. "March 2026" or "Q1 2026".' },
        },
        required: ['project_name', 'period'],
      },
    },
  },
];
