// ---------------------------------------------------------------------------
// Tests — Structured JSON Logger
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from './logger';

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits JSON for info level', () => {
    logger.info('test message', { module: 'test' });
    expect(logSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
    expect(parsed.module).toBe('test');
    expect(parsed.timestamp).toBeDefined();
  });

  it('emits JSON for warn level', () => {
    logger.warn('warning msg');
    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('warn');
    expect(parsed.message).toBe('warning msg');
  });

  it('emits JSON for error level', () => {
    logger.error('error msg', { userId: 'u1', durationMs: 500 });
    expect(errorSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.userId).toBe('u1');
    expect(parsed.durationMs).toBe(500);
  });

  it('includes all context fields in output', () => {
    logger.info('ctx check', { module: 'agent', userId: 'u2', conversationId: 'c3', toolName: 'planner' });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.module).toBe('agent');
    expect(parsed.userId).toBe('u2');
    expect(parsed.conversationId).toBe('c3');
    expect(parsed.toolName).toBe('planner');
  });

  it('includes ISO timestamp in every entry', () => {
    logger.info('ts check');
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(() => new Date(parsed.timestamp)).not.toThrow();
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  it('debug is suppressed at default info level', () => {
    logger.debug('should not appear');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('supports arbitrary extra fields', () => {
    logger.info('extra', { module: 'test', custom: 'value', count: 42 });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.custom).toBe('value');
    expect(parsed.count).toBe(42);
  });
});
