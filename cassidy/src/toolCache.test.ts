// ---------------------------------------------------------------------------
// Tests — Tool Result Cache
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  getCachedToolResult,
  cacheToolResult,
  isCacheableTool,
  clearToolCache,
  getToolCacheSize,
} from './toolCache';

describe('toolCache', () => {
  beforeEach(() => {
    clearToolCache();
  });

  it('returns undefined for uncached tools', () => {
    expect(getCachedToolResult('get_planner_tasks', {})).toBeUndefined();
  });

  it('caches and retrieves a tool result', () => {
    const params = { count: 5 };
    cacheToolResult('get_planner_tasks', params, '{"tasks":[]}');
    expect(getCachedToolResult('get_planner_tasks', params)).toBe('{"tasks":[]}');
  });

  it('returns undefined for non-cacheable tools', () => {
    cacheToolResult('send_email', { to: 'x' }, 'sent');
    expect(getCachedToolResult('send_email', { to: 'x' })).toBeUndefined();
  });

  it('uses sorted params for cache key stability', () => {
    cacheToolResult('get_planner_tasks', { b: 2, a: 1 }, 'result');
    // Same params in different order should hit cache
    expect(getCachedToolResult('get_planner_tasks', { a: 1, b: 2 })).toBe('result');
  });

  it('isCacheableTool returns true for read-only tools', () => {
    expect(isCacheableTool('get_planner_tasks')).toBe(true);
    expect(isCacheableTool('get_calendar_events')).toBe(true);
    expect(isCacheableTool('mcp_CalendarServer_get_calendar_events')).toBe(true);
  });

  it('isCacheableTool returns false for write tools', () => {
    expect(isCacheableTool('send_email')).toBe(false);
    expect(isCacheableTool('create_task')).toBe(false);
  });

  it('clearToolCache empties the cache', () => {
    cacheToolResult('get_planner_tasks', {}, 'data');
    expect(getToolCacheSize()).toBe(1);
    clearToolCache();
    expect(getToolCacheSize()).toBe(0);
  });

  it('getToolCacheSize returns correct count', () => {
    expect(getToolCacheSize()).toBe(0);
    cacheToolResult('get_planner_tasks', { a: 1 }, 'r1');
    cacheToolResult('get_calendar_events', { b: 2 }, 'r2');
    expect(getToolCacheSize()).toBe(2);
  });

  it('different params produce different cache entries', () => {
    cacheToolResult('get_planner_tasks', { count: 5 }, 'five');
    cacheToolResult('get_planner_tasks', { count: 10 }, 'ten');
    expect(getCachedToolResult('get_planner_tasks', { count: 5 })).toBe('five');
    expect(getCachedToolResult('get_planner_tasks', { count: 10 })).toBe('ten');
    expect(getToolCacheSize()).toBe(2);
  });
});
