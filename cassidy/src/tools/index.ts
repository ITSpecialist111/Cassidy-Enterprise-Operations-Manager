// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatCompletionTool } from 'openai/resources/chat';
import { TurnContext } from '@microsoft/agents-hosting';

import {
  getOverdueTasks,
  getTeamWorkload,
  prioritizeBacklog,
  getPendingApprovals,
  generateStandupReport,
  generateProjectStatusReport,
  OPERATIONS_TOOL_DEFINITIONS,
} from './operationsTools';

import {
  formatForTeams,
  FORMAT_TOOL_DEFINITIONS,
} from './formatTools';

import {
  getMcpTools,
  findUser,
  sendTeamsMessage,
  sendEmail,
  createPlannerTask,
  updatePlannerTask,
  scheduleCalendarEvent,
  readSharePointList,
  invokeMcpTool,
  hasMcpToolServer,
  MCP_TOOL_DEFINITIONS,
} from './mcpToolSetup';

import {
  updateUserPrefs,
  getUser,
  getNotificationPrefsFromProfile,
  type NotificationPrefs,
} from '../proactive/userRegistry';

import { REPORT_TOOL_DEFINITIONS } from './reportTools';
import { MEETING_TOOL_DEFINITIONS } from './meetingTools';
import { VOICE_TOOL_DEFINITIONS } from './voiceTools';
import { generateReport, distributeReport, postReportToTeams } from '../reports/reportGenerator';
import { listTemplates } from '../reports/reportTemplates';
import {
  createDistributionList,
  getDistributionList,
  listDistributionLists,
} from '../reports/distributionManager';
import {
  subscribeToMeeting,
  unsubscribeFromMeeting,
  postToMeetingChat,
  getActiveSubscriptions,
} from '../meetings/meetingMonitor';
import {
  getMeetingSummary,
  addActionItem,
  getActiveMeetings,
  getMeetingSession,
} from '../meetings/meetingContext';
import {
  initiateCall,
  endCall as endVoiceCallFn,
  transferCall as transferCallFn,
  getActiveCalls as getActiveVoiceCalls,
} from '../voice/callManager';
import { isVoiceAvailable, getVoiceConfig } from '../voice/speechProcessor';
import { INTELLIGENCE_TOOL_DEFINITIONS } from './intelligenceTools';
import {
  getOperationalRiskScore,
  getActivePredictions,
  acknowledgePrediction,
} from '../intelligence/predictiveEngine';
import {
  getOrgNode,
  getEscalationChain,
  getDepartmentSummary,
  findExpertise,
  getTeamInfo,
} from '../intelligence/orgGraph';
import {
  rememberFact,
  rememberDecision,
  rememberPreference,
  recall,
  forgetMemory,
  getMemoryStats,
} from '../memory/longTermMemory';
import { ORCHESTRATOR_TOOL_DEFINITIONS } from './orchestratorTools';
import {
  listAgents,
  healthCheckAllAgents,
} from '../orchestrator/agentRegistry';
import { askAgent, routeToMultipleAgents } from '../orchestrator/taskRouter';

// ---------------------------------------------------------------------------
// Utility tools
// ---------------------------------------------------------------------------

function getCurrentDate(): { isoDate: string; utcString: string; localDate: string } {
  const now = new Date();
  return {
    isoDate: now.toISOString(),
    utcString: now.toUTCString(),
    localDate: now.toISOString().slice(0, 10),
  };
}

function getOrganizationContext(): {
  name: string;
  industry: string;
  operationsTeamChannel: string;
  managerEmail: string;
  timezone: string;
  description: string;
} {
  return {
    name: process.env.ORG_NAME ?? 'Contoso Corp',
    industry: process.env.ORG_INDUSTRY ?? 'Enterprise Technology',
    operationsTeamChannel: process.env.OPS_TEAMS_CHANNEL_ID ?? 'demo-channel',
    managerEmail: process.env.MANAGER_EMAIL ?? 'manager@contoso.example.com',
    timezone: process.env.ORG_TIMEZONE ?? 'AEDT (UTC+11)',
    description: `${process.env.ORG_NAME ?? 'Contoso Corp'} is a mid-market enterprise operating across multiple business units. The Operations team coordinates projects, approvals, and cross-functional workflows across the organisation.`,
  };
}

