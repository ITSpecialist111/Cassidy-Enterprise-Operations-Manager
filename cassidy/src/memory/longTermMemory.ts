// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Long-Term Memory — semantic memory store that persists facts, decisions,
// and contextual knowledge across conversations. Cassidy uses this to
// remember user preferences, project decisions, and operational context
// that shouldn't need to be re-asked.
//
// Architecture: Azure Table Storage + GPT-5 for semantic extraction and
// relevance scoring. No vector DB required — we use GPT-5's reasoning
// to match memories to queries (simpler, cheaper, surprisingly effective).
// ---------------------------------------------------------------------------

import { AzureOpenAI } from 'openai';
import { cognitiveServicesTokenProvider } from '../auth';
import { upsertEntity, getEntity, listEntities, deleteEntity } from '../memory/tableStorage';

const TABLE = 'CassidyLongTermMemory';
const PARTITION_FACTS = 'facts';
const PARTITION_DECISIONS = 'decisions';
const PARTITION_PREFERENCES = 'preferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory = 'fact' | 'decision' | 'preference' | 'context';

export interface MemoryEntry {
  partitionKey: string;
  rowKey: string;                // Unique memory ID
  category: MemoryCategory;
  content: string;               // The memory itself (natural language)
  source: string;                // Who or what created this memory
  sourceUserId: string;          // The user who triggered this memory
  tags: string;                  // JSON array of topic tags
  importance: number;            // 1-10 importance score
  accessCount: number;           // How many times this memory has been retrieved
  lastAccessed: string;          // ISO timestamp
  createdAt: string;             // ISO timestamp
  expiresAt: string;             // ISO timestamp (empty = never)
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Store a memory
// ---------------------------------------------------------------------------

export async function rememberFact(params: {
  content: string;
  source: string;
  sourceUserId?: string;
  tags?: string[];
  importance?: number;
  expiresInDays?: number;
}): Promise<{ success: boolean; memoryId: string }> {
  const memoryId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const partition = getCategoryPartition('fact');

  const entry: MemoryEntry = {
    partitionKey: partition,
    rowKey: memoryId,
    category: 'fact',
    content: params.content,
    source: params.source,
    sourceUserId: params.sourceUserId ?? '',
    tags: JSON.stringify(params.tags ?? []),
    importance: params.importance ?? 5,
    accessCount: 0,
    lastAccessed: '',
    createdAt: new Date().toISOString(),
    expiresAt: params.expiresInDays
      ? new Date(Date.now() + params.expiresInDays * 86400000).toISOString()
      : '',
  };

  await upsertEntity(TABLE, entry);
  console.log(`[LongTermMemory] Stored fact: "${params.content.slice(0, 60)}..." (${memoryId})`);
  return { success: true, memoryId };
}

export async function rememberDecision(params: {
  content: string;
  source: string;
  sourceUserId?: string;
  tags?: string[];
}): Promise<{ success: boolean; memoryId: string }> {
  const memoryId = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const entry: MemoryEntry = {
    partitionKey: getCategoryPartition('decision'),
    rowKey: memoryId,
    category: 'decision',
    content: params.content,
    source: params.source,
    sourceUserId: params.sourceUserId ?? '',
    tags: JSON.stringify(params.tags ?? []),
    importance: 7, // Decisions are generally important
    accessCount: 0,
    lastAccessed: '',
    createdAt: new Date().toISOString(),
    expiresAt: '',
  };

  await upsertEntity(TABLE, entry);
  console.log(`[LongTermMemory] Stored decision: "${params.content.slice(0, 60)}..."`);
  return { success: true, memoryId };
}

export async function rememberPreference(params: {
  content: string;
  sourceUserId: string;
  tags?: string[];
}): Promise<{ success: boolean; memoryId: string }> {
  const memoryId = `pref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const entry: MemoryEntry = {
    partitionKey: getCategoryPartition('preference'),
    rowKey: memoryId,
    category: 'preference',
    content: params.content,
    source: 'user',
    sourceUserId: params.sourceUserId,
    tags: JSON.stringify(params.tags ?? []),
    importance: 6,
    accessCount: 0,
    lastAccessed: '',
    createdAt: new Date().toISOString(),
    expiresAt: '',
  };

  await upsertEntity(TABLE, entry);
  console.log(`[LongTermMemory] Stored preference for ${params.sourceUserId}: "${params.content.slice(0, 60)}..."`);
  return { success: true, memoryId };
}

// ---------------------------------------------------------------------------
// Recall memories — semantic search using GPT-5
// ---------------------------------------------------------------------------

export async function recall(query: string, options?: {
  category?: MemoryCategory;
  userId?: string;
  maxResults?: number;
}): Promise<MemoryEntry[]> {
  const maxResults = options?.maxResults ?? 5;

  // Gather all candidate memories
  let candidates: MemoryEntry[] = [];

  if (options?.category) {
    candidates = await listEntities<MemoryEntry>(TABLE, getCategoryPartition(options.category));
  } else {
    // Search across all categories
    const [facts, decisions, preferences] = await Promise.all([
      listEntities<MemoryEntry>(TABLE, PARTITION_FACTS),
      listEntities<MemoryEntry>(TABLE, PARTITION_DECISIONS),
      listEntities<MemoryEntry>(TABLE, PARTITION_PREFERENCES),
    ]);
    candidates = [...facts, ...decisions, ...preferences];
  }

  // Filter by user if specified
  if (options?.userId) {
    candidates = candidates.filter(m => !m.sourceUserId || m.sourceUserId === options.userId);
  }

  // Remove expired memories
  const now = Date.now();
  candidates = candidates.filter(m => !m.expiresAt || new Date(m.expiresAt).getTime() > now);

  if (candidates.length === 0) return [];

  // For small memory stores (<50 entries), use GPT-5 to rank relevance
  // For larger stores, pre-filter by tags first
  if (candidates.length > 50) {
    candidates = preFilterByTags(candidates, query);
  }

  if (candidates.length <= maxResults) {
    // Update access counts
    for (const m of candidates) {
      await markAccessed(m);
    }
    return candidates;
  }

  // Use GPT-5 to rank by relevance
  return rankByRelevance(query, candidates, maxResults);
}

// ---------------------------------------------------------------------------
// Auto-extract memories from conversations
// ---------------------------------------------------------------------------

export async function extractMemories(
  conversationText: string,
  userId: string,
  userName: string,
): Promise<MemoryEntry[]> {
  const openai = new AzureOpenAI({
    azureADTokenProvider: cognitiveServicesTokenProvider,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2025-04-01-preview',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
  });

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `Extract important facts, decisions, and user preferences from this conversation that Cassidy should remember long-term.

Only extract things that are:
- Factual decisions ("we decided to use vendor X for project Y")
- User preferences ("I prefer reports on Monday mornings")
- Important context ("Project Alpha is delayed because of supply chain issues")
- Team knowledge ("Sarah is the SME for cloud architecture")

Do NOT extract:
- Transient information (task status that changes daily)
- Things that are obvious or already known
- Greetings, pleasantries, or meta-conversation

Return a JSON array of objects:
[{ "category": "fact|decision|preference", "content": "...", "tags": ["tag1", "tag2"], "importance": 1-10 }]

Return an empty array [] if nothing worth remembering.`,
        },
        {
          role: 'user',
          content: conversationText,
        },
      ],
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const items = Array.isArray(parsed) ? parsed : (parsed.memories ?? []);

    const stored: MemoryEntry[] = [];
    for (const item of items) {
      const category = item.category as MemoryCategory;
      if (category === 'preference') {
        const result = await rememberPreference({
          content: item.content,
          sourceUserId: userId,
          tags: item.tags,
        });
        const entry = await getEntity<MemoryEntry>(TABLE, getCategoryPartition(category), result.memoryId);
        if (entry) stored.push(entry);
      } else if (category === 'decision') {
        const result = await rememberDecision({
          content: item.content,
          source: userName,
          sourceUserId: userId,
          tags: item.tags,
        });
        const entry = await getEntity<MemoryEntry>(TABLE, getCategoryPartition(category), result.memoryId);
        if (entry) stored.push(entry);
      } else {
        const result = await rememberFact({
          content: item.content,
          source: userName,
          sourceUserId: userId,
          tags: item.tags,
          importance: item.importance ?? 5,
        });
        const entry = await getEntity<MemoryEntry>(TABLE, getCategoryPartition('fact'), result.memoryId);
        if (entry) stored.push(entry);
      }
    }

    if (stored.length > 0) {
      console.log(`[LongTermMemory] Extracted ${stored.length} memories from conversation`);
    }

    return stored;
  } catch (err) {
    console.error('[LongTermMemory] Memory extraction error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Forget a memory
// ---------------------------------------------------------------------------

export async function forgetMemory(memoryId: string): Promise<{ success: boolean }> {
  // Try all partitions
  for (const partition of [PARTITION_FACTS, PARTITION_DECISIONS, PARTITION_PREFERENCES]) {
    const entry = await getEntity<MemoryEntry>(TABLE, partition, memoryId);
    if (entry) {
      await deleteEntity(TABLE, partition, memoryId);
      console.log(`[LongTermMemory] Forgot: "${entry.content.slice(0, 40)}..."`);
      return { success: true };
    }
  }
  return { success: false };
}

// ---------------------------------------------------------------------------
// Get memory stats
// ---------------------------------------------------------------------------

export async function getMemoryStats(): Promise<{
  totalMemories: number;
  facts: number;
  decisions: number;
  preferences: number;
  oldestMemory: string;
  newestMemory: string;
}> {
  const [facts, decisions, preferences] = await Promise.all([
    listEntities<MemoryEntry>(TABLE, PARTITION_FACTS),
    listEntities<MemoryEntry>(TABLE, PARTITION_DECISIONS),
    listEntities<MemoryEntry>(TABLE, PARTITION_PREFERENCES),
  ]);

  const all = [...facts, ...decisions, ...preferences];
  const sorted = all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return {
    totalMemories: all.length,
    facts: facts.length,
    decisions: decisions.length,
    preferences: preferences.length,
    oldestMemory: sorted[0]?.createdAt ?? '',
    newestMemory: sorted[sorted.length - 1]?.createdAt ?? '',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCategoryPartition(category: MemoryCategory): string {
  switch (category) {
    case 'fact': case 'context': return PARTITION_FACTS;
    case 'decision': return PARTITION_DECISIONS;
    case 'preference': return PARTITION_PREFERENCES;
  }
}

function preFilterByTags(candidates: MemoryEntry[], query: string): MemoryEntry[] {
  const queryWords = query.toLowerCase().split(/\s+/);
  return candidates.filter(m => {
    const content = m.content.toLowerCase();
    const tags = m.tags.toLowerCase();
    return queryWords.some(w => content.includes(w) || tags.includes(w));
  }).slice(0, 30); // Cap at 30 for GPT-5 ranking
}

async function rankByRelevance(
  query: string,
  candidates: MemoryEntry[],
  maxResults: number,
): Promise<MemoryEntry[]> {
  const openai = new AzureOpenAI({
    azureADTokenProvider: cognitiveServicesTokenProvider,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiVersion: '2025-04-01-preview',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
  });

  const memoryList = candidates.map((m, i) => `[${i}] ${m.content}`).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `Given a query and a list of memories, return the indices of the most relevant memories in order of relevance. Return a JSON object: { "indices": [0, 3, 7] }. Max ${maxResults} results.`,
        },
        {
          role: 'user',
          content: `Query: ${query}\n\nMemories:\n${memoryList}`,
        },
      ],
      max_completion_tokens: 100,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return candidates.slice(0, maxResults);

    const result = JSON.parse(content) as { indices: number[] };
    const ranked = result.indices
      .filter(i => i >= 0 && i < candidates.length)
      .slice(0, maxResults)
      .map(i => candidates[i]);

    // Update access counts
    for (const m of ranked) {
      await markAccessed(m);
    }

    return ranked;
  } catch {
    return candidates.slice(0, maxResults);
  }
}

async function markAccessed(entry: MemoryEntry): Promise<void> {
  await upsertEntity(TABLE, {
    ...entry,
    accessCount: (entry.accessCount ?? 0) + 1,
    lastAccessed: new Date().toISOString(),
  });
}
