// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Shared authentication — single DefaultAzureCredential instance reused across
// all modules to avoid per-call credential probing overhead on B1 tier.
// ---------------------------------------------------------------------------

import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';

// Single credential instance for the entire process
export const sharedCredential = new DefaultAzureCredential();

// Pre-built token provider for Azure OpenAI (Cognitive Services scope)
export const cognitiveServicesTokenProvider = getBearerTokenProvider(
  sharedCredential,
  'https://cognitiveservices.azure.com/.default',
);

// Helper: get a Graph API bearer token
export async function getGraphToken(): Promise<string> {
  const result = await sharedCredential.getToken('https://graph.microsoft.com/.default');
  return result.token;
}
