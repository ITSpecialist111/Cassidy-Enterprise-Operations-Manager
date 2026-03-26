// ---------------------------------------------------------------------------
// Centralized Feature Configuration
// ---------------------------------------------------------------------------
// Single source of truth for all environment-driven feature flags and config.
// Import { features } from './featureConfig' to check availability at runtime.
// ---------------------------------------------------------------------------

export interface FeatureFlags {
  /** MCP gateway endpoint is configured — live tool invocation available */
  mcpAvailable: boolean;
  /** Azure Speech key + region set — TTS/STT voice features available */
  speechConfigured: boolean;
  /** Azure OpenAI endpoint set — LLM calls will work */
  openAiConfigured: boolean;
  /** App identity credentials set — Graph + multi-tenant calls available */
  appIdentityConfigured: boolean;
  /** Running in local development mode */
  isDevelopment: boolean;
}

export interface AppConfig {
  /** Azure OpenAI endpoint URL */
  openAiEndpoint: string;
  /** Azure OpenAI deployment (model) name */
  openAiDeployment: string;
  /** Azure Speech subscription key */
  speechKey: string;
  /** Azure Speech service region */
  speechRegion: string;
  /** TTS voice name */
  voiceName: string;
  /** Speech recognition language */
  speechLanguage: string;
  /** Azure Storage account name */
  storageAccount: string;
  /** Organization display name */
  orgName: string;
  /** Organization industry */
  orgIndustry: string;
  /** Organization timezone */
  orgTimezone: string;
  /** Ops Teams channel ID */
  opsTeamsChannelId: string;
  /** Manager email for escalations */
  managerEmail: string;
  /** Proactive engine poll interval (ms) */
  proactiveIntervalMs: number;
  /** Proactive trigger cooldown (minutes) */
  proactiveCooldownMinutes: number;
  /** App base URL (for callbacks/webhooks) */
  baseUrl: string;
  /** Meeting transcript buffer size */
  transcriptBufferSize: number;
  /** Agentic auth connection name */
  agenticConnectionName: string;
  /** Microsoft 365 Group ID for the ops team (Planner + members) */
  plannerGroupId: string;
  /** Planner Plan ID within the group */
  plannerPlanId: string;
}

function readConfig(): AppConfig {
  return {
    openAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || 'https://placeholder.openai.azure.com',
    openAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5',
    speechKey: process.env.AZURE_SPEECH_KEY ?? '',
    speechRegion: process.env.AZURE_SPEECH_REGION ?? 'australiaeast',
    voiceName: process.env.CASSIDY_VOICE ?? 'en-AU-NatashaNeural',
    speechLanguage: process.env.CASSIDY_LANGUAGE ?? 'en-AU',
    storageAccount: process.env.AZURE_STORAGE_ACCOUNT ?? 'cassidyschedsa',
    orgName: process.env.ORG_NAME ?? 'Contoso Corp',
    orgIndustry: process.env.ORG_INDUSTRY ?? 'Enterprise Technology',
    orgTimezone: process.env.ORG_TIMEZONE ?? 'AEDT (UTC+11)',
    opsTeamsChannelId: process.env.OPS_TEAMS_CHANNEL_ID ?? 'demo-channel',
    managerEmail: process.env.MANAGER_EMAIL ?? 'manager@contoso.example.com',
    proactiveIntervalMs: Number(process.env.PROACTIVE_ENGINE_INTERVAL_MS) || 300_000,
    proactiveCooldownMinutes: Number(process.env.PROACTIVE_COOLDOWN_MINUTES) || 60,
    baseUrl: process.env.BASE_URL ?? '',
    transcriptBufferSize: Number(process.env.MEETING_TRANSCRIPT_BUFFER_SIZE) || 50,
    agenticConnectionName: process.env.agentic_connectionName ?? 'AgenticAuthConnection',
    plannerGroupId: process.env.PLANNER_GROUP_ID ?? '',
    plannerPlanId: process.env.PLANNER_PLAN_ID ?? '',
  };
}

function deriveFlags(config: AppConfig): FeatureFlags {
  return {
    mcpAvailable: Boolean(process.env.MCP_PLATFORM_ENDPOINT),
    speechConfigured: Boolean(config.speechKey && config.speechRegion),
    openAiConfigured: Boolean(process.env.AZURE_OPENAI_ENDPOINT),
    appIdentityConfigured: Boolean(
      process.env.MicrosoftAppTenantId &&
      process.env.MicrosoftAppId &&
      process.env.MicrosoftAppPassword
    ),
    isDevelopment: process.env.NODE_ENV === 'development',
  };
}

/** Frozen application configuration — read once at startup */
export const config: Readonly<AppConfig> = Object.freeze(readConfig());

/** Frozen feature flags derived from config */
export const features: Readonly<FeatureFlags> = Object.freeze(deriveFlags(config));

/** Log a startup summary of feature availability */
export function logFeatureStatus(): void {
  console.log('[Cassidy] ── Feature Status ──────────────────────────');
  console.log(`  MCP Gateway:      ${features.mcpAvailable ? '✓ connected' : '✗ unavailable'}`);
  console.log(`  Azure OpenAI:     ${features.openAiConfigured ? '✓ configured' : '✗ missing endpoint'}`);
  console.log(`  Speech/Voice:     ${features.speechConfigured ? '✓ configured' : '✗ no key/region'}`);
  console.log(`  App Identity:     ${features.appIdentityConfigured ? '✓ credentials set' : '✗ incomplete'}`);
  console.log(`  Environment:      ${features.isDevelopment ? 'development' : 'production'}`);
  console.log(`  Base URL:         ${config.baseUrl || '⚠ NOT SET (BASE_URL env var missing)'}`);
  console.log(`  Model:            ${config.openAiDeployment}`);
  console.log(`  Org:              ${config.orgName} (${config.orgTimezone})`);
  console.log('[Cassidy] ──────────────────────────────────────────');
}
