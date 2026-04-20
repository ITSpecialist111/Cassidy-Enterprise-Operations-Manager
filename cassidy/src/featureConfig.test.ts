// ---------------------------------------------------------------------------
// Tests for src/featureConfig.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Snapshot original env so we can restore
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('featureConfig — default values', () => {
  beforeEach(() => {
    // Clear all feature-related env vars to test defaults
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.MCP_PLATFORM_ENDPOINT;
    delete process.env.MicrosoftAppId;
    delete process.env.MicrosoftAppPassword;
    delete process.env.MicrosoftAppTenantId;
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.NODE_ENV;
  });

  it('config uses default values when no env vars are set', async () => {
    const { config } = await import('./featureConfig');
    expect(config.openAiEndpoint).toBe('https://placeholder.openai.azure.com');
    expect(config.openAiDeployment).toBe('gpt-5');
    expect(config.speechRegion).toBe('australiaeast');
    expect(config.storageAccount).toBe('cassidyschedsa');
    expect(config.orgName).toBe('Contoso Corp');
  });

  it('timeout defaults are sensible', async () => {
    const { config } = await import('./featureConfig');
    expect(config.openAiClientTimeoutMs).toBe(120_000);
    expect(config.openAiCallTimeoutMs).toBe(90_000);
    expect(config.toolExecTimeoutMs).toBe(30_000);
    expect(config.mcpToolTimeoutMs).toBe(30_000);
    expect(config.autonomousPollIntervalMs).toBe(120_000);
    expect(config.autonomousBootDelayMs).toBe(15_000);
    expect(config.autonomousSubtaskTimeoutMs).toBe(60_000);
    expect(config.autonomousBackoffBaseMs).toBe(60_000);
    expect(config.goalDecomposeTimeoutMs).toBe(90_000);
    expect(config.agentFetchTimeoutMs).toBe(30_000);
    expect(config.graphTimeoutMs).toBe(10_000);
    expect(config.graphCacheTtlMs).toBe(60_000);
    expect(config.reportCacheTtlMs).toBe(60_000);
    expect(config.proactiveBootDelayMs).toBe(30_000);
    expect(config.shutdownGracePeriodMs).toBe(10_000);
  });

  it('feature flags are all false when no env vars set', async () => {
    const { features } = await import('./featureConfig');
    expect(features.mcpAvailable).toBe(false);
    expect(features.openAiConfigured).toBe(false);
    expect(features.speechConfigured).toBe(false);
    expect(features.appIdentityConfigured).toBe(false);
    expect(features.appInsightsConfigured).toBe(false);
    expect(features.isDevelopment).toBe(false);
  });

  it('config and features are frozen', async () => {
    const { config, features } = await import('./featureConfig');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(features)).toBe(true);
  });
});

describe('featureConfig — env var overrides', () => {
  it('reads env vars for timeout overrides', async () => {
    process.env.OPENAI_CLIENT_TIMEOUT_MS = '200000';
    process.env.TOOL_EXEC_TIMEOUT_MS = '45000';
    process.env.GRAPH_TIMEOUT_MS = '5000';
    process.env.SHUTDOWN_GRACE_PERIOD_MS = '20000';

    const { config } = await import('./featureConfig');
    expect(config.openAiClientTimeoutMs).toBe(200_000);
    expect(config.toolExecTimeoutMs).toBe(45_000);
    expect(config.graphTimeoutMs).toBe(5_000);
    expect(config.shutdownGracePeriodMs).toBe(20_000);
  });

  it('sets feature flags when env vars are present', async () => {
    process.env.MCP_PLATFORM_ENDPOINT = 'https://mcp.example.com';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://oai.example.com';
    process.env.AZURE_SPEECH_KEY = 'abc123';
    process.env.AZURE_SPEECH_REGION = 'eastus';
    process.env.MicrosoftAppId = 'app-id';
    process.env.MicrosoftAppPassword = 'app-secret';
    process.env.MicrosoftAppTenantId = 'tenant-id';
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=test';
    process.env.NODE_ENV = 'development';

    const { features } = await import('./featureConfig');
    expect(features.mcpAvailable).toBe(true);
    expect(features.openAiConfigured).toBe(true);
    expect(features.speechConfigured).toBe(true);
    expect(features.appIdentityConfigured).toBe(true);
    expect(features.appInsightsConfigured).toBe(true);
    expect(features.isDevelopment).toBe(true);
  });

  it('appIdentityConfigured requires ALL three identity vars', async () => {
    process.env.MicrosoftAppId = 'id';
    process.env.MicrosoftAppPassword = 'secret';
    // MicrosoftAppTenantId intentionally missing
    delete process.env.MicrosoftAppTenantId;

    const { features } = await import('./featureConfig');
    expect(features.appIdentityConfigured).toBe(false);
  });

  it('reads string config from env vars', async () => {
    process.env.ORG_NAME = 'Acme Inc';
    process.env.ORG_TIMEZONE = 'PST (UTC-8)';
    process.env.BASE_URL = 'https://myapp.azurewebsites.net';

    const { config } = await import('./featureConfig');
    expect(config.orgName).toBe('Acme Inc');
    expect(config.orgTimezone).toBe('PST (UTC-8)');
    expect(config.baseUrl).toBe('https://myapp.azurewebsites.net');
  });

  it('handles non-numeric timeout env vars gracefully (falls back to default)', async () => {
    process.env.OPENAI_CALL_TIMEOUT_MS = 'not-a-number';

    const { config } = await import('./featureConfig');
    expect(config.openAiCallTimeoutMs).toBe(90_000);
  });
});

describe('featureConfig — logFeatureStatus', () => {
  it('logFeatureStatus executes without throwing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { logFeatureStatus } = await import('./featureConfig');
    expect(() => logFeatureStatus()).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
