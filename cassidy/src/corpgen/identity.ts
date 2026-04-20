// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Digital Employee Identity (CorpGen §3.4.4 — "Employee Identity as Stable
// Context")
// ---------------------------------------------------------------------------
// Identity is the stable substrate that survives context resets, summarisation,
// and day boundaries. It encodes who the agent is, what it owns, what tools
// it has, and when it works. Persisted to Azure Table Storage so a new
// process can resume the employee with the same persona and schedule.
// ---------------------------------------------------------------------------

import { upsertEntity, getEntity, type TableEntity } from '../memory/tableStorage';
import { config as appConfig } from '../featureConfig';
import type { DigitalEmployeeIdentity, WorkSchedule } from './types';

const TABLE = 'CorpGenIdentities';
const PARTITION = 'identities';

interface IdentityRow extends TableEntity {
  body: string; // JSON DigitalEmployeeIdentity
  updatedAt: string;
}

/** Build a default Cassidy-style identity using existing app config. */
export function defaultCassidyIdentity(employeeId = 'cassidy'): DigitalEmployeeIdentity {
  const schedule: WorkSchedule = {
    startHour: 9,
    endHour: 17,
    varianceMinutes: 10,
    minCycleIntervalMs: 5 * 60 * 1000,
    timezone: appConfig.orgTimezone || 'Europe/London',
  };
  return {
    employeeId,
    displayName: 'Cassidy',
    role: 'Operations Manager',
    department: 'Operations',
    persona:
      'Organised, decisive, proactive, human-centred. Moves work forward without prompting.',
    responsibilities: [
      'Coordinate cross-functional tasks and approvals',
      'Track project deadlines and escalate slips',
      'Run morning briefings and weekly digests',
      'Triage incoming mail / Teams and route action items',
      'Maintain the operations Planner board',
    ],
    toolset: ['Mail', 'Calendar', 'Planner', 'Teams', 'SharePoint', 'Word', 'Excel', 'PowerPoint'],
    schedule,
    managerEmail: appConfig.managerEmail || undefined,
  };
}

/** Persist an identity so it survives process restart. */
export async function saveIdentity(identity: DigitalEmployeeIdentity): Promise<void> {
  const row: IdentityRow = {
    partitionKey: PARTITION,
    rowKey: identity.employeeId,
    body: JSON.stringify(identity),
    updatedAt: new Date().toISOString(),
  };
  await upsertEntity(TABLE, row);
}

/** Load an identity by id, or null if not yet persisted. */
export async function loadIdentity(employeeId: string): Promise<DigitalEmployeeIdentity | null> {
  const row = await getEntity<IdentityRow>(TABLE, PARTITION, employeeId);
  if (!row) return null;
  try {
    return JSON.parse(row.body) as DigitalEmployeeIdentity;
  } catch {
    return null;
  }
}

/**
 * Apply realistic ±N min jitter to start/end hours for one workday.
 * Returns concrete Date objects in the employee's local schedule.
 */
export function jitteredWorkday(identity: DigitalEmployeeIdentity, now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const variance = identity.schedule.varianceMinutes;
  const jitter = (): number => Math.round((Math.random() * 2 - 1) * variance);
  const start = new Date(now);
  start.setHours(identity.schedule.startHour, jitter(), 0, 0);
  const end = new Date(now);
  end.setHours(identity.schedule.endHour, jitter(), 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

/** Compact identity block to inject into every system prompt. */
export function identitySystemBlock(identity: DigitalEmployeeIdentity): string {
  return [
    `# Identity (stable context)`,
    `Name: ${identity.displayName}`,
    `Role: ${identity.role}${identity.department ? ` — ${identity.department}` : ''}`,
    `Persona: ${identity.persona}`,
    `Responsibilities:`,
    ...identity.responsibilities.map((r) => `  - ${r}`),
    `Toolset: ${identity.toolset.join(', ')}`,
    `Schedule: ${identity.schedule.startHour.toString().padStart(2, '0')}:00–${identity.schedule.endHour.toString().padStart(2, '0')}:00 ${identity.schedule.timezone}`,
  ].join('\n');
}
