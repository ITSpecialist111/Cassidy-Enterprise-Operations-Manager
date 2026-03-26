// ---------------------------------------------------------------------------
// Conversation Export / Audit Trail
// ---------------------------------------------------------------------------
// Provides conversation export with date-range filtering and optional PII
// redaction for compliance. Exposed via /api/conversations/export.
// ---------------------------------------------------------------------------

import { listEntities, type TableEntity } from './memory/tableStorage';
import { logger } from './logger';

const TABLE = 'CassidyConversations';

interface ConversationEntity extends TableEntity {
  history: string;
  updatedAt: string;
}

export interface ExportedConversation {
  conversationId: string;
  updatedAt: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
  }>;
}

/** PII patterns to redact */
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL]' },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, replacement: '[PHONE]' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[CARD]' },
];

function redactPII(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export interface ExportOptions {
  /** ISO date string — only include conversations updated after this date */
  fromDate?: string;
  /** ISO date string — only include conversations updated before this date */
  toDate?: string;
  /** If true, redact emails, phone numbers, SSNs, card numbers */
  redact?: boolean;
  /** Maximum conversations to return */
  limit?: number;
}

/**
 * Export conversations from Table Storage with optional filtering and PII redaction.
 */
export async function exportConversations(options: ExportOptions = {}): Promise<ExportedConversation[]> {
  const { fromDate, toDate, redact = false, limit = 100 } = options;

  let entities: ConversationEntity[];
  try {
    entities = await listEntities<ConversationEntity>(TABLE, 'cassidy');
  } catch (err) {
    logger.error('Failed to list conversations for export', { module: 'export', error: String(err) });
    return [];
  }

  // Date filtering
  let filtered = entities;
  if (fromDate) {
    filtered = filtered.filter(e => e.updatedAt >= fromDate);
  }
  if (toDate) {
    filtered = filtered.filter(e => e.updatedAt <= toDate);
  }

  // Sort by updatedAt descending
  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Apply limit
  filtered = filtered.slice(0, limit);

  const results: ExportedConversation[] = [];
  for (const entity of filtered) {
    let messages: Array<{ role: string; content: string }>;
    try {
      messages = JSON.parse(entity.history);
    } catch {
      messages = [];
    }

    if (redact) {
      messages = messages.map(m => ({
        role: m.role,
        content: redactPII(m.content),
      }));
    }

    results.push({
      conversationId: entity.rowKey,
      updatedAt: entity.updatedAt,
      messageCount: messages.length,
      messages,
    });
  }

  logger.info('Conversations exported', {
    module: 'export',
    count: results.length,
    redacted: redact,
    fromDate: fromDate ?? 'none',
    toDate: toDate ?? 'none',
  });

  return results;
}
