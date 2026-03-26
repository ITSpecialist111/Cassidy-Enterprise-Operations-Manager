// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatCompletionTool } from 'openai/resources/chat';
import { getGraphToken } from '../auth';
import { config as appConfig } from '../featureConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Graph API helper with timeout
// ---------------------------------------------------------------------------

const GRAPH_TIMEOUT_MS = appConfig.graphTimeoutMs;

async function graphGet<T>(path: string): Promise<T> {
  const token = await getGraphToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Graph ${res.status}: ${res.statusText}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Short-lived cache (60s TTL) — avoids repeat Graph calls during standup
// generation which calls getOverdueTasks, getTeamWorkload, getPendingApprovals
// ---------------------------------------------------------------------------

interface CacheEntry<T> { data: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = appConfig.graphCacheTtlMs;

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) { cache.delete(key); return undefined; }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Graph data types
// ---------------------------------------------------------------------------

interface PlannerTask {
  id: string;
  title: string;
  percentComplete: number;
  dueDateTime?: string;
  createdDateTime: string;
  assignments: Record<string, { assignedBy?: { user?: { displayName?: string } } }>;
  bucketId?: string;
  appliedCategories?: Record<string, boolean>;
}

interface GroupMember {
  id: string;
  displayName: string;
  jobTitle?: string;
  mail?: string;
}

interface PlannerBucket {
  id: string;
  name: string;
  planId: string;
}

// ---------------------------------------------------------------------------
// Internal normalised task type
// ---------------------------------------------------------------------------

interface NormalisedTask {
  id: string;
  title: string;
  dueDate: string;
  owner: string;
  project: string;
  completed: boolean;
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Fallback mock data — used when Graph is unavailable
// ---------------------------------------------------------------------------

const DEMO_DATA_NOTICE = '⚠️ This data is for demonstration purposes only — names and tasks are fictional. Connect MCP tools for live data.';

const MOCK_TASKS: NormalisedTask[] = [
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

const MOCK_TEAM: Array<{ name: string; role: string; activeTasks: number; overdueCount: number; capacity: string }> = [
  { name: 'Alex Kumar',    role: 'Senior Analyst',       activeTasks: 6, overdueCount: 2, capacity: 'near_limit' },
  { name: 'Sarah Chen',    role: 'Operations Lead',      activeTasks: 4, overdueCount: 1, capacity: 'normal'     },
  { name: 'Pat Rivera',    role: 'Project Coordinator',  activeTasks: 3, overdueCount: 0, capacity: 'normal'     },
  { name: 'Morgan Taylor', role: 'IT Operations',        activeTasks: 7, overdueCount: 2, capacity: 'near_limit' },
  { name: 'Sam Okafor',    role: 'Security & Compliance',activeTasks: 5, overdueCount: 1, capacity: 'normal'     },
];

// ---------------------------------------------------------------------------
// Graph → normalised task fetcher
// ---------------------------------------------------------------------------

/** Resolve user IDs to display names. Builds a Map<userId, displayName>. */
async function resolveMembers(): Promise<Map<string, GroupMember>> {
  const groupId = appConfig.plannerGroupId;
  if (!groupId) return new Map();

  const cacheKey = `members_${groupId}`;
  const cached = getCached<Map<string, GroupMember>>(cacheKey);
  if (cached) return cached;

  const data = await graphGet<{ value: GroupMember[] }>(`/groups/${groupId}/members?$select=id,displayName,jobTitle,mail`);
  const map = new Map<string, GroupMember>();
  for (const m of data.value) map.set(m.id, m);
  setCache(cacheKey, map);
  return map;
}

/** Fetch buckets for the configured plan. Returns Map<bucketId, bucketName>. */
async function fetchBuckets(): Promise<Map<string, string>> {
  const planId = appConfig.plannerPlanId;
  if (!planId) return new Map();

  const cacheKey = `buckets_${planId}`;
  const cached = getCached<Map<string, string>>(cacheKey);
  if (cached) return cached;

  const data = await graphGet<{ value: PlannerBucket[] }>(`/planner/plans/${planId}/buckets`);
  const map = new Map<string, string>();
  for (const b of data.value) map.set(b.id, b.name);
  setCache(cacheKey, map);
  return map;
}

/** Fetch all Planner tasks for the configured plan and normalise. */
async function fetchPlannerTasks(): Promise<NormalisedTask[]> {
  const planId = appConfig.plannerPlanId;
  if (!planId) throw new Error('PLANNER_PLAN_ID not configured');

  const cacheKey = `tasks_${planId}`;
  const cached = getCached<NormalisedTask[]>(cacheKey);
  if (cached) return cached;

  const [taskData, members, buckets] = await Promise.all([
    graphGet<{ value: PlannerTask[] }>(`/planner/plans/${planId}/tasks?$top=100`),
    resolveMembers(),
    fetchBuckets(),
  ]);

  const tasks: NormalisedTask[] = taskData.value.map(t => {
    // Resolve owner from first assignment
    const assigneeIds = Object.keys(t.assignments ?? {});
    const firstAssignee = assigneeIds.length > 0 ? members.get(assigneeIds[0]) : undefined;
    const ownerName = firstAssignee?.displayName ?? 'Unassigned';

    // Bucket name → project name
    const project = (t.bucketId && buckets.get(t.bucketId)) || 'General';

    // Planner: "blocked" indicated by category6 (red label) by convention
    const blocked = Boolean(t.appliedCategories?.category6);

    return {
      id: t.id,
      title: t.title,
      dueDate: t.dueDateTime ? t.dueDateTime.slice(0, 10) : '',
      owner: ownerName,
      project,
      completed: t.percentComplete === 100,
      blocked,
    };
  });

  setCache(cacheKey, tasks);
  return tasks;
}

/** True when Graph-backed Planner data is available. */
function graphConfigured(): boolean {
  return Boolean(appConfig.plannerGroupId && appConfig.plannerPlanId);
}

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
  notice?: string;
  source: 'graph' | 'demo';
}

export async function getOverdueTasks(params: { project?: string; assignee?: string; include_at_risk?: boolean }): Promise<OverdueTaskResult> {
  let allTasks: NormalisedTask[];
  let source: 'graph' | 'demo' = 'demo';

  if (graphConfigured()) {
    try {
      allTasks = await fetchPlannerTasks();
      source = 'graph';
    } catch (err) {
      console.warn('[OpsTools] Graph Planner fetch failed, falling back to demo data:', err);
      allTasks = MOCK_TASKS;
    }
  } else {
    allTasks = MOCK_TASKS;
  }

  const now = new Date();
  let tasks = allTasks.filter(t => !t.completed);

  if (params.project) {
    tasks = tasks.filter(t => t.project.toLowerCase().includes(params.project!.toLowerCase()));
  }
  if (params.assignee) {
    tasks = tasks.filter(t => t.owner.toLowerCase().includes(params.assignee!.toLowerCase()));
  }

  const overdue = tasks.filter(t => {
    if (!t.dueDate) return false;
    const daysLeft = Math.floor((new Date(t.dueDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
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
    source,
    ...(source === 'demo' ? { notice: DEMO_DATA_NOTICE } : {}),
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
  notice?: string;
  source: 'graph' | 'demo';
}

export async function getTeamWorkload(params: { team_name?: string }): Promise<TeamWorkloadResult> {
  const teamName = params.team_name ?? process.env.DEFAULT_TEAM_NAME ?? 'Operations';

  if (graphConfigured()) {
    try {
      const [allTasks, memberMap] = await Promise.all([
        fetchPlannerTasks(),
        resolveMembers(),
      ]);

      const now = new Date();
      const activeTasks = allTasks.filter(t => !t.completed);

      // Build member workload from real data
      const memberStats = new Map<string, { name: string; role: string; active: number; overdue: number }>();
      for (const m of memberMap.values()) {
        memberStats.set(m.displayName, { name: m.displayName, role: m.jobTitle ?? 'Team Member', active: 0, overdue: 0 });
      }
      for (const t of activeTasks) {
        const stat = memberStats.get(t.owner);
        if (stat) {
          stat.active++;
          if (t.dueDate && new Date(t.dueDate) < now) stat.overdue++;
        }
      }

      const members = Array.from(memberStats.values()).map(s => {
        const capacity = s.active >= 8 ? 'over_limit' : s.active >= 5 ? 'near_limit' : 'normal';
        return {
          name: s.name,
          role: s.role,
          activeTasks: s.active,
          overdueCount: s.overdue,
          capacity,
          capacityEmoji: capacity === 'over_limit' ? '🔴' : capacity === 'near_limit' ? '🟡' : '🟢',
        };
      });

      return {
        team: teamName,
        members,
        totalActiveTasks: members.reduce((sum, m) => sum + m.activeTasks, 0),
        totalOverdue: members.reduce((sum, m) => sum + m.overdueCount, 0),
        atCapacityCount: members.filter(m => m.capacity !== 'normal').length,
        source: 'graph',
      };
    } catch (err) {
      console.warn('[OpsTools] Graph team workload failed, falling back to demo data:', err);
    }
  }

  // Fallback to mock data
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
    source: 'demo',
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
  notice?: string;
  source: 'graph' | 'demo';
}

export async function getPendingApprovals(params: { older_than_days?: number; approver?: string }): Promise<PendingApprovalsResult> {
  // Graph Planner doesn't have a native "approvals" concept. We model
  // approvals as tasks in a bucket named "Approvals" or "Pending Approval".
  // If Graph is configured, we query Planner and extract those.
  if (graphConfigured()) {
    try {
      const [allTasks, buckets, _members] = await Promise.all([
        fetchPlannerTasks(),
        fetchBuckets(),
        resolveMembers(),
      ]);

      // Find the approval bucket (case-insensitive, matches "Approvals", "Pending Approval", etc.)
      const planId = appConfig.plannerPlanId;
      const rawBuckets = getCached<Map<string, string>>(`buckets_${planId}`) ?? buckets;
      for (const [, name] of rawBuckets) {
        if (/approval/i.test(name)) { break; }
      }

      // Filter tasks that are in the approval bucket and incomplete
      const approvalTasks = allTasks.filter(t => {
        if (t.completed) return false;
        return t.project.toLowerCase().includes('approval');
      });

      const now = new Date();
      const mapped = approvalTasks.map(t => {
        const created = t.dueDate ? new Date(t.dueDate) : now;
        const daysAgo = Math.max(0, Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)));
        return {
          id: t.id,
          title: t.title,
          requestor: t.owner,
          approver: t.owner, // In Planner, the assignee handles approval
          submittedDaysAgo: daysAgo,
          urgency: daysAgo >= 5 ? 'high' : daysAgo >= 3 ? 'normal' : 'low',
          urgencyEmoji: daysAgo >= 5 ? '🔴' : daysAgo >= 3 ? '🟡' : '🟢',
          isOverdue: daysAgo >= 3,
        };
      });

      let filtered = mapped;
      if (params.approver) {
        filtered = filtered.filter(a => a.approver.toLowerCase().includes(params.approver!.toLowerCase()));
      }
      const minAge = params.older_than_days ?? 0;
      if (minAge > 0) {
        filtered = filtered.filter(a => a.submittedDaysAgo >= minAge);
      }

      return {
        total: filtered.length,
        approvals: filtered,
        overdueCount: filtered.filter(a => a.isOverdue).length,
        highUrgencyCount: filtered.filter(a => a.urgency === 'high').length,
        source: 'graph',
      };
    } catch (err) {
      console.warn('[OpsTools] Graph approvals fetch failed, falling back to demo data:', err);
    }
  }

  // Fallback to mock data
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
    source: 'demo',
  };
}

// ---------------------------------------------------------------------------
// 5. generateStandupReport
// ---------------------------------------------------------------------------

export async function generateStandupReport(params: { date: string; include_blockers: boolean }): Promise<string> {
  const [overdue, workload, approvals] = await Promise.all([
    getOverdueTasks({ include_at_risk: true }),
    getTeamWorkload({}),
    getPendingApprovals({ older_than_days: 2 }),
  ]);

  const isDemo = overdue.source === 'demo';
  const lines: string[] = [
    `# 📋 Daily Operations Standup — ${params.date}`,
    `**Prepared by:** Cassidy, Operations Manager  |  **Time:** ${new Date().toUTCString()}`,
    '',
    ...(isDemo ? [`> ${DEMO_DATA_NOTICE}`, ''] : []),
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

export async function generateProjectStatusReport(params: { project_name: string; period: string }): Promise<string> {
  let projectTasks: NormalisedTask[];
  let isDemo = true;

  if (graphConfigured()) {
    try {
      const all = await fetchPlannerTasks();
      projectTasks = all.filter(t =>
        t.project.toLowerCase().includes(params.project_name.toLowerCase())
      );
      isDemo = false;
    } catch (err) {
      console.warn('[OpsTools] Graph project status failed, using demo data:', err);
      projectTasks = MOCK_TASKS.filter(t =>
        t.project.toLowerCase().includes(params.project_name.toLowerCase())
      );
    }
  } else {
    projectTasks = MOCK_TASKS.filter(t =>
      t.project.toLowerCase().includes(params.project_name.toLowerCase())
    );
  }

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
    ...(isDemo ? [`> ${DEMO_DATA_NOTICE}`, ''] : []),
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
