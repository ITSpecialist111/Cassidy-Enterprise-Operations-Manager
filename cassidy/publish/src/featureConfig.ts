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
  /** Application Insights connection string is set — telemetry available */
  appInsightsConfigured: boolean;
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
  // ── Timeout / interval configuration ──────────────────────────────────
  /** OpenAI SDK client-level timeout (ms) */
  openAiClientTimeoutMs: number;
  /** Per-call OpenAI AbortController timeout (ms) */
  openAiCallTimeoutMs: number;
  /** Per tool-call execution timeout (ms) */
  toolExecTimeoutMs: number;
  /** MCP tool invocation timeout (ms) */
  mcpToolTimeoutMs: number;
  /** Autonomous loop poll interval (ms) */
  autonomousPollIntervalMs: number;
  /** Autonomous loop initial boot delay (ms) */
  autonomousBootDelayMs: number;
  /** Autonomous subtask GPT call timeout (ms) */
  autonomousSubtaskTimeoutMs: number;
  /** Autonomous retry backoff base (ms) */
  autonomousBackoffBaseMs: number;
  /** Goal decomposition GPT call timeout (ms) */
  goalDecomposeTimeoutMs: number;
  /** Agent-to-agent fetch timeout (ms) */
  agentFetchTimeoutMs: number;
  /** Graph API call timeout (ms) */
  graphTimeoutMs: number;
  /** Graph call cache TTL (ms) */
  graphCacheTtlMs: number;
  /** Report cache TTL (ms) */
  reportCacheTtlMs: number;
  /** Proactive engine initial boot delay (ms) */
  proactiveBootDelayMs: number;
  /** Graceful shutdown timeout (ms) */
  shutdownGracePeriodMs: number;
  /** Application Insights connection string */
  appInsightsConnectionString: string;
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
    // ── Timeouts & intervals ──────────────────────────────────────────
    openAiClientTimeoutMs: Number(process.env.OPENAI_CLIENT_TIMEOUT_MS) || 120_000,
    openAiCallTimeoutMs: Number(process.env.OPENAI_CALL_TIMEOUT_MS) || 90_000,
    toolExecTimeoutMs: Number(process.env.TOOL_EXEC_TIMEOUT_MS) || 30_000,
    mcpToolTimeoutMs: Number(process.env.MCP_TOOL_TIMEOUT_MS) || 30_000,
    autonomousPollIntervalMs: Number(process.env.AUTONOMOUS_POLL_INTERVAL_MS) || 120_000,
    autonomousBootDelayMs: Number(process.env.AUTONOMOUS_BOOT_DELAY_MS) || 15_000,
    autonomousSubtaskTimeoutMs: Number(process.env.AUTONOMOUS_SUBTASK_TIMEOUT_MS) || 60_000,
    autonomousBackoffBaseMs: Number(process.env.AUTONOMOUS_BACKOFF_BASE_MS) || 60_000,
    goalDecomposeTimeoutMs: Number(process.env.GOAL_DECOMPOSE_TIMEOUT_MS) || 30_000,
    agentFetchTimeoutMs: Number(process.env.AGENT_FETCH_TIMEOUT_MS) || 30_000,
    graphTimeoutMs: Number(process.env.GRAPH_TIMEOUT_MS) || 10_000,
    graphCacheTtlMs: Number(process.env.GRAPH_CACHE_TTL_MS) || 60_000,
    reportCacheTtlMs: Number(process.env.REPORT_CACHE_TTL_MS) || 60_000,
    proactiveBootDelayMs: Number(process.env.PROACTIVE_BOOT_DELAY_MS) || 30_000,
    shutdownGracePeriodMs: Number(process.env.SHUTDOWN_GRACE_PERIOD_MS) || 10_000,
    appInsightsConnectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? '',
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
    appInsightsConfigured: Boolean(config.appInsightsConnectionString),
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
  console.log(`  App Insights:     ${features.appInsightsConfigured ? '✓ connected' : '✗ no connection string'}`);
  console.log(`  Environment:      ${features.isDevelopment ? 'development' : 'production'}`);
  console.log(`  Base URL:         ${config.baseUrl || '⚠ NOT SET (BASE_URL env var missing)'}`);
  console.log(`  Model:            ${config.openAiDeployment}`);
  console.log(`  Org:              ${config.orgName} (${config.orgTimezone})`);
  console.log('[Cassidy] ──────────────────────────────────────────');
}
