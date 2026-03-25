// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Distribution Manager — manages named distribution lists for report delivery.
// Backed by Azure Table Storage for persistence.
// ---------------------------------------------------------------------------

import { upsertEntity, getEntity, listEntities, deleteEntity } from '../memory/tableStorage';

const TABLE = 'CassidyDistributionLists';
const PARTITION = 'lists';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistributionList {
  partitionKey: string;
  rowKey: string;         // list name (sanitised)
  name: string;           // display name
  members: string;        // JSON string[] of email addresses
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function createDistributionList(
  name: string,
  members: string[],
  createdBy?: string,
): Promise<{ success: boolean; message: string }> {
  const rowKey = sanitiseName(name);
  const existing = await getEntity<DistributionList>(TABLE, PARTITION, rowKey);

  if (existing) {
    return { success: false, message: `Distribution list "${name}" already exists. Use updateDistributionList to modify it.` };
  }

  const now = new Date().toISOString();
  await upsertEntity(TABLE, {
    partitionKey: PARTITION,
    rowKey,
    name,
    members: JSON.stringify(members),
    createdAt: now,
    updatedAt: now,
    createdBy: createdBy ?? 'cassidy',
  });

  console.log(`[Distribution] Created list "${name}" with ${members.length} member(s)`);
  return { success: true, message: `Distribution list "${name}" created with ${members.length} member(s): ${members.join(', ')}` };
}

export async function getDistributionList(name: string): Promise<string[] | null> {
  const entity = await getEntity<DistributionList>(TABLE, PARTITION, sanitiseName(name));
  if (!entity) return null;
  try {
    return JSON.parse(entity.members) as string[];
  } catch {
    return null;
  }
}

export async function updateDistributionList(
  name: string,
  members: string[],
): Promise<{ success: boolean; message: string }> {
  const rowKey = sanitiseName(name);
  const existing = await getEntity<DistributionList>(TABLE, PARTITION, rowKey);

  if (!existing) {
    return { success: false, message: `Distribution list "${name}" not found.` };
  }

  await upsertEntity(TABLE, {
    ...existing,
    members: JSON.stringify(members),
    updatedAt: new Date().toISOString(),
  });

  console.log(`[Distribution] Updated list "${name}" to ${members.length} member(s)`);
  return { success: true, message: `Distribution list "${name}" updated to ${members.length} member(s): ${members.join(', ')}` };
}

export async function removeDistributionList(name: string): Promise<{ success: boolean; message: string }> {
  const rowKey = sanitiseName(name);
  await deleteEntity(TABLE, PARTITION, rowKey);
  console.log(`[Distribution] Deleted list "${name}"`);
  return { success: true, message: `Distribution list "${name}" deleted.` };
}

export async function listDistributionLists(): Promise<Array<{ name: string; memberCount: number; members: string[] }>> {
  const entities = await listEntities<DistributionList>(TABLE, PARTITION);
  return entities.map(e => {
    let members: string[] = [];
    try {
      members = JSON.parse(e.members || '[]') as string[];
    } catch {
      console.warn(`[Distribution] Corrupted members JSON for list "${e.name}"`);
    }
    return {
      name: e.name,
      memberCount: members.length,
      members,
    };
  });
}

export async function addMemberToList(listName: string, email: string): Promise<{ success: boolean; message: string }> {
  const existing = await getDistributionList(listName);
  if (!existing) return { success: false, message: `Distribution list "${listName}" not found.` };

  if (existing.includes(email)) {
    return { success: true, message: `${email} is already in "${listName}".` };
  }

  existing.push(email);
  return updateDistributionList(listName, existing);
}

export async function removeMemberFromList(listName: string, email: string): Promise<{ success: boolean; message: string }> {
  const existing = await getDistributionList(listName);
  if (!existing) return { success: false, message: `Distribution list "${listName}" not found.` };

  const filtered = existing.filter(m => m.toLowerCase() !== email.toLowerCase());
  if (filtered.length === existing.length) {
    return { success: true, message: `${email} was not in "${listName}".` };
  }

  return updateDistributionList(listName, filtered);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseName(name: string): string {
  return name.toLowerCase().replace(/[/\\#?\s]/g, '_').slice(0, 200);
}
