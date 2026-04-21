# Changelog

All notable changes to the Cassidy Enterprise Operations Manager are documented here.

## [unreleased] — 2026-04-21

### Agent Mind — Obsidian-style 2D knowledge-graph rebuild

Replaces the previous 3D + bloom NeuralCore with a calm, flat, Obsidian / Karpathy-LLM-Wiki-inspired 2D canvas graph. Goal: a granular, brain-like visualisation where you can see *which* thoughts, tools, memories, and tasks are firing — and which are floating free.

#### Frontend — `cassidy/dashboard/src/NeuralCore.tsx` (rewritten)

- **2D canvas via [`force-graph`](https://github.com/vasturiano/force-graph)** (same author as `3d-force-graph`, no Three.js / WebGL). Bundle dropped from **1352 kB → 185 kB** (~7×).
- **Tokyo Night palette** — dark `#1a1b26` background; per-type colours: core `#7aa2f7`, memory `#9ece6a`, thought `#bb9af7`, tool `#7dcfff`, agent/objective `#e0af68`, task `#f7768e`, user `#c0caf5`.
- **Degree-sized nodes** — `r = 2 + √(degree) · 1.3` for connected nodes (Obsidian convention). Hubs render bold permanent labels; other labels appear on hover or when zoom ≥ 1.6.
- **Neighbour highlight on hover** — non-neighbours dim to ~22 % alpha; touching links thicken and emit directional particles.
- **Outer "starfield" orphan ring** — nodes that only touch a hub (or nothing) are pre-positioned on a ring of radius `~600 + √n · 14`, rendered smaller (1.4 px) and dimmer (55 % alpha, no stroke). Evokes the "cluster of stars / single-cell organisms" requested look — free-floating thoughts visibly separated from the dense connected core.
- **Tightened forces** for the brain-tissue aesthetic: `charge.strength(-55)` with `distanceMax(280)`; intra-cluster link distance `22`, hub-spoke distance `50`, link strength `0.6`; longer cooldown (180 ticks, alpha decay `0.012`) so the simulation settles into proper organic structure.
- Click a node → centre at it and zoom to 2.2; background click → clear selection. Type counts shown in the legend; **Fit** button rescales to viewport.
- Removed deps: `3d-force-graph`, `three`, `@types/three`, and the Vite `resolve.dedupe: ['three']` config.

#### Backend — `dashApi.get('/mindmap')` in `cassidy/src/index.ts` (granular rewrite)

- **Per-invocation tool nodes** — each `tool.call` / `corpgen.tool` event becomes its own node (capped at 25 per tool family) tethered to a tool-family hub. Old code deduped to one node per tool name; now you can see individual usage as it happens.
- **Up to 200 individual thoughts** (was 30). Only the 60 most recent connect to the Reasoning hub — the rest are detected as orphans by the frontend and drift to the starfield ring.
- **Long-term memories from Azure Table Storage** — sample of facts / decisions / preferences pulled from `CassidyMemories` partitioned by category, each as its own node.
- **`#tag`-cluster nodes** — every memory tag gets a synthetic node that links to all memories sharing it → natural topical clusters.
- **User → memory provenance edges** — memories link to the user (`user-profile-{sourceUserId}`) who created them.
- **Stream-of-consciousness chains** — consecutive thoughts in the same correlation group are linked pairwise; thoughts cross-link to all tool-call nodes in the same group → tight, cell-like clumps per task.
- Stats now use `toolUseCount.size` (number of distinct tool families) instead of the removed `toolSet`.

#### Verification

- `npm run build` — clean, dashboard bundle 185 kB.
- `npx tsc --noEmit` (cassidy backend) — clean.
- `npx vitest run` — 513/513 tests pass across 45 suites (no test impact: pure visualisation change).
- Live: deployed and a CorpGen `cycle` job (`/api/corpgen/run`, `phase=cycle`, `force=true`) ran successfully in production, populating the mindmap with thoughts, tool calls, memories, and reflection cycles. Mission Control `/dashboard/` Agent Mind view confirmed working.

## [previously unreleased] — 2026-04-21

### Agentic harness + FAISS vector index + per-task tool filtering

Closes the last three gaps between the Cassidy implementation and the CorpGen paper (Jaye et al., arXiv:2602.14229). Inspired by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) pattern of declarative agent definitions with isolated execution.

