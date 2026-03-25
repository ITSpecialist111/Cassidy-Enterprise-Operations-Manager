import { describe, it, expect } from 'vitest';

// These are private functions in meetingMonitor.ts, so we test the pattern logic directly.
// We replicate the pattern logic here to unit test the heuristics without importing
// the full module (which has side effects like setInterval and Graph API imports).

function detectActionItemPhrase(text: string): boolean {
  const patterns = [
    /\b(?:action item|todo|to-do)\b/i,
    /\b(?:can you|could you|please)\s+(?:make sure|ensure|follow up|create|schedule|send|update)\b/i,
    /\bI(?:'ll|'ll| will)\s+(?:do|handle|take care of|follow up on)\b/i,
    /\b(?:let's|we need to|we should|someone needs to)\s+/i,
    /\bby\s+(?:end of|next|this|Monday|Tuesday|Wednesday|Thursday|Friday)\b/i,
  ];
  return patterns.some(p => p.test(text));
}

function detectTopicPhrase(text: string): string | null {
  const patterns = [
    /\b(?:let's talk about|moving on to|next topic|let's discuss|regarding|about the)\s+(.{5,50})/i,
    /\b(?:agenda item|next up)\s*[:\-]?\s*(.{5,50})/i,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[1].trim().replace(/[.!?]+$/, '');
  }
  return null;
}

describe('meetingMonitor heuristic detectors', () => {
  describe('detectActionItemPhrase', () => {
    it('detects "action item" keyword', () => {
      expect(detectActionItemPhrase('This is an action item for the team')).toBe(true);
    });

    it('detects "todo" keyword', () => {
      expect(detectActionItemPhrase('Add this as a todo')).toBe(true);
    });

    it('detects "to-do" keyword', () => {
      expect(detectActionItemPhrase('This goes on the to-do list')).toBe(true);
    });

    it('detects "can you follow up"', () => {
      expect(detectActionItemPhrase('Can you follow up on this?')).toBe(true);
    });

    it('detects "please send"', () => {
      expect(detectActionItemPhrase('Please send the report by Friday')).toBe(true);
    });

    it('detects "I\'ll handle"', () => {
      expect(detectActionItemPhrase("I'll handle that after the meeting")).toBe(true);
    });

    it('detects "I will do"', () => {
      expect(detectActionItemPhrase('I will do that this afternoon')).toBe(true);
    });

    it('detects "we need to"', () => {
      expect(detectActionItemPhrase('We need to update the spreadsheet')).toBe(true);
    });

    it('detects "we should"', () => {
      expect(detectActionItemPhrase('We should review the budget numbers')).toBe(true);
    });

    it('detects "let\'s"', () => {
      expect(detectActionItemPhrase("Let's schedule a follow-up meeting")).toBe(true);
    });

    it('detects deadline phrases', () => {
      expect(detectActionItemPhrase('Get this done by next Friday')).toBe(true);
    });

    it('detects "by end of"', () => {
      expect(detectActionItemPhrase('Submit the report by end of the week')).toBe(true);
    });

    it('returns false for plain conversation', () => {
      expect(detectActionItemPhrase('The weather looks great today')).toBe(false);
    });

    it('returns false for status observation', () => {
      expect(detectActionItemPhrase('Everything is on track so far')).toBe(false);
    });
  });

  describe('detectTopicPhrase', () => {
    it('detects "let\'s talk about"', () => {
      expect(detectTopicPhrase("Let's talk about the Q4 budget allocation")).toBe('the Q4 budget allocation');
    });

    it('detects "moving on to"', () => {
      expect(detectTopicPhrase('Moving on to the hiring pipeline')).toBe('the hiring pipeline');
    });

    it('detects "next topic"', () => {
      expect(detectTopicPhrase('Next topic is the security audit results')).toBe('is the security audit results');
    });

    it('detects "let\'s discuss"', () => {
      expect(detectTopicPhrase("Let's discuss the marketing strategy")).toBe('the marketing strategy');
    });

    it('detects "regarding"', () => {
      expect(detectTopicPhrase('Regarding the infrastructure upgrade plan')).toBe('the infrastructure upgrade plan');
    });

    it('detects "agenda item:"', () => {
      expect(detectTopicPhrase('Agenda item: resource allocation review')).toBe('resource allocation review');
    });

    it('detects "next up:"', () => {
      expect(detectTopicPhrase('Next up: vendor performance review')).toBe('vendor performance review');
    });

    it('strips trailing punctuation', () => {
      expect(detectTopicPhrase("Let's discuss the budget review.")).toBe('the budget review');
    });

    it('returns null for no topic phrase', () => {
      expect(detectTopicPhrase('I think this looks correct')).toBeNull();
    });

    it('returns null for short captures (under 5 chars)', () => {
      // "about the xyz" — "xyz" is only 3 chars, which is < 5 so regex won't match
      expect(detectTopicPhrase('about the hi!')).toBeNull();
    });
  });
});
