// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  turnsTokens,
  classifyTurn,
  DEFAULT_SUMMARISE,
} from './adaptiveSummarizer';
import type { ReActTurn } from './types';

function turn(overrides: Partial<ReActTurn> = {}): ReActTurn {
  return {
    turnIndex: 0,
    kind: 'observation',
    text: 'x',
    critical: false,
    createdAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

describe('adaptiveSummarizer.estimateTokens', () => {
  it('rounds chars / 4 up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('adaptiveSummarizer.turnsTokens', () => {
  it('sums per-turn estimates', () => {
    const turns = [turn({ text: 'abcd' }), turn({ text: 'abcdefgh' })];
    expect(turnsTokens(turns)).toBe(3); // 1 + 2
  });
});

describe('adaptiveSummarizer.classifyTurn', () => {
  it('marks any action as critical', () => {
    expect(classifyTurn({ kind: 'action', tool: 'sendMail', text: 'send' })).toBe(true);
  });
  it('marks failure / error / blocked observations as critical', () => {
    expect(classifyTurn({ kind: 'observation', text: 'task failed' })).toBe(true);
    expect(classifyTurn({ kind: 'observation', text: 'ERROR foo' })).toBe(true);
    expect(classifyTurn({ kind: 'observation', text: 'blocked on dep' })).toBe(true);
  });
  it('marks state changes / failures critical via flags', () => {
    expect(classifyTurn({ kind: 'thought', text: 'hmm', isStateChange: true })).toBe(true);
    expect(classifyTurn({ kind: 'thought', text: 'hmm', isFailure: true })).toBe(true);
  });
  it('routine thoughts are not critical', () => {
    expect(classifyTurn({ kind: 'thought', text: 'i should consider the data' })).toBe(false);
  });
});

describe('adaptiveSummarizer.DEFAULT_SUMMARISE', () => {
  it('threshold matches paper §3.4.4 (4k tokens)', () => {
    expect(DEFAULT_SUMMARISE.thresholdTokens).toBe(4096);
  });
});