#### New files

- **`cassidy/src/corpgen/agentHarness.ts`** — Reusable agentic execution engine. A single `runAgent(config)` function replaces the three bespoke LLM loops that previously existed in `digitalEmployee.ts`, `subAgents.ts` (research), and `subAgents.ts` (CUA planner). Features:
  - **Declarative `AgentDefinition`** — agents are plain objects (not classes): `agentId`, `systemPrompt` (static or dynamic builder), `maxIterations`, `toolChoice`, `responseFormat`, optional `toolAllowlist`, and `continuationPrompt` for multi-pass reasoning.
  - **Per-task tool filtering** (CorpGen Gap #3) — `assembleToolList()` sorts tools by relevance to the current task's app. Cognitive and sub-agent tools are always promoted first; app-relevant MCP tools (matched by server prefix, e.g. `mcp_MailTools_*` for Mail tasks) come next; remaining tools fill the 128-tool cap. Static mapping in `APP_TO_MCP_PREFIX` / `APP_TO_STATIC` covers Mail, Calendar, Teams, Planner, SharePoint, OneDrive.
  - **Context isolation** — each `runAgent()` call gets its own message array, never shared across invocations.
  - **Lifecycle hooks** — `onToolCall`, `onToolResult`, `onIteration`, `onSummarize`, `onComplete` for observability without coupling.
  - **Budget tracking** — shared `HarnessBudget` (wallclock + tool-call caps) threaded from the day runner.
  - **Adaptive summarisation** — delegates to the existing `compressIfNeeded()` between iterations.
  - **Continuation injection** — for `toolChoice='none'` agents (e.g. research sub-agent), injects `continuationPrompt` between non-terminal iterations.

- **`cassidy/src/corpgen/faissIndex.ts`** — FAISS vector index for experiential trajectory retrieval. Uses `faiss-node` (`optionalDependencies`) with automatic fallback to in-memory cosine scan when native bindings are unavailable:
  - One `IndexFlatIP` per app (application-partitioned, per the paper).
  - Lazy load from `CorpGenTrajectories` Table Storage on first access, cached for 10 min.
  - Incremental `add()` after trajectory capture — no full rebuild needed.
  - L2-normalised inner product ≡ cosine similarity.
  - `getAppIndex(app)`, `rebuildAppIndex(app)`, `clearAllIndices()` public API.

#### Modified files

- **`cassidy/src/corpgen/types.ts`** — Added `AgentDefinition`, `AgentPromptContext`, `HarnessRunConfig`, `HarnessBudget`, `HarnessHooks`, `HarnessOutcome`, `VectorIndex` types.
- **`cassidy/src/corpgen/digitalEmployee.ts`** — `runReactLoop()` now delegates to `runAgent()` with the `CORPGEN_REACT_AGENT` definition. Lifecycle hooks preserve the existing event-recording and demo-injection behaviour. Removed the bespoke 140-line inner loop; the harness handles tool assembly, budget, and summarisation. Unused imports (`compressIfNeeded`, `estimateTokens`, `ChatCompletionMessageParam`) and `replaceHistoryWithSummary()` removed.
- **`cassidy/src/corpgen/subAgents.ts`** — `runResearchAgent()` and `defaultIntentPlanner()` both use `runAgent()` instead of direct OpenAI calls. Research agent: `toolChoice='none'`, `continuationPrompt`, `responseFormatFn` for JSON on final iteration. CUA planner: single-shot, `responseFormat='json_object'`. Unused imports (`getSharedOpenAI`, `appConfig`, `ChatCompletionMessageParam`) removed.
- **`cassidy/src/corpgen/experientialLearning.ts`** — FAISS wired as the primary retrieval path in `retrieveSimilarTrajectories()` (try FAISS → fall through to in-memory cosine scan on failure). `captureSuccessfulTrajectory()` incrementally adds to the FAISS index after Table Storage upsert.
- **`cassidy/src/corpgen/index.ts`** — Exports `runAgent`, `assembleToolList`, `getAppIndex`, `rebuildAppIndex`, `clearAllIndices`.
- **`cassidy/package.json`** — Added `faiss-node: ^0.6.0` to `optionalDependencies`.

#### Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — 513/513 tests pass across 45 suites.
- Circular dependency between `agentHarness.ts` ↔ `subAgents.ts` resolved by lazy-initialising the cognitive/subagent name sets (`getCognitiveNames()` / `getSubagentNames()`) instead of computing them at module load time.

### Daily-operator promotion (5-question design pass)

Turns Cassidy from a "fires-when-poked" agent into a CorpGen-style daily operator. Five design answers from MOD Administrator drove the changes:

1. **Manager identity** — Cassidy reports to MOD Administrator, briefed via Teams DM and email.
2. **Cycle cadence** — once a task completes autonomously, no more than every 20 min (matches existing scheduler).
3. **Quiet hours / weekends** — weekdays 09:00–17:30 Australia/Sydney are working hours; everything else is silent.
4. **Real Planner board** — wire a Kanban board into the flight deck.
5. **Trajectory scope** — index successful trajectories from ALL toolset apps (not just Mail/Teams/Planner).

### Implementation

- **Sydney work-hours gate** — `checkWorkHours` in [cassidy/src/corpgenIntegration.ts](cassidy/src/corpgenIntegration.ts) now uses `Intl.DateTimeFormat` against `Australia/Sydney` (overridable via `CORPGEN_WORK_TZ`, `CORPGEN_WORK_START`, `CORPGEN_WORK_END`). Default window: weekdays 09:00–17:30 local. New helper `getLocalParts(now, tz)` is shared with the scheduler so all timezone reasoning lives in one place.
- **Sydney-aware scheduler** — [cassidy/src/corpgenScheduler.ts](cassidy/src/corpgenScheduler.ts) `isWindow()` switched from UTC to Sydney local. Phase windows are now: `init` 08:50, `cycle` every 20 min from 09:00 to 17:00, `reflect` 17:20, `monthly` 1st-of-month 08:00 — all weekday Sydney local. `lastFired` keys also include local minute so DST transitions don't double-fire.
- **Per-employee concurrency semaphore** — `runWorkdayForCassidy` keeps an `_inflight: Map<employeeId, Promise<DayRunResult>>`. A second invocation for the same employee while one is in-flight returns synthetic `DayRunResult` with new `stopReason: 'skipped:in_flight'` (extended in [cassidy/src/corpgen/types.ts](cassidy/src/corpgen/types.ts)). Eliminates the LLM/MCP-lane pile-up that left A2–A5 forced phases stuck `running`.
- **Manager briefing** — New `briefManager(phase, result)` in [cassidy/src/corpgenIntegration.ts](cassidy/src/corpgenIntegration.ts) runs after `init`/`reflect`/`monthly` (cycle phases stay quiet — too noisy). Resolution order: `CORPGEN_MANAGER_USER_ID` env → `CORPGEN_MANAGER_EMAIL` env → display-name match `MOD Administrator` (overridable via `CORPGEN_MANAGER_NAME`).
  - Teams DM via new `sendDirectMessage(userId, text)` exported from [cassidy/src/proactive/proactiveEngine.ts](cassidy/src/proactive/proactiveEngine.ts) — uses the cloud adapter's `continueConversation` with the stored `ConversationReference`.
  - Email best-effort via `sendEmail` MCP. The scheduler runs without `TurnContext` so MailTools returns "MCP unavailable" — logged at warn, not an error. Email delivers when the brief is triggered from a Teams turn (e.g. `cg_run_workday`).
- **Kanban board on Mission Control** — New `GET /api/dashboard/kanban[?employeeId=&date=]` in [cassidy/src/index.ts](cassidy/src/index.ts) loads today's `DailyPlan` from Table Storage and bucketises tasks into Backlog (`pending`) / In Progress (`in_progress`) / Blocked (`blocked`) / Done (`done`/`skipped`/`failed`). New `KanbanBoard` page in [cassidy/dashboard/src/App.tsx](cassidy/dashboard/src/App.tsx) renders 4 columns with priority pills (P1–P5), retry counters, and last-error badges. Auto-refreshes every 15 s. Easy-Auth-gated like every other dashboard route.
- **Trajectory scope (already covered)** — `captureSuccessfulTrajectory` in [cassidy/src/corpgen/experientialLearning.ts](cassidy/src/corpgen/experientialLearning.ts) has no per-tool filter; every successful task records its full action sequence regardless of which of the 8 toolset apps drove it. Verified — no code change needed.

### Live verification (2026-04-21)

- **Build + tests**: `npm run build` clean, `npm test` 513/45 green.
- **Health**: `https://cassidyopsagent-webapp.azurewebsites.net/api/health` returns `healthy` post-deploy.
- **Semaphore proved live**: `POST /api/corpgen/run {phase:'cycle', force:false}` at 05:20 UTC (≈ 15:20 AEST, in-hours) returned `200` with `stopReason:'skipped:in_flight'` because a prior workday job was still active. The semaphore eliminates the contended pile-up symptom from yesterday's `autonomy-sequential` battery.
- **Sydney scheduler windows**: All four phase windows now compute against Sydney local time. With the deployed time at 05:20 UTC = 15:20 AEST, the next scheduled fire is the 15:40 AEST `cycle`.

## [unreleased] — 2026-04-20

### Autonomous workday phases + in-process scheduler

- **`WorkdayPhase` type** — [cassidy/src/corpgenIntegration.ts](cassidy/src/corpgenIntegration.ts) now models the four CorpGen-style daily phases (`'init' | 'cycle' | 'reflect' | 'monthly'`) plus a `'manual'` escape hatch. Each phase has a preset (`phasePresets()`) sized for its job: `init` 1 cycle / 90 s wallclock / 30 tool calls, `cycle` 1 cycle / 90 s / 50, `reflect` 1 cycle / 120 s / 50, `monthly` 2 cycles / 240 s / 100. `'manual'` keeps the original 10/300 s/200 caller-supplied defaults.
- **Work-hours / weekday gating** — `checkWorkHours()` returns `{inHours, reason}` for the phase. Non-`manual` phases that fall outside Mon–Fri 07–18 UTC return a synthetic `DayRunResult` in 0 ms with a new `stopReason` of `'skipped:weekend'`, `'skipped:before_hours'`, or `'skipped:after_hours'` (extended in [cassidy/src/corpgen/types.ts](cassidy/src/corpgen/types.ts)). Manual runs always execute. The `force: true` request flag bypasses the gate for testing.
- **`POST /api/corpgen/run` extension** — Now accepts `{phase, force}` in the body in addition to existing run caps. `async: true` enqueues into the same `corpgenJobs` runner. The previously-duplicated `/api/corpgen/jobs[/:id]` routes were removed (the pair is now defined exactly once and mounts before `authorizeJWT`).
- **In-process scheduler** — New [cassidy/src/corpgenScheduler.ts](cassidy/src/corpgenScheduler.ts) starts a 60 s tick from `index.ts`. It fires:
  - **08:50 UTC weekdays** — `init` phase (Day Init: monthly + daily plan generation, identity load)
  - **Every 20 min, 09:00–16:40 UTC weekdays** — `cycle` phase (single ReAct cycle against the next runnable task)
  - **16:30 UTC weekdays** — `reflect` phase (Day End reflection + `judgeDay`)
  - **08:00 UTC on the 1st of each month** — `monthly` phase (regenerate monthly plan + 2 priming cycles)
  Disabled via `CORPGEN_SCHEDULER_ENABLED=false`. Started by `startCorpGenScheduler()` and stopped on SIGTERM/SIGINT in [cassidy/src/index.ts](cassidy/src/index.ts).
- **Function App stub (future)** — [cassidy/azure-function-trigger/src/corpgenTriggers.ts](cassidy/azure-function-trigger/src/corpgenTriggers.ts) holds Timer-trigger handlers (`corpgenInit`, `corpgenCycle`, `corpgenReflect`, `corpgenMonthly`) for if/when a separate Function App is provisioned to drive the same `/api/corpgen/run?phase=…&force=…` HTTP endpoints. Not built into the webapp deploy.
- **Test batteries** — Three new operator scripts under [skill-assets/](skill-assets/):
  - [autonomy-battery.ps1](skill-assets/autonomy-battery.ps1) — A1 unforced cycle (proves gating), A2–A5 forced init/cycle/reflect/monthly (async), A6 scheduler health
  - [autonomy-sequential.ps1](skill-assets/autonomy-sequential.ps1) — same four phases one-at-a-time
  - [corpgen-battery.ps1](skill-assets/corpgen-battery.ps1) — 6-job async load test
- **Live verification (2026-04-20)** —
  - **Autonomy gating proved**: A1 (unforced `cycle` at 20:42 UTC, after-hours) returned `200` with `stopReason='skipped:after_hours'` in 0 ms.
  - **Manual Teams interaction intact**: Smoke message sent to Cassidy in Teams at 22:03; reply at 22:04 correctly identified the current CorpGen phase ("Pre-open triage / morning-brief assembly, UTC 21:04 → AEDT 08:04 local"), confirmed work-hours gating ("Yes — quiet hours until 09:00 local; outbound nudges queued, internal prep only"), and named the top of today's plan. Adding the in-process scheduler did not regress the chat path.
  - **Known follow-ups (non-blocking)**: 1) workday concurrency semaphore (max 1 in-flight per `employeeId`); 2) mid-cycle wallclock check inside `runCycle` so phase presets actually preempt long cycles; 3) wire 5 cycle archetypes (inbox triage / meeting prep / commitment chase / doc hygiene / EOD digest) as a `kind` enum on `DailyTask`; 4) hook `experientialLearning` trajectory capture into the production Day-End path.

