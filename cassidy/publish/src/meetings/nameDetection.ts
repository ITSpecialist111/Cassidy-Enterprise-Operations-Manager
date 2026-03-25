// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Name Detection — detects when "Cassidy" is mentioned in meeting transcripts.
// Handles variations, questions, directives, and false positives.
// ---------------------------------------------------------------------------

export interface MentionResult {
  mentioned: boolean;
  type: 'direct_question' | 'directive' | 'greeting' | 'reference' | 'none';
  confidence: number;    // 0.0 – 1.0
  extractedIntent: string;
  originalText: string;
}

// Cassidy name variants (case-insensitive matching)
const NAME_PATTERNS = [
  /\bcassidy\b/i,
  /\bcass\b/i,
  /\b@cassidy\b/i,
  /\bhey\s+cass(?:idy)?\b/i,
];

// Patterns that indicate a direct question TO Cassidy (high confidence)
const QUESTION_PATTERNS = [
  /\bcass(?:idy)?\s*[,.]?\s*(?:what|how|when|where|who|why|can you|could you|do you|are there|is there|tell me|show me|give me|pull up|check|look up|find)/i,
  /(?:what|how|when|where|who|why)\b.*\bcass(?:idy)?\s*\?/i,
  /\bcass(?:idy)?\s*[,.]?\s*(?:any|the|my|our)\b/i,
];

// Patterns that indicate a directive/command TO Cassidy (high confidence)
const DIRECTIVE_PATTERNS = [
  /\bcass(?:idy)?\s*[,.]?\s*(?:create|send|email|schedule|update|move|assign|post|generate|prepare|draft|write|make|set up|book)/i,
  /(?:ask|tell|have|let)\s+cass(?:idy)?\s+(?:to\s+)?/i,
  /\bcass(?:idy)?\s*[,.]?\s*(?:please|can you|could you)\b/i,
];

// Patterns that indicate a REFERENCE to Cassidy, not an invocation (low confidence)
const REFERENCE_PATTERNS = [
  /(?:like|as)\s+cass(?:idy)?\s+(?:said|mentioned|showed|reported|noted)/i,
  /cass(?:idy)?(?:'s|s)\s+(?:report|data|analysis|summary|findings)/i,
  /(?:according to|per)\s+cass(?:idy)?/i,
  /(?:that|what)\s+cass(?:idy)?\s+(?:said|mentioned|reported|showed)/i,
];

// Greeting patterns
const GREETING_PATTERNS = [
  /\b(?:hi|hello|hey|good morning|good afternoon)\s+cass(?:idy)?\b/i,
  /\bcass(?:idy)?\s*[,.]?\s*(?:hi|hello|hey|good morning|good afternoon)\b/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectMention(text: string): MentionResult {
  const trimmed = text.trim();

  // Check if Cassidy is mentioned at all
  const hasMention = NAME_PATTERNS.some(p => p.test(trimmed));
  if (!hasMention) {
    return { mentioned: false, type: 'none', confidence: 0, extractedIntent: '', originalText: trimmed };
  }

  // Check for references (lowest priority — these are NOT invocations)
  if (REFERENCE_PATTERNS.some(p => p.test(trimmed))) {
    return { mentioned: true, type: 'reference', confidence: 0.2, extractedIntent: 'reference to previous Cassidy output', originalText: trimmed };
  }

  // Check for directives (highest value — Cassidy should act)
  if (DIRECTIVE_PATTERNS.some(p => p.test(trimmed))) {
    const intent = extractActionIntent(trimmed);
    return { mentioned: true, type: 'directive', confidence: 0.95, extractedIntent: intent, originalText: trimmed };
  }

  // Check for questions (high value — Cassidy should respond with data)
  if (QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    const intent = extractQuestionIntent(trimmed);
    return { mentioned: true, type: 'direct_question', confidence: 0.9, extractedIntent: intent, originalText: trimmed };
  }

  // Check for greetings
  if (GREETING_PATTERNS.some(p => p.test(trimmed))) {
    return { mentioned: true, type: 'greeting', confidence: 0.7, extractedIntent: 'greeting', originalText: trimmed };
  }

  // Generic mention — name appears but intent unclear
  return { mentioned: true, type: 'direct_question', confidence: 0.5, extractedIntent: 'general mention — context needed', originalText: trimmed };
}

/**
 * Determines if a mention is actionable (should Cassidy respond?)
 * Only returns true for direct questions, directives, and greetings — not references.
 */
export function isActionableMention(result: MentionResult): boolean {
  if (!result.mentioned) return false;
  return result.type !== 'reference' && result.type !== 'none' && result.confidence >= 0.5;
}

// ---------------------------------------------------------------------------
// Intent extraction helpers
// ---------------------------------------------------------------------------

function extractActionIntent(text: string): string {
  // Try to extract the verb + object after Cassidy's name
  const match = text.match(/\bcass(?:idy)?\s*[,.]?\s*((?:please\s+)?(?:create|send|email|schedule|update|move|assign|post|generate|prepare|draft|write|make|set up|book)\b.{0,100})/i);
  return match?.[1]?.trim() ?? text;
}

function extractQuestionIntent(text: string): string {
  // Try to extract the question after Cassidy's name
  const match = text.match(/\bcass(?:idy)?\s*[,.]?\s*((?:what|how|when|where|who|why|can you|could you|do you|are there|is there|tell me|show me|give me|pull up|check|look up|find)\b.{0,150})/i);
  if (match) return match[1].trim();

  // Or before: "what tasks are overdue, Cassidy?"
  const beforeMatch = text.match(/((?:what|how|when|where|who|why)\b.{0,150})\bcass(?:idy)?\s*\??$/i);
  return beforeMatch?.[1]?.trim() ?? text;
}
