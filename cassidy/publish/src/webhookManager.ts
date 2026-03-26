// ---------------------------------------------------------------------------
// Webhook Subscription Manager — auto-create and auto-renew Graph webhooks
// ---------------------------------------------------------------------------
// Manages Graph change notification subscriptions for meeting transcripts,
// calendar events, and mail. Renews before expiry to avoid missed events.
// ---------------------------------------------------------------------------

import { sharedCredential as credential } from './auth';
import { logger } from './logger';
import { config, features } from './featureConfig';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SUBSCRIPTION_TABLE = new Map<string, WebhookSubscription>();

export interface WebhookSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState: string;
  createdAt: string;
}

interface GraphSubscriptionResponse {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState: string;
}

async function getGraphToken(): Promise<string> {
  const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
  return tokenResponse.token;
}

/**
 * Create a Graph webhook subscription.
 */
export async function createSubscription(
  resource: string,
  changeType: string,
  clientState: string,
  expirationMinutes = 4230, // max for most resources: ~2.9 days
): Promise<WebhookSubscription> {
  const baseUrl = config.baseUrl;
  if (!baseUrl) throw new Error('BASE_URL not configured — cannot register webhook');

  const token = await getGraphToken();
  const expiration = new Date(Date.now() + expirationMinutes * 60_000).toISOString();

  const body = {
    changeType,
    notificationUrl: `${baseUrl}/api/meeting-webhook`,
    resource,
    expirationDateTime: expiration,
    clientState,
  };

  const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.graphTimeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Graph subscription creation failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as GraphSubscriptionResponse;
  const sub: WebhookSubscription = {
    id: data.id,
    resource: data.resource,
    changeType: data.changeType,
    notificationUrl: data.notificationUrl,
    expirationDateTime: data.expirationDateTime,
    clientState: data.clientState,
    createdAt: new Date().toISOString(),
  };

  SUBSCRIPTION_TABLE.set(sub.id, sub);
  logger.info('Webhook subscription created', { module: 'webhooks', resource, subscriptionId: sub.id });
  return sub;
}

/**
 * Renew an existing subscription before it expires.
 */
export async function renewSubscription(
  subscriptionId: string,
  expirationMinutes = 4230,
): Promise<WebhookSubscription> {
  const token = await getGraphToken();
  const expiration = new Date(Date.now() + expirationMinutes * 60_000).toISOString();

  const res = await fetch(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expirationDateTime: expiration }),
    signal: AbortSignal.timeout(config.graphTimeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Graph subscription renewal failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as GraphSubscriptionResponse;
  const existing = SUBSCRIPTION_TABLE.get(subscriptionId);
  const sub: WebhookSubscription = {
    id: data.id,
    resource: existing?.resource ?? data.resource,
    changeType: existing?.changeType ?? data.changeType,
    notificationUrl: data.notificationUrl,
    expirationDateTime: data.expirationDateTime,
    clientState: existing?.clientState ?? data.clientState,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  SUBSCRIPTION_TABLE.set(sub.id, sub);
  logger.info('Webhook subscription renewed', { module: 'webhooks', subscriptionId });
  return sub;
}

/**
 * Delete a subscription.
 */
export async function deleteSubscription(subscriptionId: string): Promise<void> {
  const token = await getGraphToken();

  const res = await fetch(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(config.graphTimeoutMs),
  });

  if (!res.ok && res.status !== 404) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Graph subscription deletion failed (${res.status}): ${errText}`);
  }
  SUBSCRIPTION_TABLE.delete(subscriptionId);
  logger.info('Webhook subscription deleted', { module: 'webhooks', subscriptionId });
}

/** Get all tracked subscriptions */
export function getActiveSubscriptions(): WebhookSubscription[] {
  return [...SUBSCRIPTION_TABLE.values()];
}

/** Get subscriptions expiring within the given window */
export function getExpiringSoon(withinMs = 3_600_000): WebhookSubscription[] {
  const cutoff = new Date(Date.now() + withinMs).toISOString();
  return [...SUBSCRIPTION_TABLE.values()].filter(s => s.expirationDateTime < cutoff);
}

// Auto-renewal timer reference
let renewalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the auto-renewal loop — checks every 30 minutes for expiring subscriptions.
 */
export function startAutoRenewal(): void {
  if (renewalTimer) return;
  if (!features.appIdentityConfigured || !config.baseUrl) {
    logger.info('Webhook auto-renewal skipped (no app identity or BASE_URL)', { module: 'webhooks' });
    return;
  }

  renewalTimer = setInterval(async () => {
    const expiring = getExpiringSoon(3_600_000); // expiring within 1 hour
    for (const sub of expiring) {
      try {
        await renewSubscription(sub.id);
      } catch (err) {
        logger.error('Webhook renewal failed', { module: 'webhooks', subscriptionId: sub.id, error: String(err) });
      }
    }
  }, 1_800_000); // every 30 min
  renewalTimer.unref();
  logger.info('Webhook auto-renewal loop started', { module: 'webhooks' });
}

/** Stop the auto-renewal loop */
export function stopAutoRenewal(): void {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}

/** Clear all tracked subscriptions (for testing) */
export function _resetSubscriptions(): void {
  SUBSCRIPTION_TABLE.clear();
}