### MCP tooling fix — Work IQ tools now load on every turn

- **Root cause** — Every production turn since deploy showed `liveMcp:0, static:51, total:51` because the bot's discovery call hit `AADSTS82001: Agentic application '151d7bf7-…' is not permitted to request app-only tokens for resource 'ea9ffc3e-…'`. Agentic apps are barred by Entra from `client_credentials`-with-secret. The `@microsoft/agents-hosting` SDK's `MsalTokenProvider.getAgenticApplicationToken()` checks for `WIDAssertionFile` → `FICClientId` (managed-identity FIC) → cert files, then silently falls back to `clientSecret` — which the platform rejects.
- **Infrastructure fix (live)**:
  - Created **user-assigned MI** `cassidy-agentic-mi` (clientId `b264027d-ca88-4105-8947-559b58f021c6`, principalId `bdb0f4e9-8212-4f2e-ac3f-e0b7d2fd3131`). User-assigned is required because msal-node's `ManagedIdentityApplication` needs `userAssignedClientId` — the SDK does not consume the system-assigned MI.
  - Attached the MI to `cassidyopsagent-webapp`.
  - Replaced the federated identity credential on Cassidy Blueprint app reg `151d7bf7-772f-489b-b407-a8541f3eb7a6`: deleted `CassidyBlueprint-MSI` (system-assigned subject) and created `CassidyBlueprint-UAMSI` (subject = user-assigned MI principalId, audience `api://AzureADTokenExchange`).
  - Set env var `connections__service_connection__settings__FICClientId=b264027d-…` so the SDK takes the FIC path instead of the broken secret path.
