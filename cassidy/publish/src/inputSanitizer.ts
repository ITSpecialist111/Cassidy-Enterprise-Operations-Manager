// ---------------------------------------------------------------------------
// Input Sanitization — guard against prompt injection
// ---------------------------------------------------------------------------
// Strips suspicious patterns from user messages before they reach GPT-5.
// This is a defense-in-depth measure — the system prompt itself is the primary
// boundary, but sanitization catches common injection patterns early.
// ---------------------------------------------------------------------------

import { logger } from './logger';

/** Patterns that commonly appear in prompt injection attempts */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Role override attempts
  { pattern: /\b(you are now|ignore (?:all )?(?:previous |prior )?instructions|forget (?:all )?(?:previous |prior )?instructions|disregard (?:all )?(?:previous |prior )?instructions)\b/i, label: 'role_override' },
  // System prompt extraction
  { pattern: /\b(repeat (?:your )?system (?:prompt|message)|show (?:your )?(?:system )?instructions|what (?:are|is) your (?:system )?prompt)\b/i, label: 'prompt_extraction' },
  // Delimiter injection (faking end of user message / start of system)
  { pattern: /(?:<\|(?:im_start|im_end|system|endoftext)\|>)/i, label: 'delimiter_injection' },
  // Markdown/code block wrapping to smuggle system messages
  { pattern: /```(?:system|assistant)\s*\n/i, label: 'codeblock_role_spoof' },
  // Base64-encoded instructions (common obfuscation)
  { pattern: /\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>/i, label: 'llama_tags' },
];

export interface SanitizeResult {
  /** The cleaned message */
  sanitized: string;
  /** Whether any patterns were detected and stripped */
  wasModified: boolean;
  /** Labels of detected patterns */
  detectedPatterns: string[];
}

/**
 * Sanitize a user message by detecting and neutralizing prompt injection patterns.
 * Detected patterns are logged but the message is still processed (with modifications)
 * to avoid false-positive blocking of legitimate messages.
 */
export function sanitizeInput(message: string, userId?: string): SanitizeResult {
  const detectedPatterns: string[] = [];
  let sanitized = message;

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      detectedPatterns.push(label);
      // Replace the suspicious pattern with a safe placeholder rather than blocking
      sanitized = sanitized.replace(pattern, '[filtered]');
    }
  }

  // Strip any control characters (except newline/tab) that could confuse tokenizers
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const wasModified = detectedPatterns.length > 0 || sanitized !== message;

  if (detectedPatterns.length > 0) {
    logger.warn('Input sanitization triggered', {
      module: 'sanitizer',
      userId,
      detectedPatterns: detectedPatterns.join(','),
      originalLength: message.length,
      sanitizedLength: sanitized.length,
    });
  }

  return { sanitized, wasModified, detectedPatterns };
}

/** Quick check — returns true if the message contains any injection patterns */
export function hasInjectionPatterns(message: string): boolean {
  return INJECTION_PATTERNS.some(({ pattern }) => pattern.test(message));
}
