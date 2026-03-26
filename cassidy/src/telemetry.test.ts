// ---------------------------------------------------------------------------
// Tests for src/telemetry.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to reset the module between tests so `_client` resets
let mod: typeof import('./telemetry');

// Stub featureConfig before importing telemetry
vi.mock('./featureConfig', () => ({
  config: {
    appInsightsConnectionString: '',
    openAiEndpoint: 'https://test.openai.azure.com',
  },
  features: {
    appInsightsConfigured: false,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  // Re-import to get a fresh module with reset _client
  mod = await import('./telemetry');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telemetry — no-op mode (no connection string)', () => {
  it('initTelemetry does not throw when App Insights is not configured', () => {
    expect(() => mod.initTelemetry()).not.toThrow();
  });

  it('getTelemetryClient returns a client with all expected methods', () => {
    const client = mod.getTelemetryClient();
    expect(typeof client.trackEvent).toBe('function');
    expect(typeof client.trackMetric).toBe('function');
    expect(typeof client.trackException).toBe('function');
    expect(typeof client.trackDependency).toBe('function');
    expect(typeof client.flush).toBe('function');
  });

  it('no-op client methods do not throw', () => {
    const client = mod.getTelemetryClient();
    expect(() => client.trackEvent({ name: 'test' })).not.toThrow();
    expect(() => client.trackMetric({ name: 'test', value: 1 })).not.toThrow();
    expect(() => client.trackException({ exception: new Error('test') })).not.toThrow();
    expect(() => client.trackDependency({
      dependencyTypeName: 'HTTP', name: 'test', data: 'test',
      duration: 100, resultCode: 200, success: true,
    })).not.toThrow();
    expect(() => client.flush()).not.toThrow();
  });

  it('trackOpenAiCall does not throw in no-op mode', () => {
    expect(() => mod.trackOpenAiCall(150, true, 'gpt-5')).not.toThrow();
  });

  it('trackToolCall does not throw in no-op mode', () => {
    expect(() => mod.trackToolCall('getOverdueTasks', 200, true)).not.toThrow();
  });

  it('trackProactiveEvent does not throw in no-op mode', () => {
    expect(() => mod.trackProactiveEvent('TriggerFired', { userId: 'u1' })).not.toThrow();
  });

  it('trackException does not throw in no-op mode', () => {
    expect(() => mod.trackException(new Error('boom'), { module: 'test' })).not.toThrow();
  });

  it('flushTelemetry does not throw in no-op mode', () => {
    expect(() => mod.flushTelemetry()).not.toThrow();
  });
});

describe('telemetry — initTelemetry with configured connection string', () => {
  it('initialises successfully when applicationinsights is available', async () => {
    vi.resetModules();
    vi.mock('./featureConfig', () => ({
      config: { appInsightsConnectionString: 'InstrumentationKey=fake', openAiEndpoint: 'https://test.openai.azure.com' },
      features: { appInsightsConfigured: true },
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const freshMod = await import('./telemetry');
    freshMod.initTelemetry();

    // applicationinsights is installed, so it should initialise
    expect(logSpy).toHaveBeenCalledWith('[Telemetry] Application Insights initialised');
    // Client should have real methods
    expect(typeof freshMod.getTelemetryClient().flush).toBe('function');
    logSpy.mockRestore();
  });
});