- **Code fix** — [cassidy/src/tools/mcpToolSetup.ts](cassidy/src/tools/mcpToolSetup.ts) (commit `6c1c395`):
  - OBO discovery errors now surface their real `name`, `message`, and short stack instead of being masked by a redundant 82001 from the fallback.
  - Empty tool cache is no longer persisted, so the next turn retries cleanly after a transient failure.
  - The client-credentials path is retained only as a best-effort for autonomous (no-context) runs; the expected 82001 noise is suppressed with a single explanatory log line.
- **Operator runbook** — Any future agentic bot on App Service must follow the same pattern: user-assigned MI + FIC on the bot app reg + `FICClientId` env var. Do **not** rely on system-assigned MI or `MicrosoftAppPassword` for the agentic token bootstrap.

### Mission Control dashboard (Entra SSO)

- **React SPA** — New [cassidy/dashboard/](cassidy/dashboard/) (React 19 + Vite 6 + TanStack Query) served by the webapp at `/dashboard/`. Pages: Live Operations (uptime, circuit breakers, features, caches), CorpGen Runs (job table), Organisation (registered specialist agents). Right-side blade live-tails the activity ring buffer (5 s polling).
- **Easy Auth v2** — App Service authsettingsV2 enabled in passive mode (`requireAuthentication=false`, `unauthenticatedClientAction=AllowAnonymous`) against new Entra app `cassidy-dashboard` (appId `21fe97b1-b59e-40b5-af6d-09b19ce24cf0`, audience `AzureADMyOrg`, redirect `…/.auth/login/aad/callback`). Bot's `/api/messages` JWT auth is untouched.
- **Backend gate** — New [cassidy/src/easyAuth.ts](cassidy/src/easyAuth.ts) decodes the `X-MS-CLIENT-PRINCIPAL` header App Service injects after Entra SSO, attaches a typed principal, and 401s with `{ loginUrl }` otherwise. When `MicrosoftAppTenantId` is set it also enforces a tenant allowlist (currently `e4ccbd32-1a13-4cb6-8fda-c392e7ea359f` / `ABSx02771022`).
- **Dashboard API** — Four new routes registered before the JWT middleware in [cassidy/src/index.ts](cassidy/src/index.ts), all gated by `requireEasyAuth`:
  - `GET /api/dashboard/me` — current principal
  - `GET /api/dashboard/snapshot` — uptime, features, circuits, caches, rate limiter, webhooks, registered agents
  - `GET /api/dashboard/activity?limit=&level=&module=` — recent log entries
  - `GET /api/dashboard/jobs` and `/jobs/:id` — CorpGen async job list/detail (Easy-Auth-gated mirror of the secret-protected operator endpoints)
