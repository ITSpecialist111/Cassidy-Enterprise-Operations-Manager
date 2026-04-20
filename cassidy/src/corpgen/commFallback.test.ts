// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the structured-memory side effect so the test never touches Azure.
vi.mock('./tieredMemory', () => ({
  recordStructured: vi.fn(async () => undefined),
}));
vi.mock('../logger', () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
}));

import { withCommFallback, _internal } from './commFallback';
import type { ToolExecutor } from './digitalEmployee';

const noopTools = (): [] => [];

describe('commFallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isDeliveryFailure recognises common failure phrases', () => {
    expect(_internal.isDeliveryFailure(new Error('mailbox unavailable'))).toBe(true);
    expect(_internal.isDeliveryFailure(new Error('SMTP 503 throttled'))).toBe(true);
    expect(_internal.isDeliveryFailure(new Error('user clicked cancel'))).toBe(false);
  });

  it('passes through when primary tool succeeds', async () => {
    const inner: ToolExecutor = {
      hostTools: noopTools,
      execute: vi.fn(async () => 'ok'),
    };
    const wrapped = withCommFallback(inner);
    const r = await wrapped.execute('sendMail', { to: 'a@b.com', subject: 's', body: 'b' });
    expect(r).toBe('ok');
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to secondary on a delivery error and rewrites args', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const inner: ToolExecutor = {
      hostTools: noopTools,
      execute: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'sendMail') throw new Error('mailbox undeliverable');
        return 'sent-via-teams';
      }),
    };
    const wrapped = withCommFallback(inner);
    const r = await wrapped.execute('sendMail', {
      to: 'team@x.com',
      subject: 'Standup',
      body: 'See attached.',
    });
    expect(r).toBe('sent-via-teams');
    expect(calls.map((c) => c.name)).toEqual(['sendMail', 'sendTeamsMessage']);
    expect(calls[1].args.message).toContain('Standup');
    expect(calls[1].args.message).toContain('See attached.');
  });

  it('does not fall back for non-delivery errors', async () => {
    const inner: ToolExecutor = {
      hostTools: noopTools,
      execute: vi.fn(async () => { throw new Error('user not authorised'); }),
    };
    const wrapped = withCommFallback(inner);
    await expect(wrapped.execute('sendMail', { to: 'x' })).rejects.toThrow(/not authorised/);
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for tools without a mapping', async () => {
    const inner: ToolExecutor = {
      hostTools: noopTools,
      execute: vi.fn(async () => { throw new Error('mailbox down'); }),
    };
    const wrapped = withCommFallback(inner);
    await expect(wrapped.execute('createPlannerTask', {})).rejects.toThrow();
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });
});
