// ---------------------------------------------------------------------------
// Tests — Webhook Subscription Manager
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before import
vi.mock('./auth', () => ({
  sharedCredential: {
    getToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
  },
}));
vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./featureConfig', () => ({
  config: { baseUrl: 'https://cassidy.example.com', graphTimeoutMs: 10_000 },
  features: { appIdentityConfigured: true },
}));

import {
  createSubscription,
  renewSubscription,
  deleteSubscription,
  getActiveSubscriptions,
  getExpiringSoon,
  startAutoRenewal,
  stopAutoRenewal,
  _resetSubscriptions,
} from './webhookManager';

describe('webhookManager', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    _resetSubscriptions();
    stopAutoRenewal();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stopAutoRenewal();
  });

  it('createSubscription calls Graph API and records subscription', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub-1',
        resource: '/me/events',
        changeType: 'created',
        notificationUrl: 'https://cassidy.example.com/api/meeting-webhook',
        expirationDateTime: new Date(Date.now() + 4230 * 60_000).toISOString(),
        clientState: 'secret123',
      }),
    });

    const sub = await createSubscription('/me/events', 'created', 'secret123');
    expect(sub.id).toBe('sub-1');
    expect(sub.resource).toBe('/me/events');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/subscriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getActiveSubscriptions()).toHaveLength(1);
  });

  it('createSubscription throws on Graph error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(createSubscription('/me/events', 'created', 'secret'))
      .rejects.toThrow('Graph subscription creation failed (403)');
  });

  it('renewSubscription updates expiration', async () => {
    // First create a subscription
    const newExpiry = new Date(Date.now() + 4230 * 60_000).toISOString();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub-renew',
        resource: '/me/events',
        changeType: 'created',
        notificationUrl: 'https://cassidy.example.com/api/meeting-webhook',
        expirationDateTime: new Date(Date.now() + 100).toISOString(),
        clientState: 'state1',
      }),
    });
    await createSubscription('/me/events', 'created', 'state1');

    // Now renew it
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub-renew',
        resource: '/me/events',
        changeType: 'created',
        notificationUrl: 'https://cassidy.example.com/api/meeting-webhook',
        expirationDateTime: newExpiry,
        clientState: 'state1',
      }),
    });

    const renewed = await renewSubscription('sub-renew');
    expect(renewed.expirationDateTime).toBe(newExpiry);
  });

  it('deleteSubscription removes from tracking', async () => {
    // Create first
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub-del',
        resource: '/me/events',
        changeType: 'created',
        notificationUrl: 'https://cassidy.example.com/api/meeting-webhook',
        expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
        clientState: 'st',
      }),
    });
    await createSubscription('/me/events', 'created', 'st');
    expect(getActiveSubscriptions()).toHaveLength(1);

    // Then delete
    mockFetch.mockResolvedValueOnce({ ok: true });
    await deleteSubscription('sub-del');
    expect(getActiveSubscriptions()).toHaveLength(0);
  });

  it('deleteSubscription tolerates 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(deleteSubscription('nonexistent')).resolves.toBeUndefined();
  });

  it('deleteSubscription throws on other errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });
    await expect(deleteSubscription('sub-err')).rejects.toThrow('Graph subscription deletion failed (500)');
  });

  it('getExpiringSoon returns subscriptions expiring within window', async () => {
    // Create a subscription expiring in 30 minutes
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'sub-expiring',
        resource: '/me/events',
        changeType: 'created',
        notificationUrl: 'https://cassidy.example.com/api/meeting-webhook',
        expirationDateTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        clientState: 'st',
      }),
    });
    await createSubscription('/me/events', 'created', 'st');

    const expiring = getExpiringSoon(3_600_000); // looking 1 hour ahead
    expect(expiring).toHaveLength(1);
    expect(expiring[0].id).toBe('sub-expiring');
  });

  it('startAutoRenewal and stopAutoRenewal manage interval', () => {
    startAutoRenewal();
    // calling start again should be a no-op
    startAutoRenewal();
    stopAutoRenewal();
    // calling stop again should be safe
    stopAutoRenewal();
  });
});