- **Activity ring buffer** — [cassidy/src/logger.ts](cassidy/src/logger.ts) now retains the last 500 log entries in-memory and exposes `getRecentActivity({ limit, level, module })`. Every `logger.{debug,info,warn,error}` call is automatically captured.
- **Static serving** — Express `express.static('dashboard/dist', …)` mounted at `/dashboard` with SPA fallback to `index.html` so client-side routes survive page refresh.
- **Build pipeline** — [skill-assets/stage-deploy.ps1](skill-assets/stage-deploy.ps1) now `npm install`s and `npm run build`s `cassidy/dashboard/` before zipping, and includes `dashboard/dist/` in the deploy. `node_modules` is excluded by the existing `/XD node_modules` rule.
- **Live verification** — `https://cassidyopsagent-webapp.azurewebsites.net/dashboard/` returns 200 HTML; `/api/dashboard/snapshot` returns 401+`loginUrl` when unauthenticated; `/.auth/login/aad` 302s to `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` for the dashboard app.

### CorpGen wiring, async jobs, deploy hardening

- **CorpGen ↔ Cassidy bridge** — New [cassidy/src/corpgenIntegration.ts](cassidy/src/corpgenIntegration.ts) exposes `buildCassidyExecutor`, `runWorkdayForCassidy`, `runMultiDayForCassidy`, `runOrganizationForCassidy`, plus `summariseDayForTeams` / `summariseMultiDay` / `summariseOrganization`. Defaults: `maxCycles=10`, `maxWallclockMs=5 min`, `maxToolCalls=200`, `ignoreSchedule=true`, `withCommFallback=true`. Live MCP tool definitions (delegated/OBO from a Teams turn) are merged with static tools and deduped by name.
- **LLM tool `cg_run_workday`** — Added to `CORPGEN_TOOL_DEFINITIONS` in [cassidy/src/tools/index.ts](cassidy/src/tools/index.ts) and registered in `getAllTools()`. Optional params: `maxCycles`, `maxWallclockMs`, `maxToolCalls`, `employeeId`. The dispatcher uses a dynamic import of the bridge to break a circular dependency.
- **Operator HTTP harness** — Four new routes in [cassidy/src/index.ts](cassidy/src/index.ts), all secret-protected via `verifySecret(SCHEDULED_SECRET)` (header `x-scheduled-secret`, 22-char secret) and registered **before** the JWT middleware:
  - `POST /api/corpgen/run` — single workday (sync)
  - `POST /api/corpgen/multi-day` — N consecutive days (sync; `async:true` → 202 + `jobId`)
  - `POST /api/corpgen/organization` — multi-employee × multi-day (sync or async)
  - `GET /api/corpgen/jobs` and `GET /api/corpgen/jobs/:id` — list / poll async jobs