const UTILITY_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_date',
      description: 'Returns the current date and time in ISO 8601, UTC, and local date formats.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_organization_context',
      description: 'Returns context about the organisation Cassidy operates for — name, industry, Teams channel IDs, manager email, and timezone.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ---------------------------------------------------------------------------
// Proactive notification preference tools
// ---------------------------------------------------------------------------

const PROACTIVE_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'setNotificationPreferences',
      description: 'Update the user\'s proactive notification preferences. Controls what Cassidy proactively messages them about: morning briefings, overdue task alerts, approval reminders, meeting prep, and weekly digests. Can also set quiet hours.',
      parameters: {
        type: 'object',
        properties: {
          morning_brief: { type: 'boolean', description: 'Enable/disable the daily morning briefing message.' },
          overdue_alerts: { type: 'boolean', description: 'Enable/disable proactive alerts about overdue tasks.' },
          approval_reminders: { type: 'boolean', description: 'Enable/disable reminders about stalled approvals.' },
          meeting_prep: { type: 'boolean', description: 'Enable/disable pre-meeting context summaries.' },
          weekly_digest: { type: 'boolean', description: 'Enable/disable the weekly operations digest.' },
          quiet_hours_start: { type: 'string', description: 'Start of quiet hours in HH:MM format, e.g. "18:00". No messages during quiet hours.' },
          quiet_hours_end: { type: 'string', description: 'End of quiet hours in HH:MM format, e.g. "08:00".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMyNotificationStatus',
      description: 'Check the current user\'s proactive notification settings — which alerts are enabled, quiet hours, and interaction history.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ---------------------------------------------------------------------------
// getAllTools — combined tool list for the agentic loop
// ---------------------------------------------------------------------------

export function getAllTools(): ChatCompletionTool[] {
  return [
    ...OPERATIONS_TOOL_DEFINITIONS,
    ...FORMAT_TOOL_DEFINITIONS,
    ...MCP_TOOL_DEFINITIONS,
    ...UTILITY_TOOL_DEFINITIONS,
    ...PROACTIVE_TOOL_DEFINITIONS,
    ...REPORT_TOOL_DEFINITIONS,
    ...MEETING_TOOL_DEFINITIONS,
    ...VOICE_TOOL_DEFINITIONS,
    ...INTELLIGENCE_TOOL_DEFINITIONS,
    ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ];
}

// ---------------------------------------------------------------------------
// executeTool — master dispatcher
// ---------------------------------------------------------------------------

type ToolResult = unknown;

// Cache last generated report within a turn to avoid double-generation
// when GPT-5 calls generateReport then distributeReport sequentially
let _lastGeneratedReport: { cacheKey: string; report: Awaited<ReturnType<typeof generateReport>>; timestamp: number } | null = null;

async function getOrGenerateReport(templateId: string, params: Record<string, unknown>, context?: TurnContext) {
  // Include params in cache key so different parameters don't return stale results
  const cacheKey = `${templateId}:${JSON.stringify(params)}`;
  if (_lastGeneratedReport && _lastGeneratedReport.cacheKey === cacheKey && (Date.now() - _lastGeneratedReport.timestamp) < 60_000) {
    return _lastGeneratedReport.report;
  }
  const report = await generateReport(templateId, params as { project_name?: string; period?: string; date?: string }, context);
  if (report.success) {
    _lastGeneratedReport = { cacheKey, report, timestamp: Date.now() };
  }
  return report;
}

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  context?: TurnContext,
): Promise<string> {
  console.log(`[Cassidy] Tool call → ${name}`, JSON.stringify(params, null, 2));

  try {
    let result: ToolResult;

    switch (name) {
      // Operations tools
      case 'getOverdueTasks':
        result = getOverdueTasks(params as Parameters<typeof getOverdueTasks>[0]);
        break;
      case 'getTeamWorkload':
        result = getTeamWorkload(params as Parameters<typeof getTeamWorkload>[0]);
        break;
      case 'prioritizeBacklog':
        result = prioritizeBacklog(params as Parameters<typeof prioritizeBacklog>[0]);
        break;
      case 'getPendingApprovals':
        result = getPendingApprovals(params as Parameters<typeof getPendingApprovals>[0]);
        break;
      case 'generateStandupReport':
        result = generateStandupReport(params as Parameters<typeof generateStandupReport>[0]);
        break;
      case 'generateProjectStatusReport':
        result = generateProjectStatusReport(params as Parameters<typeof generateProjectStatusReport>[0]);
        break;

      // Format tools
      case 'formatForTeams':
        result = formatForTeams(params as Parameters<typeof formatForTeams>[0]);
        break;

      // MCP tools — pass context for OBO token exchange
      case 'getMcpTools':
        result = await getMcpTools(context);
        break;
      case 'findUser':
        result = await findUser(params as Parameters<typeof findUser>[0], context);
        break;
      case 'sendTeamsMessage':
        result = await sendTeamsMessage(params as Parameters<typeof sendTeamsMessage>[0], context);
        break;
      case 'sendEmail':
        result = await sendEmail(params as Parameters<typeof sendEmail>[0], context);
        break;
      case 'createPlannerTask':
        result = await createPlannerTask(params as Parameters<typeof createPlannerTask>[0], context);
        break;
      case 'updatePlannerTask':
        result = await updatePlannerTask(params as Parameters<typeof updatePlannerTask>[0], context);
        break;
      case 'scheduleCalendarEvent':
        result = await scheduleCalendarEvent(params as Parameters<typeof scheduleCalendarEvent>[0], context);
        break;
      case 'readSharePointList':
        result = await readSharePointList(params as Parameters<typeof readSharePointList>[0], context);
        break;

      // Utility tools
      case 'get_current_date':
        result = getCurrentDate();
        break;
      case 'get_organization_context':
        result = getOrganizationContext();
        break;

      // Proactive notification tools
      case 'setNotificationPreferences': {
        const userId = context?.activity?.from?.id ?? '';
        const prefUpdate: Partial<NotificationPrefs> = {};
        if (params.morning_brief !== undefined) prefUpdate.morningBrief = params.morning_brief as boolean;
        if (params.overdue_alerts !== undefined) prefUpdate.overdueAlerts = params.overdue_alerts as boolean;
        if (params.approval_reminders !== undefined) prefUpdate.approvalReminders = params.approval_reminders as boolean;
        if (params.meeting_prep !== undefined) prefUpdate.meetingPrep = params.meeting_prep as boolean;
        if (params.weekly_digest !== undefined) prefUpdate.weeklyDigest = params.weekly_digest as boolean;
        if (params.quiet_hours_start !== undefined) prefUpdate.quietHoursStart = params.quiet_hours_start as string;
        if (params.quiet_hours_end !== undefined) prefUpdate.quietHoursEnd = params.quiet_hours_end as string;
        result = await updateUserPrefs(userId, prefUpdate);
        break;
      }
      case 'getMyNotificationStatus': {
        const userId = context?.activity?.from?.id ?? '';
        const userProfile = await getUser(userId);
        if (userProfile) {
          const prefs = getNotificationPrefsFromProfile(userProfile);
          result = {
            displayName: userProfile.displayName,
            interactionCount: userProfile.interactionCount,
            lastInteraction: userProfile.lastInteraction,
            firstInteraction: userProfile.firstInteraction,
            preferences: prefs,
          };
        } else {
          result = { error: 'No profile found. Send me a message first so I can set up your preferences.' };
        }
        break;
      }

      // Report generation & distribution tools
      case 'generateReport':
        result = await getOrGenerateReport(
          params.template_id as string,
          params,
          context,
        );
        break;
      case 'listReportTemplates':
        result = listTemplates();
        break;
      case 'distributeReport': {
        const report = await getOrGenerateReport(
          params.template_id as string,
          params,
          context,
        );
        if (!report.success) {
          result = { success: false, error: report.error };
          break;
        }
        let recipients = params.recipients as string[] | undefined;
        if (!recipients && params.list_name) {
          recipients = await getDistributionList(params.list_name as string) ?? undefined;
          if (!recipients) {
            result = { success: false, error: `Distribution list "${params.list_name}" not found.` };
            break;
          }
        }
        result = await distributeReport(report, recipients ?? [], context);
        break;
      }
      case 'createDistributionList':
        result = await createDistributionList(
          params.name as string,
          params.members as string[],
          context?.activity?.from?.name,
        );
        break;
      case 'listDistributionLists':
        result = await listDistributionLists();
        break;
      case 'postReportToTeamsChannel': {
        const report = await getOrGenerateReport(
          params.template_id as string,
          params,
          context,
        );
        if (!report.success) {
          result = { success: false, error: report.error };
          break;
        }
        result = await postReportToTeams(report, params.channel_id as string | undefined, context);
        break;
      }

      // Meeting intelligence tools
      case 'joinMeeting': {
        const webhookUrl = `${process.env.BASE_URL ?? 'https://cassidyopsagent-webapp.azurewebsites.net'}/api/meeting-webhook`;
        result = await subscribeToMeeting({
          meetingId: params.meeting_id as string,
          organizerName: params.organizer_name as string | undefined,
          organizerEmail: params.organizer_email as string | undefined,
          chatId: params.chat_id as string | undefined,
          webhookUrl,
        });
        break;
      }
      case 'leaveMeeting': {
        const meetingId = params.meeting_id as string;
        const session = getMeetingSession(meetingId);
        const unsubResult = await unsubscribeFromMeeting(meetingId);
        result = {
          ...unsubResult,
          summary: session ? getMeetingSummary(meetingId) : null,
        };
        break;
      }
      case 'getMeetingSummary':
        result = getMeetingSummary(params.meeting_id as string) ?? { error: 'Meeting not found or not currently monitored.' };
        break;
      case 'postToMeetingChat': {
        const session = getMeetingSession(params.meeting_id as string);
        if (!session?.chatId) {
          result = { success: false, error: 'No chat ID available for this meeting.' };
          break;
        }
        result = await postToMeetingChat(session.chatId, params.message as string);
        break;
      }
      case 'createMeetingActionItem':
        addActionItem(params.meeting_id as string, {
          description: params.description as string,
          assignee: params.assignee as string | undefined,
          dueDate: params.due_date as string | undefined,
          detectedAt: new Date().toISOString(),
          source: context?.activity?.from?.name ?? 'manual',
        });
        result = { success: true, message: 'Action item added to meeting.' };
        break;
      case 'listActiveMeetings': {
        const meetings = getActiveMeetings();
        const subs = getActiveSubscriptions();
        result = meetings.map(m => ({
          meetingId: m.meetingId,
          organizer: m.organizerName,
          participants: m.participants.length,
          duration: getMeetingSummary(m.meetingId)?.duration ?? 'unknown',
          topics: m.detectedTopics,
          actionItems: m.actionItems.length,
          cassidyResponses: m.cassidyResponseCount,
          monitoring: subs.some(s => s.meetingId === m.meetingId),
        }));
        break;
      }

      // Voice call tools
      case 'callUser':
        result = await initiateCall({
          targetUserId: params.user_id as string,
          targetDisplayName: params.display_name as string,
          reason: params.reason as string,
        });
        break;
      case 'endVoiceCall':
        result = await endVoiceCallFn(params.call_id as string);
        break;
      case 'transferCall':
        result = await transferCallFn(params.call_id as string, params.transfer_to_user_id as string);
        break;
      case 'getVoiceStatus':
        result = {
          voiceAvailable: isVoiceAvailable(),
          voiceConfig: getVoiceConfig(),
          activeCalls: getActiveVoiceCalls().map(c => ({
            callId: c.callId,
            target: c.targetDisplayName,
            state: c.state,
            reason: c.reason,
            startedAt: c.startedAt,
          })),
        };
        break;

      // Intelligence & self-awareness tools
      case 'getOperationalRiskScore':
        result = await getOperationalRiskScore();
        break;
      case 'getPredictions':
        result = await getActivePredictions();
        break;
      case 'acknowledgePrediction':
        result = await acknowledgePrediction(params.prediction_id as string);
        break;
      case 'getOrgChart': {
        const node = await getOrgNode(params.user_id as string);
        if (!node) {
          result = { error: 'User not found in org graph. Try refreshing with /api/refresh-org.' };
          break;
        }
        const team = await getTeamInfo(params.user_id as string);
        result = {
          user: { name: node.displayName, title: node.jobTitle, department: node.department, email: node.email },
          manager: { name: node.managerName, id: node.managerId },
          directReports: JSON.parse(node.directReports || '[]'),
          team,
        };
        break;
      }
      case 'getEscalationPath':
        result = await getEscalationChain(params.user_id as string);
        break;
      case 'getDepartmentOverview':
        result = await getDepartmentSummary();
        break;
      case 'findExpert':
        result = await findExpertise(params.area as string);
        break;
      case 'rememberThis': {
        const category = params.category as string;
        const content = params.content as string;
        const tags = params.tags as string[] | undefined;
        const userId = context?.activity?.from?.id ?? '';
        const userName = context?.activity?.from?.name ?? 'unknown';
        if (category === 'preference') {
          result = await rememberPreference({ content, sourceUserId: userId, tags });
        } else if (category === 'decision') {
          result = await rememberDecision({ content, source: userName, sourceUserId: userId, tags });
        } else {
          result = await rememberFact({ content, source: userName, sourceUserId: userId, tags });
        }
        break;
      }
      case 'recallMemory':
        result = await recall(params.query as string, {
          category: params.category as 'fact' | 'decision' | 'preference' | undefined,
          userId: context?.activity?.from?.id,
        });
        break;
      case 'forgetThis':
        result = await forgetMemory(params.memory_id as string);
        break;
      case 'getMemoryStats':
        result = await getMemoryStats();
        break;

      // Multi-agent orchestration tools
      case 'askSpecialistAgent':
        result = await askAgent(params.query as string, params.agent_id as string | undefined);
        break;
      case 'consultMultipleAgents':
        result = await routeToMultipleAgents(params.query as string, params.agent_ids as string[] | undefined);
        break;
      case 'listSpecialistAgents': {
        const allAgents = await listAgents();
        result = allAgents.map(a => ({
          id: a.rowKey,
          name: a.displayName,
          description: a.description,
          expertise: JSON.parse(a.expertise || '[]'),
          status: a.status,
          successRate: a.successRate,
          totalInvocations: a.totalInvocations,
          avgResponseMs: a.averageResponseMs,
        }));
        break;
      }
      case 'checkAgentHealth':
        result = await healthCheckAllAgents();
        break;

      default:
        // Attempt to dispatch via live MCP tool (dynamically discovered from Work IQ gateway)
        if (hasMcpToolServer(name)) {
          result = await invokeMcpTool(name, params);
          break;
        }
        return JSON.stringify({ error: `Unknown tool: "${name}"` });
    }

    return JSON.stringify(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Cassidy] Tool "${name}" threw an error: ${message}`);
    return JSON.stringify({ error: message, tool: name });
  }
}

// ---------------------------------------------------------------------------
// executeAutonomousStandup — called by /api/scheduled endpoint
// ---------------------------------------------------------------------------

export interface StandupSummary {
  timestamp: string;
  date: string;
  actionsCompleted: string[];
  teamsResult?: { success: boolean; messageId?: string };
  emailResult?: { success: boolean; messageId?: string };
}

export async function executeAutonomousStandup(): Promise<StandupSummary> {
  const actionsCompleted: string[] = [];
  const { isoDate, localDate } = getCurrentDate();

  console.log(`[Cassidy] Starting autonomous standup for ${localDate}`);

  // Step 1 — Generate standup content
  const standupMarkdown = generateStandupReport({ date: localDate, include_blockers: true });
  actionsCompleted.push(`Generated standup report for ${localDate}`);

  // Step 2 — Format for Teams
  const teamsMessage = formatForTeams({ content: standupMarkdown, message_type: 'standup' });

  // Step 3 — Post to Operations Teams channel
  const channelId = process.env.OPS_TEAMS_CHANNEL_ID ?? 'demo-channel';
  const teamsResult = await sendTeamsMessage({
    channel_id: channelId,
    message: teamsMessage,
    subject: `Daily Operations Standup — ${localDate}`,
  });
  actionsCompleted.push(
    teamsResult.success
      ? `Teams standup posted to channel ${channelId} (id: ${teamsResult.messageId})`
      : `Teams post failed: ${(teamsResult as { error?: string }).error}`,
  );

  // Step 4 — Email manager with headline summary
  const overdue = getOverdueTasks({ include_at_risk: false });
  const approvals = getPendingApprovals({ older_than_days: 2 });
  const managerEmail = process.env.MANAGER_EMAIL ?? 'manager@contoso.example.com';

  const emailBody = [
    `Daily Operations Standup — ${localDate}`,
    '',
    `Summary: ${overdue.total} overdue task(s), ${approvals.overdueCount} stalled approval(s).`,
    '',
    overdue.total > 0
      ? `Top overdue items:\n${overdue.tasks.slice(0, 3).map(t => `- ${t.title} (${t.owner}, ${t.daysOverdue}d overdue)`).join('\n')}`
      : 'No overdue tasks today.',
    '',
    'Full standup has been posted to the Operations Teams channel.',
    '',
    '— Cassidy, Operations Manager',
  ].join('\n');

  const emailResult = await sendEmail({
    to: managerEmail,
    subject: `[Cassidy] Daily Standup — ${localDate}`,
    body: emailBody,
    importance: overdue.criticalCount > 0 || approvals.highUrgencyCount > 0 ? 'high' : 'normal',
  });
  actionsCompleted.push(
    emailResult.success
      ? `Manager summary email sent to ${managerEmail}`
      : `Email failed: ${(emailResult as { error?: string }).error}`,
  );

  const summary: StandupSummary = {
    timestamp: isoDate,
    date: localDate,
    actionsCompleted,
    teamsResult,
    emailResult,
  };

  console.log(`[Cassidy] Autonomous standup completed at ${isoDate}`);
  actionsCompleted.forEach(a => console.log(`  ✔ ${a}`));

  return summary;
}

// Re-exports for consumers that need individual tool functions
export {
  OPERATIONS_TOOL_DEFINITIONS,
  FORMAT_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  UTILITY_TOOL_DEFINITIONS,
  PROACTIVE_TOOL_DEFINITIONS,
  REPORT_TOOL_DEFINITIONS,
  MEETING_TOOL_DEFINITIONS,
  VOICE_TOOL_DEFINITIONS,
  INTELLIGENCE_TOOL_DEFINITIONS,
  ORCHESTRATOR_TOOL_DEFINITIONS,
  getOverdueTasks,
  getTeamWorkload,
  prioritizeBacklog,
  getPendingApprovals,
  generateStandupReport,
  generateProjectStatusReport,
  formatForTeams,
  getMcpTools,
  findUser,
  sendTeamsMessage,
  sendEmail,
  createPlannerTask,
  updatePlannerTask,
  scheduleCalendarEvent,
  readSharePointList,
  getCurrentDate,
  getOrganizationContext,
};
