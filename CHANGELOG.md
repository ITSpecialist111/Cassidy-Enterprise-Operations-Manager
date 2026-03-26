# Changelog

All notable changes to the Cassidy Enterprise Operations Manager are documented here.

## [1.7.0] — 2026-03-26

### Deploy #23 — Input Sanitization, Tool Caching, Analytics, Webhooks, Conversation Export, Correlation IDs
- **Input sanitizer**: `inputSanitizer.ts` — 5 injection-pattern categories (system_override, role_override, prompt_extraction, instruction_injection, delimiter_attack) plus control-character stripping. Dual-layer protection (our guard + Azure OpenAI content filter). 16 tests in `inputSanitizer.test.ts`
- **Tool result cache**: `toolCache.ts` — LRU cache (500 entries, 60s TTL) wrapping 12 read-only MCP tools (ListCalendarView, GetUserProfile, etc.) via `withToolCache()`. Skips write tools automatically. 9 tests in `toolCache.test.ts`
- **Conversation analytics**: `analytics.ts` — In-memory conversation metrics: avg/p95 response times, top-5 tools, top-5 users, rate-limited / degraded / sanitised counts. Exposed via `/api/analytics`. 12 tests in `analytics.test.ts`
- **Webhook subscription manager**: `webhookManager.ts` — Graph subscription CRUD (create, renew, delete, list) with 30-min auto-renewal loop. Integrated into server startup/shutdown lifecycle. 8 tests in `webhookManager.test.ts`
- **Conversation export**: `conversationExport.ts` — `/api/conversations/export` endpoint with date-range filtering, PII redaction (email, phone, SSN, card numbers), JSON download. 11 tests in `conversationExport.test.ts`
- **Correlation IDs**: `correlation.ts` — AsyncLocalStorage-based request-scoped correlation IDs. `withCorrelation()` wrapper injected into agent turn handler. All log lines include `correlationId`. 9 tests in `correlation.test.ts`
- **Health v1.7.0**: Added toolResults, rateLimiter.trackedUsers, webhooks fields
- **Test count**: 32 → 38 suites, 402 → 467 tests — all green

## [1.6.0] — 2026-03-26

### Deploy #22 — Approval Handler, Structured Logger, Rate Limiter, Graceful Degradation, LRU Cache
- **Approval action handler**: Adaptive Card `Action.Execute` invoke handler for Approve/Reject buttons with `verb`-based dispatch and confirmation cards
- **Structured JSON logger**: `logger.ts` — Replaced all `console.*` calls with tagged structured logger (`createLogger(module)`). JSON output with timestamp, level, module, correlationId. 7 tests in `logger.test.ts`
- **Per-user rate limiter**: `rateLimiter.ts` — Sliding-window rate limiting (100 requests/60s default, configurable). Returns 429 with retry-after header. 10 tests in `rateLimiter.test.ts`
- **Graceful degradation**: Fallback responses when OpenAI circuit breaker is open — returns helpful "I'm temporarily limited" message instead of error
- **LRU cache**: `lruCache.ts` — Generic LRU cache with TTL, used for user profile insights and memory recall. 13 tests in `lruCache.test.ts`
- **Health v1.6.0**: Added cache stats (size, hits, misses, hitRate) and rate limiter metrics
- **Test count**: 29 → 32 suites, 372 → 402 tests — all green

## [1.5.0] — 2026-03-26

### Deploy #21 — Integration Tests, Retry/Circuit Breakers, Adaptive Cards, SharePoint/OneDrive MCP, Enhanced Health
- **Integration test suite**: `integration.test.ts` — 10 E2E smoke tests exercising the full agent pipeline (tool dispatch, tool schema validation, history wiring, notification detection, goal detection, telemetry hooks)
- **Retry utility & circuit breakers**: `retry.ts` with `withRetry()` (exponential backoff + jitter), `isTransientError()` detection (429/503/timeout/ECONNRESET), `CircuitBreaker` class with open/half-open/closed states. 23 tests in `retry.test.ts`
- **Adaptive Card builder**: `adaptiveCards.ts` — typed card factories for task lists, status summaries, approval requests (with Approve/Reject buttons), reports, and health dashboards. Auto-detection in agent response pipeline via `tryBuildCardFromReply()`. 15 tests in `adaptiveCards.test.ts`
- **SharePoint + OneDrive MCP servers**: Added `mcp_SharePointServer` and `mcp_OneDriveServer` to `CONFIGURED_SERVERS` and `ToolingManifest.json` — 6 MCP servers total (Calendar, Planner, Mail, Teams, SharePoint, OneDrive)
- **Conversation memory tests**: `conversationMemory.test.ts` — 11 tests covering load/save, key sanitization, history trimming to 30 messages, graceful auth failure handling
- **Enhanced health endpoint**: `/api/health` now returns version, uptimeHours, appInsights flag, and circuit breaker states (openAi, graph, mcp)
- **OpenAI retry + circuit breaker**: Wrapped LLM calls with `withRetry()` (2 attempts, 2s base delay) and `openAiCircuit` — auto-opens after 3 consecutive transient failures, resets after 30s
- **Test count**: 25 → 29 suites, 314 → 372 tests — all green

