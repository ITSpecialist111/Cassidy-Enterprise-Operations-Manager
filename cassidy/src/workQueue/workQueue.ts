// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Work queue for autonomous tasks — stored in Azure Table Storage.

import { ulid } from 'ulid';
import { upsertEntity, getEntity, listEntities, deleteEntity, type TableEntity } from '../memory/tableStorage';

const TABLE = 'CassidyWorkQueue';
const PARTITION = 'cassidy';

export type WorkItemStatus = 'pending' | 'in_progress' | 'waiting_on_human' | 'done' | 'failed';

export interface Subtask {
  id: string;
  description: string;
  toolHint?: string;
  dependsOn: string[];
  status: 'pending' | 'done' | 'failed';
  result?: string;
}

export interface WorkItem extends TableEntity {
  goal: string;
  subtasks: string;     // JSON Subtask[]
  currentStep: number;
  status: WorkItemStatus;
  retryCount: number;
  conversationId: string;
  serviceUrl: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  result?: string;
}

export function createWorkItem(params: {
  goal: string;
  subtasks: Subtask[];
  conversationId: string;
  serviceUrl: string;
  userId: string;
}): WorkItem {
  const now = new Date().toISOString();
  return {
    partitionKey: PARTITION,
    rowKey: ulid(),
    goal: params.goal,
    subtasks: JSON.stringify(params.subtasks),
    currentStep: 0,
    status: 'pending',
    retryCount: 0,
    conversationId: params.conversationId,
    serviceUrl: params.serviceUrl,
    userId: params.userId,
    createdAt: now,
    updatedAt: now,
  };
}

export async function enqueueWork(item: WorkItem): Promise<void> {
  await upsertEntity(TABLE, item);
  console.log(`[WorkQueue] Enqueued: "${item.goal.slice(0, 80)}" (${item.rowKey})`);
}

export async function updateWorkItem(item: Partial<WorkItem> & { rowKey: string }): Promise<void> {
  const existing = await getEntity<WorkItem>(TABLE, PARTITION, item.rowKey);
  if (!existing) return;
  const updated = { ...existing, ...item, updatedAt: new Date().toISOString() };
  await upsertEntity(TABLE, updated);
}

export async function getPendingItems(): Promise<WorkItem[]> {
  const pending = await listEntities<WorkItem>(TABLE, PARTITION, `status eq 'pending'`);
  const inProgress = await listEntities<WorkItem>(TABLE, PARTITION, `status eq 'in_progress'`);
  return [...pending, ...inProgress].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
}

export async function getWorkItem(rowKey: string): Promise<WorkItem | null> {
  return getEntity<WorkItem>(TABLE, PARTITION, rowKey);
}

export async function removeWorkItem(rowKey: string): Promise<void> {
  await deleteEntity(TABLE, PARTITION, rowKey);
}

export { ulid };
