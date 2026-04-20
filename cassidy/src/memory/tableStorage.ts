// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TableClient, TableServiceClient, odata } from '@azure/data-tables';
import { sharedCredential } from '../auth';

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT ?? 'cassidyschedsa';
const ENDPOINT = `https://${STORAGE_ACCOUNT}.table.core.windows.net`;

function getTableClient(tableName: string): TableClient {
  return new TableClient(ENDPOINT, tableName, sharedCredential);
}

const _ensuredTables = new Set<string>();
const _tablePromises = new Map<string, Promise<void>>();

function isAuthorizationFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('AuthorizationFailure') || msg.includes('This request is not authorized');
}

async function ensureTable(tableName: string): Promise<void> {
  if (_ensuredTables.has(tableName)) return;

  if (!_tablePromises.has(tableName)) {
    const promise = (async () => {
      try {
        const service = new TableServiceClient(ENDPOINT, sharedCredential);
        await service.createTable(tableName);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('TableAlreadyExists')) {
          // Table exists — that's fine, mark as ensured
        } else if (msg.includes('AuthorizationFailure')) {
          // Can't create tables — assume they exist (created via portal/IaC)
          console.warn(`[TableStorage] Cannot create table "${tableName}" (AuthorizationFailure) — assuming it exists`);
        } else {
          _tablePromises.delete(tableName);
          throw err;
        }
      }
      _ensuredTables.add(tableName);
      _tablePromises.delete(tableName);
    })();
    _tablePromises.set(tableName, promise);
  }

  return _tablePromises.get(tableName);
}

export interface TableEntity {
  partitionKey: string;
  rowKey: string;
  [key: string]: unknown;
}

export async function upsertEntity(tableName: string, entity: TableEntity): Promise<void> {
  try {
    await ensureTable(tableName);
    const client = getTableClient(tableName);
    await client.upsertEntity(entity, 'Replace');
  } catch (err: unknown) {
    if (isAuthorizationFailure(err)) {
      console.warn(`[TableStorage] upsertEntity(${tableName}) authorization failed; skipping persistence`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('TableNotFound')) {
      console.warn(`[TableStorage] upsertEntity(${tableName}) skipped — table does not exist and could not be created`);
      return;
    }
    throw err;
  }
}

export async function getEntity<T extends TableEntity>(
  tableName: string,
  partitionKey: string,
  rowKey: string,
): Promise<T | null> {
  try {
    await ensureTable(tableName);
    const client = getTableClient(tableName);
    const entity = await client.getEntity<T>(partitionKey, rowKey);
    return entity as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ResourceNotFound') || msg.includes('TableNotFound') || msg.includes('404')) return null;
    if (isAuthorizationFailure(err)) {
      console.warn(`[TableStorage] getEntity(${tableName}) authorization failed; returning null`);
      return null;
    }
    throw err;
  }
}

export async function listEntities<T extends TableEntity>(
  tableName: string,
  partitionKey: string,
  filter?: string,
): Promise<T[]> {
  try {
    await ensureTable(tableName);
    const client = getTableClient(tableName);
    const results: T[] = [];
    const baseFilter = odata`PartitionKey eq ${partitionKey}`;
    const queryFilter = filter ? `${baseFilter} and ${filter}` : baseFilter;
    for await (const entity of client.listEntities<T>({ queryOptions: { filter: queryFilter } })) {
      results.push(entity as T);
    }
    return results;
  } catch (err: unknown) {
    if (isAuthorizationFailure(err)) {
      console.warn(`[TableStorage] listEntities(${tableName}) authorization failed; returning empty result set`);
      return [];
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('TableNotFound')) {
      console.warn(`[TableStorage] listEntities(${tableName}) returning empty — table does not exist`);
      return [];
    }
    throw err;
  }
}

export async function deleteEntity(tableName: string, partitionKey: string, rowKey: string): Promise<void> {
  try {
    const client = getTableClient(tableName);
    await client.deleteEntity(partitionKey, rowKey);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ResourceNotFound') && !msg.includes('TableNotFound') && !msg.includes('404')) {
      console.error(`[TableStorage] deleteEntity(${tableName}, ${partitionKey}, ${rowKey}) failed:`, msg);
    }
  }
}
