// ---------------------------------------------------------------------------
// Application Insights Telemetry
// ---------------------------------------------------------------------------
// Thin wrapper around the App Insights SDK.
// When APPLICATIONINSIGHTS_CONNECTION_STRING is not set the module exports
// safe no-op stubs so callers never need to guard on availability.
// ---------------------------------------------------------------------------

import { config, features } from './featureConfig';

// Re-export types we use in call-sites
interface TelemetryClient {
  trackEvent(e: { name: string; properties?: Record<string, string>; measurements?: Record<string, number> }): void;
  trackMetric(m: { name: string; value: number; properties?: Record<string, string> }): void;
  trackException(e: { exception: Error; properties?: Record<string, string> }): void;
  trackDependency(d: {
    dependencyTypeName: string; name: string; data: string;
    duration: number; resultCode: number; success: boolean;
    target?: string; properties?: Record<string, string>;
  }): void;
  flush(): void;
}

// ---------------------------------------------------------------------------
// No-op client used when App Insights is not configured
// ---------------------------------------------------------------------------
const noopClient: TelemetryClient = {
  trackEvent() {},
  trackMetric() {},
  trackException() {},
  trackDependency() {},
  flush() {},
};

let _client: TelemetryClient = noopClient;

/**
 * Initialise Application Insights. Call once at startup (before other imports
 * where possible). Safe to call when the connection string is missing — it
 * will log a warning and leave the no-op client in place.
 */
export function initTelemetry(): void {
  if (!features.appInsightsConfigured) {
    console.log('[Telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set — telemetry disabled');
    return;
  }

  try {
    // Dynamic import keeps the dependency optional at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const appInsights = require('applicationinsights') as typeof import('applicationinsights');
    appInsights.setup(config.appInsightsConnectionString)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoDependencyCorrelation(true)
      .setSendLiveMetrics(true)
      .start();

    _client = appInsights.defaultClient as unknown as TelemetryClient;
    console.log('[Telemetry] Application Insights initialised');
  } catch (err) {
    console.warn('[Telemetry] Failed to initialise App Insights:', err);
  }
}

/** The shared telemetry client (no-op when App Insights is unavailable). */
export function getTelemetryClient(): TelemetryClient {
  return _client;
}

// ---------------------------------------------------------------------------
// Convenience helpers used across the codebase
// ---------------------------------------------------------------------------

/** Track an OpenAI call as a dependency with duration */
export function trackOpenAiCall(durationMs: number, success: boolean, model: string): void {
  _client.trackDependency({
    dependencyTypeName: 'Azure OpenAI',
    name: `chat.completions (${model})`,
    data: model,
    duration: durationMs,
    resultCode: success ? 200 : 500,
    success,
    target: config.openAiEndpoint,
  });
}

/** Track a tool execution */
export function trackToolCall(toolName: string, durationMs: number, success: boolean): void {
  _client.trackDependency({
    dependencyTypeName: 'Tool',
    name: toolName,
    data: toolName,
    duration: durationMs,
    resultCode: success ? 200 : 500,
    success,
  });
}

/** Track proactive engine events (trigger fires, cooldown skips, etc.) */
export function trackProactiveEvent(eventName: string, properties?: Record<string, string>): void {
  _client.trackEvent({ name: `Proactive.${eventName}`, properties });
}

/** Track an unhandled exception */
export function trackException(error: Error, properties?: Record<string, string>): void {
  _client.trackException({ exception: error, properties });
}

/** Flush pending telemetry — call during graceful shutdown */
export function flushTelemetry(): void {
  _client.flush();
}
