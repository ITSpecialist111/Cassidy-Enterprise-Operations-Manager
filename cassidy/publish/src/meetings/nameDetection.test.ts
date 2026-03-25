import { describe, it, expect } from 'vitest';
import { detectMention, isActionableMention, type MentionResult } from '../meetings/nameDetection';

describe('nameDetection', () => {
  describe('detectMention', () => {
    it('returns no mention for text without Cassidy', () => {
      const result = detectMention('What is the status of the project?');
      expect(result.mentioned).toBe(false);
      expect(result.type).toBe('none');
      expect(result.confidence).toBe(0);
    });

    it('detects direct question with "Cassidy, what..."', () => {
      const result = detectMention('Cassidy, what tasks are overdue?');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('direct_question');
      expect(result.confidence).toBe(0.9);
    });

    it('detects direct question with "Cassidy, are there..."', () => {
      const result = detectMention('Cassidy, are there any overdue tasks on IT Procurement?');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('direct_question');
      expect(result.confidence).toBe(0.9);
    });

    it('detects question with Cassidy at end', () => {
      const result = detectMention('What tasks are overdue, Cassidy?');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('direct_question');
      expect(result.confidence).toBe(0.9);
    });

    it('detects directive "Cassidy, create..."', () => {
      const result = detectMention('Cassidy, create a summary report for Q4');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('directive');
      expect(result.confidence).toBe(0.95);
    });

    it('detects directive "Cassidy, please send..."', () => {
      const result = detectMention('Cassidy, please send an email to the team');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('directive');
      expect(result.confidence).toBe(0.95);
    });

    it('detects directive "ask Cassidy to..."', () => {
      const result = detectMention('Let\'s ask Cassidy to pull up the numbers');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('directive');
      expect(result.confidence).toBe(0.95);
    });

    it('detects greeting "Hi Cassidy"', () => {
      const result = detectMention('Hi Cassidy');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('greeting');
      expect(result.confidence).toBe(0.7);
    });

    it('detects greeting "Good morning Cassidy"', () => {
      const result = detectMention('Good morning Cassidy');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('greeting');
      expect(result.confidence).toBe(0.7);
    });

    it('detects reference "as Cassidy mentioned"', () => {
      const result = detectMention('As Cassidy mentioned earlier, the numbers look good');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('reference');
      expect(result.confidence).toBe(0.2);
    });

    it('detects reference "Cassidy\'s report"', () => {
      const result = detectMention("Let's look at Cassidy's report from last week");
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('reference');
      expect(result.confidence).toBe(0.2);
    });

    it('detects reference "according to Cassidy"', () => {
      const result = detectMention('According to Cassidy, we have 5 overdue tasks');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('reference');
      expect(result.confidence).toBe(0.2);
    });

    it('detects nickname "Cass"', () => {
      const result = detectMention('Cass, what is our budget status?');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('direct_question');
      expect(result.confidence).toBe(0.9);
    });

    it('detects "hey Cass" with "show me" as question', () => {
      const result = detectMention('Hey Cass, show me the task list');
      expect(result.mentioned).toBe(true);
      // "show me" matches QUESTION_PATTERNS, and directives are checked first,
      // but "show me" isn't in DIRECTIVE_PATTERNS — it's in QUESTION_PATTERNS
      expect(result.type).toBe('direct_question');
      expect(result.confidence).toBe(0.9);
    });

    it('detects "@cassidy" mention', () => {
      const result = detectMention('@cassidy check the status');
      expect(result.mentioned).toBe(true);
    });

    it('handles case insensitivity', () => {
      const result = detectMention('CASSIDY, what tasks are overdue?');
      expect(result.mentioned).toBe(true);
      expect(result.type).toBe('direct_question');
    });

    it('returns generic mention with 0.5 confidence for ambiguous use', () => {
      const result = detectMention('I think Cassidy is in the other room');
      expect(result.mentioned).toBe(true);
      expect(result.confidence).toBe(0.5);
    });

    it('preserves original text', () => {
      const text = '  Cassidy, what is the status?  ';
      const result = detectMention(text);
      expect(result.originalText).toBe(text.trim());
    });

    it('extracts question intent', () => {
      const result = detectMention('Cassidy, what tasks are overdue on IT Procurement?');
      expect(result.extractedIntent).toContain('what');
    });

    it('extracts action intent', () => {
      const result = detectMention('Cassidy, create a project status report');
      expect(result.extractedIntent).toContain('create');
    });
  });

  describe('isActionableMention', () => {
    it('returns false for no mention', () => {
      const result: MentionResult = { mentioned: false, type: 'none', confidence: 0, extractedIntent: '', originalText: '' };
      expect(isActionableMention(result)).toBe(false);
    });

    it('returns true for direct question', () => {
      const result = detectMention('Cassidy, what tasks are overdue?');
      expect(isActionableMention(result)).toBe(true);
    });

    it('returns true for directive', () => {
      const result = detectMention('Cassidy, create a report');
      expect(isActionableMention(result)).toBe(true);
    });

    it('returns true for greeting', () => {
      const result = detectMention('Hello Cassidy');
      expect(isActionableMention(result)).toBe(true);
    });

    it('returns false for reference', () => {
      const result = detectMention('As Cassidy mentioned earlier, things are fine');
      expect(isActionableMention(result)).toBe(false);
    });

    it('returns true for generic mention (confidence >= 0.5)', () => {
      const result = detectMention('I wonder what Cassidy thinks');
      expect(isActionableMention(result)).toBe(true);
    });
  });
});
