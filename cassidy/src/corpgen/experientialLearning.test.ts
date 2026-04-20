// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { _internal } from './experientialLearning';
import { defaultCassidyIdentity, jitteredWorkday, identitySystemBlock } from './identity';

describe('experientialLearning cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(_internal.cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(_internal.cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('handles zero vectors', () => {
    expect(_internal.cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('experientialLearning jaccard', () => {
  it('returns 1 for identical strings', () => {
    expect(_internal.jaccard('send mail to bob', 'send mail to bob')).toBeCloseTo(1);
  });
  it('returns >0 for partial overlap', () => {
    expect(_internal.jaccard('send mail to bob', 'send teams to alice')).toBeGreaterThan(0);
  });
  it('returns 0 for disjoint strings', () => {
    expect(_internal.jaccard('alpha beta', 'gamma delta')).toBe(0);
  });
});

describe('identity.defaultCassidyIdentity', () => {
  it('produces a sane default for the Cassidy persona', () => {
    const id = defaultCassidyIdentity();
    expect(id.employeeId).toBe('cassidy');
    expect(id.role).toMatch(/Operations Manager/);
    expect(id.responsibilities.length).toBeGreaterThanOrEqual(3);
    expect(id.toolset).toContain('Mail');
    expect(id.schedule.varianceMinutes).toBe(10);
    expect(id.schedule.minCycleIntervalMs).toBe(5 * 60 * 1000);
  });
});

describe('identity.jitteredWorkday', () => {
  it('produces a valid start/end window inside the schedule ±variance', () => {
    const id = defaultCassidyIdentity();
    const { start, end } = jitteredWorkday(id, new Date('2026-04-20T12:00:00Z'));
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(start.getHours()).toBeGreaterThanOrEqual(8);
    expect(end.getHours()).toBeLessThanOrEqual(18);
  });
});

describe('identity.identitySystemBlock', () => {
  it('contains identity, role, schedule', () => {
    const block = identitySystemBlock(defaultCassidyIdentity());
    expect(block).toMatch(/Cassidy/);
    expect(block).toMatch(/Operations Manager/);
    expect(block).toMatch(/Schedule:/);
  });
});
