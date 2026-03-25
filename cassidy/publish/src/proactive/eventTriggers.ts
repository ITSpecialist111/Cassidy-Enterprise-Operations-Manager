// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Event Triggers — concrete trigger conditions for the proactive engine.
// Each trigger queries existing data sources and returns outreach actions
// when conditions are met.
// ---------------------------------------------------------------------------

import {
  getOverdueTasks,
  getPendingApprovals,
  getTeamWorkload,
} from '../tools/operationsTools';
import {
  getNotificationPrefsFromProfile,
  UserProfile,
} from './userRegistry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutreachAction {
  targetUserId: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  channel: 'teams_chat' | 'email' | 'both';
  context: Record<string, unknown>;
  triggerName: string;
  reason?: string;
}

export interface TriggerCondition {
  id: string;
  name: string;
  evaluate: (users: UserProfile[]) => Promise<OutreachAction[]>;
  cooldownMinutes: number;
  lastFired?: Date;
}

// ---------------------------------------------------------------------------
// 1. Overdue Task Escalation
// ---------------------------------------------------------------------------

const overdueTaskEscalation: TriggerCondition = {
  id: 'overdue_task_escalation',
  name: 'Overdue Task Escalation',
  cooldownMinutes: 120, // 2 hours between alerts for same trigger
  evaluate: async (users: UserProfile[]): Promise<OutreachAction[]> => {
    const overdue = getOverdueTasks({ include_at_risk: false });
    if (overdue.total === 0) return [];

    const actions: OutreachAction[] = [];

    for (const user of users) {
      const prefs = getNotificationPrefsFromProfile(user);
      if (!prefs.overdueAlerts) continue;

      // Find tasks relevant to this user (by name match in owner field)
      const userTasks = overdue.tasks.filter(t =>
        t.owner.toLowerCase().includes(user.displayName.toLowerCase().split(' ')[0])
      );

      if (userTasks.length > 0) {
        actions.push({
          targetUserId: user.rowKey,
          urgency: userTasks.some(t => t.daysOverdue > 5) ? 'high' : 'medium',
          channel: 'teams_chat',
          triggerName: 'overdue_task_escalation',
          reason: `${userTasks.length} task(s) assigned to you are overdue`,
          context: {
            overdueCount: userTasks.length,
            tasks: userTasks.slice(0, 5).map(t => ({
              title: t.title,
              daysOverdue: t.daysOverdue,
              project: t.project,
              blocked: t.blocked,
            })),
            mostOverdue: userTasks[0]?.title,
            maxDaysOverdue: Math.max(...userTasks.map(t => t.daysOverdue)),
          },
        });
      }
    }

    // Also notify the first registered user (assumed manager) about overall overdue status
    if (users.length > 0 && overdue.total > 3) {
      const manager = users[0]; // First registered user gets the overview
      const prefs = getNotificationPrefsFromProfile(manager);
      if (prefs.overdueAlerts) {
        actions.push({
          targetUserId: manager.rowKey,
          urgency: overdue.criticalCount > 0 ? 'high' : 'medium',
          channel: 'teams_chat',
          triggerName: 'overdue_task_escalation',
          reason: `${overdue.total} tasks are overdue across the team`,
          context: {
            totalOverdue: overdue.total,
            criticalCount: overdue.criticalCount,
            blockedCount: overdue.blockedCount,
            topTasks: overdue.tasks.slice(0, 5).map(t => ({
              title: t.title,
              owner: t.owner,
              daysOverdue: t.daysOverdue,
              project: t.project,
            })),
          },
        });
      }
    }

    return actions;
  },
};

// ---------------------------------------------------------------------------
// 2. Stalled Approval Alert
// ---------------------------------------------------------------------------

const stalledApproval: TriggerCondition = {
  id: 'stalled_approval',
  name: 'Stalled Approval Alert',
  cooldownMinutes: 240, // 4 hours
  evaluate: async (users: UserProfile[]): Promise<OutreachAction[]> => {
    const approvals = getPendingApprovals({ older_than_days: 3 });
    if (approvals.overdueCount === 0) return [];

    const actions: OutreachAction[] = [];

    for (const user of users) {
      const prefs = getNotificationPrefsFromProfile(user);
      if (!prefs.approvalReminders) continue;

      // Find approvals where this user is the approver
      const userApprovals = approvals.approvals.filter(a =>
        a.approver.toLowerCase().includes(user.displayName.toLowerCase().split(' ')[0])
      );

      if (userApprovals.length > 0) {
        actions.push({
          targetUserId: user.rowKey,
          urgency: userApprovals.some(a => a.submittedDaysAgo > 5) ? 'high' : 'medium',
          channel: 'teams_chat',
          triggerName: 'stalled_approval',
          reason: `${userApprovals.length} approval(s) are waiting on your action`,
          context: {
            pendingCount: userApprovals.length,
            approvals: userApprovals.map(a => ({
              title: a.title,
              requestor: a.requestor,
              daysWaiting: a.submittedDaysAgo,
              urgency: a.urgency,
            })),
            oldestDays: Math.max(...userApprovals.map(a => a.submittedDaysAgo)),
          },
        });
      }
    }

    return actions;
  },
};

