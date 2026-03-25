// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Persistent conversation memory backed by Azure Table Storage.
// Replaces MemoryStorage — survives restarts and scale-out.

import { upsertEntity, getEntity } from './tableStorage';

const TABLE = 'CassidyConversations';
const MAX_HISTORY = 30;

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

interface ConversationEntity {
  partitionKey: string;
  rowKey: string;
  history: string;   // JSON-serialised HistoryMessage[]
  updatedAt: string;
  [key: string]: unknown;
}

function convKey(conversationId: string): string {
  // Table Storage row keys can't contain /  \  #  ?
  return conversationId.replace(/[/\\#?]/g, '_').slice(0, 200);
}

export async function loadHistory(conversationId: string): Promise<HistoryMessage[]> {
  try {
    const entity = await getEntity<ConversationEntity>(TABLE, 'cassidy', convKey(conversationId));
    if (!entity?.history) return [];
    return JSON.parse(entity.history) as HistoryMessage[];
  } catch {
    return [];
  }
}

export async function saveHistory(conversationId: string, history: HistoryMessage[]): Promise<void> {
  const trimmed = history.slice(-MAX_HISTORY);
  await upsertEntity(TABLE, {
    partitionKey: 'cassidy',
    rowKey: convKey(conversationId),
    history: JSON.stringify(trimmed),
    updatedAt: new Date().toISOString(),
  });
}
