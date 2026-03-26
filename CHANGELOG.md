# Changelog

All notable changes to the Cassidy Enterprise Operations Manager are documented here.

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