- **Async job runner** — New [cassidy/src/corpgenJobs.ts](cassidy/src/corpgenJobs.ts): in-memory `Map`-backed runner with 1 h TTL, 200-job cap, GC, and a `summariseJob` view used by the HTTP status endpoints. Required because App Service Linux frontends cap HTTP responses at ~230 s.
- **Table Storage tolerance** — Hardened [cassidy/src/memory/tableStorage.ts](cassidy/src/memory/tableStorage.ts) to treat `TableNotFound` identically to `ResourceNotFound`/`404` in `upsertEntity`, `getEntity`, `listEntities`, and `deleteEntity`. When the runtime managed identity lacks Table-create permission, `ensureTable()` swallows the auth failure and downstream CRUD now degrades to `null`/`[]`/no-op rather than crashing CorpGen identity loads.
- **Storage RBAC** — Granted `Storage Table Data Contributor` on `cassidyschedsa` to the webapp's system-assigned managed identity (principalId `b67995a8-a408-413e-973e-0e23d227ba50`); existing assignment verified.
- **Deploy script fix** — [skill-assets/stage-deploy.ps1](skill-assets/stage-deploy.ps1) now runs `npm run build` locally and **includes `cassidy/dist/`** in the deploy zip. `az webapp deploy --type zip` uses OneDeploy, which does not run Oryx build (deploy logs show `Build completed succesfully. Time: 0(s)`). Without this fix the running container kept stale `dist/` from previous deploys and new HTTP routes silently 401'd via the JWT middleware.
- **Smoke scripts** — Added under [skill-assets/](skill-assets/):
  - [smoke-corpgen-multi-day.ps1](skill-assets/smoke-corpgen-multi-day.ps1) — sync multi-day
  - [smoke-corpgen-organization.ps1](skill-assets/smoke-corpgen-organization.ps1) — sync 3-employee org
  - [smoke-corpgen-async.ps1](skill-assets/smoke-corpgen-async.ps1) — async enqueue + poll for either kind
  - [smoke-corpgen-http.ps1](skill-assets/smoke-corpgen-http.ps1) (existing) — single workday
  All resolve `SCHEDULED_SECRET` automatically via `az webapp config appsettings list`.
- **New tests** — [cassidy/src/corpgenIntegration.test.ts](cassidy/src/corpgenIntegration.test.ts) (6) and [cassidy/src/corpgenJobs.test.ts](cassidy/src/corpgenJobs.test.ts) (6). **Test count: 507 → 513 across 44 → 45 suites — all green.**
- **New docs** — [docs/CORPGEN.md](docs/CORPGEN.md) deep-dive, [docs/README.md](docs/README.md) docs index, [TESTING_CORPGEN_LIVE.md](TESTING_CORPGEN_LIVE.md) operator handoff. README and TESTING_CORPGEN refreshed.
- **Live verification (2026-04-20)** — `/api/health` 200, version `1.7.0`. Background loops live: ProactiveEngine (300 s), AutonomousLoop (120 s), webhook auto-renewal, MI token pre-warm. Registered digital employees in production: Cassidy (Operations Manager), Morgan (Finance Agent), HR Agent. Single workday → 200 with valid `DayRunResult`; multi-day async → succeeded after 596 s; organisation sync → 3 members ran concurrently.

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
