// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Shared authentication — single DefaultAzureCredential instance reused across
// all modules to avoid per-call credential probing overhead on B1 tier.
// ---------------------------------------------------------------------------

import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { AzureOpenAI } from 'openai';
import { config as appConfig } from './featureConfig';

// Single credential instance for the entire process
export const sharedCredential = new DefaultAzureCredential();

// Pre-built token provider for Azure OpenAI (Cognitive Services scope)
export const cognitiveServicesTokenProvider = getBearerTokenProvider(
  sharedCredential,
  'https://cognitiveservices.azure.com/.default',
);

// Shared AzureOpenAI client — reused by all modules except agent.ts (which has custom timeout)
let _sharedOpenAI: AzureOpenAI | null = null;

export function getSharedOpenAI(): AzureOpenAI {
  if (!_sharedOpenAI) {
    _sharedOpenAI = new AzureOpenAI({
      azureADTokenProvider: cognitiveServicesTokenProvider,
      endpoint: appConfig.openAiEndpoint,
      apiVersion: '2025-04-01-preview',
      deployment: appConfig.openAiDeployment,
    });
  }
  return _sharedOpenAI;
}

// Helper: get a Graph API bearer token
export async function getGraphToken(): Promise<string> {
  const result = await sharedCredential.getToken('https://graph.microsoft.com/.default');
  return result.token;
}