## [1.4.0] — 2026-03-26

### Deploy #20 — Telemetry Tests, CI Hardening, Core Tests, Env Docs
- **Telemetry test suite**: `telemetry.test.ts` — 9 tests covering no-op mode (all helper functions return safely without App Insights) and SDK initialisation path
- **CI hardening**: ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`, zero-warning policy (`--max-warnings 0`), `npm audit` step, `@vitest/coverage-v8` coverage reporting in CI
- **Core module tests**: `featureConfig.test.ts` (10 tests), `auth.test.ts` (6 tests), `persona.test.ts` (10 tests) — 26 new tests covering authentication, system prompt integrity, and centralised config
- **Telemetry wiring**: `trackOpenAiCall()` with timing around LLM calls, `trackToolCall()` with timing around tool execution, `trackException()` in global error handler — all in `agent.ts`
- **Lint cleanup**: Fixed 16 ESLint warnings across 13 files — unused vars/imports, `any` types, useless regex escapes, stale eslint-disable comments, dead code removal
- **.env.template**: Added 30+ new env vars — Speech, Storage, Planner, App Insights, Proactive Engine, and all 15 timeout/interval tuning knobs with documented defaults
- **README update**: Badges (314 tests / 25 suites / v1.4.0 / CI / App Insights), roadmap items checked off, updated build commands
- **Test count**: 21 → 25 suites, 279 → 314 tests — all green

## [1.3.0] — 2026-03-26

### Deploy #19 — CI Pipeline, App Insights, Config Extraction, Bicep IaC
- **GitHub Actions CI**: `.github/workflows/ci.yml` — checkout, Node 22, `npm ci`, `tsc --noEmit`, `vitest run` on push/PR to master
- **Application Insights instrumentation**: `src/telemetry.ts` module with `initTelemetry()`, `trackOpenAiCall()`, `trackToolCall()`, `trackProactiveEvent()`, `trackException()`, `flushTelemetry()`. SDK is an optional dependency — no-op stubs when connection string is absent
- **Magic numbers → env config**: Extracted 15 hardcoded timeouts/intervals across 8 files into `AppConfig` with env var overrides (`OPENAI_CLIENT_TIMEOUT_MS`, `TOOL_EXEC_TIMEOUT_MS`, `AUTONOMOUS_POLL_INTERVAL_MS`, `GRAPH_TIMEOUT_MS`, etc.)
- **Bicep IaC template**: `infra/main.bicep` — App Service Plan, Web App (Node 22, system-assigned identity), Storage Account (6 tables), Log Analytics + Application Insights, Storage Table Data Contributor role assignment
- New `appInsightsConfigured` feature flag in startup status log
- `flushTelemetry()` called during graceful shutdown
- 279 tests still all green

## [1.2.0] — 2026-03-26

### Deploy #18 (`b0022d8`) — Type Safety & Cleanup
- Replaced `as unknown as Activity` double-casts with proper `new Activity()` constructor
- `WorkItem` now extends `TableEntity` directly — eliminated 2 unsafe cast-throughs
- Removed hardcoded `cassidyopsagent-webapp.azurewebsites.net` URL fallback; uses `appConfig.baseUrl` exclusively
- Added `BASE_URL` startup warning in feature status log
- Added explicit return type annotation on `toolName` helper
- Converted 5 debug-level `console.log` / `console.warn` to `console.debug`

### Deploy #17 (`8c36e81`) — Full Test Coverage
- Created 9 new test suites covering every remaining production module
- **autonomousLoop** (4 tests): lifecycle, timer triggers, subtask processing, error resilience
- **workQueue** (10 tests): CRUD, ULID generation, JSON serialization, status filtering
- **orgGraph** (13 tests): node lookup, manager chain, reports, escalation, expertise search
- **userProfiler** (11 tests): interaction recording, peak hours, sentiment, GPT-5 analysis
- **agentRegistry** (14 tests): register/unregister, health checks, A2A invocation, seeding
- **taskRouter** (5 tests): direct routing, auto-routing, fallback, parallel, failure aggregation
- **reportGenerator** (11 tests): template lookup, section content, demo notice, distribution
- **tableStorage** (5 tests): upsert, get, list, delete, round-trip
- **intelligenceTools** (15 tests): definitions validation, duplicate check, required params
- **Total: 21 suites, 279 tests, 0 failures**

### Deploy #16 (`624bde8`) — Test Coverage Phase 1
- Added `operationsTools.test.ts` (18 tests): tool definitions, required params, no duplicates
- Added `tools/index.test.ts` (30 tests): dispatch routing for all 30+ tool branches
- Added `predictiveEngine.test.ts` (42 tests): prediction lifecycle, confidence scoring, anomaly detection
- Grew from 129 to 181 tests across 12 suites

### Deploy #15 (`37eec29`) — Subsystem Wiring
- Prediction cycle now runs every 6th autonomous loop iteration
- User profiler reactive trigger fires every 10th user interaction
- Org graph structure refresh every 72nd loop iteration
- Demo notice propagation via `getDemoNotice()` helper in report generator

### Deploy #14 (`c4ca948`) — Timeout & Shutdown Fixes
- Fixed Promise.race timeout leak — `clearTimeout` on completion prevents dangling timers
- Added graceful shutdown handlers (`SIGTERM`, `SIGINT`) in `index.ts`
- Fixed `conversationMemory.ts` error rethrow (was silently swallowing save failures)
- Eliminated 3 remaining `as any` casts with proper type guards

## [1.1.0] — 2026-03-25

### Deploy #13 (`f547d86`) — Live Graph Planner API
- Replaced mock operations data with live Microsoft Graph Planner API calls
- Queries actual Planner plans, tasks, and assignments
- Falls back to clearly-labeled `[DEMO]` data when Graph API is unavailable

### Deploy #12 (`2635a03`) — Security & Type Hardening
- Replaced `===` string comparison with `timingSafeEqual` for scheduled endpoint auth
- Moved hardcoded URLs to environment config with runtime validation
- Eliminated risky `as any` casts; added proper type guards and interfaces
- Session cleanup and `[DEMO]` labels for all mock data

### Deploy #11 (`b7ecb7c`) — Security & Performance
- Fixed OData query injection vulnerability in Table Storage queries
- Consolidated 13 separate `AzureOpenAI` client instantiations into 1 shared client
- Centralized configuration via `featureConfig.ts` with frozen config object
- Log scrubbing — ensured no tokens, secrets, or PII in production logs

### Deploy #10 (`4154dae`) — Codebase Hardening
- Fixed all catch blocks to properly log with context
- Removed leftover DEMO stubs from production paths
- Completed voice streaming implementation
- Added 42 initial unit tests (meetingContext, meetingMonitor, nameDetection, distributionManager)
- Centralized feature flag system

### Deploy #9 (`0940532`) — Timeout Protection & Risk Dashboard
- Added AbortController / Promise.race timeouts on all async paths:
  - 90s main OpenAI iteration, 60s autonomous subtask, 30s tool/MCP/decomp/agent fetch
- Wired `getOperationalRiskScore`, `getActivePredictions`, `runPredictionCycle` into report generator
- Improved meeting action extraction — extracts verb+object instead of full transcript
- Proactive engine confirmed live: overdue tasks, capacity warnings, morning briefs

### Deploy #8 (`b3fc994`) — MCP Server Filter & Tool Cap
- Added `CONFIGURED_SERVERS` allowlist — filters to only 4 configured MCP servers
- Added `MAX_TOOLS = 128` cap (OpenAI limit) with MCP tools taking priority
- Result: 72 tools loaded from Calendar (13), Mail (22), Planner (10), Teams (27)

### Deploy #7 (`b3fc994`) — OBO Token Header Enrichment
- Implemented `getOboToolHeaders()` in `mcpToolSetup.ts`
- OBO token exchange via `AgenticAuthenticationService.GetAgenticUserToken()`
- Proper header enrichment: Authorization, x-ms-agentid, x-ms-channel-id, User-Agent
- 97 MCP tools discovered (later capped to 72 in deploy #8)

### Deploys #1–#6 — MCP Wiring Foundation
- Progressive MCP wiring: ToolingManifest → auth handler → tenant-id flow
- `AgenticAuthConnection` authorization handler added to `AgentApplication`
- Table Storage fail-open pattern for auth failures
- Storage account public network access enabled

## [1.0.0] — 2026-03-25

### Initial Release (`9fac9c1`)
- Cassidy Enterprise Operations Manager — autonomous agent for Microsoft Teams
- GPT-5 orchestration with agentic tool-calling loop (up to 10 iterations)
- 50+ static tool definitions across operations, intelligence, meetings, reports, voice
- Autonomous work queue with goal decomposition
- Predictive engine with anomaly detection and risk scoring
- Organizational graph with escalation chains and expertise search
- Meeting intelligence: transcript analysis, name detection, action item extraction
- Long-term memory and conversation persistence via Azure Table Storage
- Proactive engine: morning briefs, overdue task alerts, capacity warnings
- Multi-agent orchestration via A2A protocol (agent registry + task router)
- Report generation with customizable templates and multi-channel distribution
- Voice agent with speech processing and call management
- Scheduled standup via Azure Logic App trigger
- Teams manifest with Entra ID authentication (Agent 365 blueprint)
