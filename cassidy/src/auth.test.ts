// ---------------------------------------------------------------------------
// Tests for src/auth.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies
vi.mock('@azure/identity', () => {
  const mockGetToken = vi.fn().mockResolvedValue({ token: 'mock-token-abc123', expiresOnTimestamp: Date.now() + 3600000 });

  class MockDefaultAzureCredential {
    getToken = mockGetToken;
  }

  return {
    DefaultAzureCredential: MockDefaultAzureCredential,
    getBearerTokenProvider: vi.fn(() => vi.fn().mockResolvedValue('mock-bearer-token')),
  };
});

vi.mock('openai', () => {
  class MockAzureOpenAI {
    chat = { completions: { create: vi.fn() } };
    constructor(_opts?: unknown) {}
  }
  return { AzureOpenAI: MockAzureOpenAI };
});

vi.mock('./featureConfig', () => ({
  config: {
    openAiEndpoint: 'https://test.openai.azure.com',
    openAiDeployment: 'gpt-5',
  },
}));

describe('auth', () => {
  let authModule: typeof import('./auth');

  beforeEach(async () => {
    vi.resetModules();
    authModule = await import('./auth');
  });

  it('exports sharedCredential as an object', () => {
    expect(authModule.sharedCredential).toBeDefined();
    expect(typeof authModule.sharedCredential.getToken).toBe('function');
  });

  it('exports cognitiveServicesTokenProvider as a function', () => {
    expect(typeof authModule.cognitiveServicesTokenProvider).toBe('function');
  });

  it('getSharedOpenAI returns an AzureOpenAI instance', () => {
    const client = authModule.getSharedOpenAI();
    expect(client).toBeDefined();
    expect(client.chat).toBeDefined();
  });

  it('getSharedOpenAI returns the same instance on subsequent calls', () => {
    const a = authModule.getSharedOpenAI();
    const b = authModule.getSharedOpenAI();
    expect(a).toBe(b);
  });

  it('getGraphToken returns a bearer token string', async () => {
    const token = await authModule.getGraphToken();
    expect(token).toBe('mock-token-abc123');
  });

  it('getGraphToken calls credential.getToken with Graph scope', async () => {
    await authModule.getGraphToken();
    expect(authModule.sharedCredential.getToken).toHaveBeenCalledWith(
      'https://graph.microsoft.com/.default',
    );
  });
});
