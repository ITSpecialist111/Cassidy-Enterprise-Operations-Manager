// ---------------------------------------------------------------------------
// Tests for src/persona.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { CASSIDY_SYSTEM_PROMPT } from './persona';

describe('persona', () => {
  it('exports CASSIDY_SYSTEM_PROMPT as a non-empty string', () => {
    expect(typeof CASSIDY_SYSTEM_PROMPT).toBe('string');
    expect(CASSIDY_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('identifies the agent as Cassidy', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Cassidy');
  });

  it('specifies the GPT-5 model', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('GPT-5');
  });

  it('defines the Operations Manager role', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Operations Manager');
  });

  it('includes behaviour rules section', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Behaviour Rules');
  });

  it('includes proactive outreach instructions', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Proactive Outreach');
  });

  it('includes meeting intelligence section', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Meeting Intelligence');
  });

  it('includes voice calling section', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Voice Calling');
  });

  it('includes multi-agent orchestration', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('Multi-Agent Orchestration');
  });

  it('warns against markdown tables in Teams', () => {
    expect(CASSIDY_SYSTEM_PROMPT).toContain('NEVER use markdown tables');
  });
});