// ---------------------------------------------------------------------------
// 3. Capacity Warning
// ---------------------------------------------------------------------------

const capacityWarning: TriggerCondition = {
  id: 'capacity_warning',
  name: 'Team Capacity Warning',
  cooldownMinutes: 480, // 8 hours
  evaluate: async (users: UserProfile[]): Promise<OutreachAction[]> => {
    const workload = getTeamWorkload({});
    const atRisk = workload.members.filter(m => m.capacity === 'near_limit');

    if (atRisk.length === 0) return [];

    // Notify the first user (manager) about capacity concerns
    if (users.length === 0) return [];

    const manager = users[0];
    const prefs = getNotificationPrefsFromProfile(manager);
    if (!prefs.overdueAlerts) return []; // reuse overdue pref for general ops alerts

    return [{
      targetUserId: manager.rowKey,
      urgency: atRisk.length > 2 ? 'high' : 'medium',
      channel: 'teams_chat',
      triggerName: 'capacity_warning',
      reason: `${atRisk.length} team member(s) are near capacity`,
      context: {
        atRiskCount: atRisk.length,
        members: atRisk.map(m => ({
          name: m.name,
          role: m.role,
          activeTasks: m.activeTasks,
          overdueCount: m.overdueCount,
        })),
        totalActiveTasks: workload.totalActiveTasks,
        totalOverdue: workload.totalOverdue,
      },
    }];
  },
};

// ---------------------------------------------------------------------------
// 4. Morning Briefing
// ---------------------------------------------------------------------------

const morningBriefing: TriggerCondition = {
  id: 'morning_briefing',
  name: 'Morning Briefing',
  cooldownMinutes: 720, // 12 hours — once per day
  evaluate: async (users: UserProfile[]): Promise<OutreachAction[]> => {
    const actions: OutreachAction[] = [];

    // Gather the day's data
    const overdue = getOverdueTasks({ include_at_risk: true });
    const approvals = getPendingApprovals({ older_than_days: 0 });
    const workload = getTeamWorkload({});

    for (const user of users) {
      const prefs = getNotificationPrefsFromProfile(user);
      if (!prefs.morningBrief) continue;

      actions.push({
        targetUserId: user.rowKey,
        urgency: 'low',
        channel: 'teams_chat',
        triggerName: 'morning_briefing',
        reason: 'Your daily morning brief',
        context: {
          greeting: `Good morning, ${user.displayName.split(' ')[0]}`,
          date: new Date().toISOString().slice(0, 10),
          overdueCount: overdue.total,
          criticalTasks: overdue.tasks.filter(t => t.daysOverdue > 3).slice(0, 3).map(t => ({
            title: t.title,
            owner: t.owner,
            daysOverdue: t.daysOverdue,
          })),
          pendingApprovals: approvals.total,
          stalledApprovals: approvals.overdueCount,
          teamAtCapacity: workload.atCapacityCount,
          teamTotalActive: workload.totalActiveTasks,
        },
      });
    }

    return actions;
  },
};

// ---------------------------------------------------------------------------
// 5. Weekly Digest
// ---------------------------------------------------------------------------

const weeklyDigest: TriggerCondition = {
  id: 'weekly_digest',
  name: 'Weekly Digest',
  cooldownMinutes: 5760, // 4 days — fires once per week
  evaluate: async (users: UserProfile[]): Promise<OutreachAction[]> => {
    // Only fire on Monday (or nearest weekday)
    const today = new Date().getDay();
    if (today !== 1) return []; // 1 = Monday

    const actions: OutreachAction[] = [];
    const overdue = getOverdueTasks({ include_at_risk: true });
    const approvals = getPendingApprovals({ older_than_days: 0 });
    const workload = getTeamWorkload({});

    for (const user of users) {
      const prefs = getNotificationPrefsFromProfile(user);
      if (!prefs.weeklyDigest) continue;

      actions.push({
        targetUserId: user.rowKey,
        urgency: 'low',
        channel: 'teams_chat',
        triggerName: 'weekly_digest',
        reason: 'Your weekly operations digest',
        context: {
          weekOf: new Date().toISOString().slice(0, 10),
          overdueTotal: overdue.total,
          overdueByProject: overdue.tasks.reduce((acc, t) => {
            acc[t.project] = (acc[t.project] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          approvalsTotal: approvals.total,
          approvalsStalledCount: approvals.overdueCount,
          teamHighlights: workload.members.map(m => ({
            name: m.name,
            activeTasks: m.activeTasks,
            overdueCount: m.overdueCount,
            capacity: m.capacity,
          })),
        },
      });
    }

    return actions;
  },
};

// ---------------------------------------------------------------------------
// Registry — returns all active triggers
// ---------------------------------------------------------------------------

export function getAllTriggers(): TriggerCondition[] {
  return [
    overdueTaskEscalation,
    stalledApproval,
    capacityWarning,
    morningBriefing,
    weeklyDigest,
  ];
}
