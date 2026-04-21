# CorpGen in Cassidy — Deep Dive

Cassidy is both a Microsoft Agent Framework bot (Teams-facing, OBO-authenticated, MCP-powered) and an autonomous **digital employee** that implements [**CORPGEN: Simulating Corporate Environments with Autonomous Digital Employees in Multi-Horizon Task Environments**](https://arxiv.org/abs/2602.14229) (Jaye, Kumankumah, Biringa, Patel, Vesal, Julienne, Siska, Meléndez et al., Microsoft Research, arXiv:2602.14229, 15 Feb 2026). The CorpGen runtime lives at [cassidy/src/corpgen/](../cassidy/src/corpgen/) and is exposed to the rest of Cassidy via two coordinated surfaces: an LLM tool the bot can call from a Teams turn, and an operator-only HTTP harness for benchmark sweeps. This document explains how those pieces fit together, where Cassidy is faithful to the paper, and where it deliberately diverges.

## Paper concept → Cassidy module mapping

| CorpGen concept (paper) | Cassidy module / file |
|---|---|
| Persistent identity + ±10 min schedule jitter (§3.4.4) | [cassidy/src/corpgen/identity.ts](../cassidy/src/corpgen/identity.ts) |
| Hierarchical planning — Strategic / Tactical / Operational (§3.4.1) | [cassidy/src/corpgen/hierarchicalPlanner.ts](../cassidy/src/corpgen/hierarchicalPlanner.ts) |
| Tiered memory — Working / Structured LTM / Semantic (§3.4.3) | [cassidy/src/corpgen/tieredMemory.ts](../cassidy/src/corpgen/tieredMemory.ts) |
| Adaptive summarisation, 4 k-token threshold (§3.4.4) | [cassidy/src/corpgen/adaptiveSummarizer.ts](../cassidy/src/corpgen/adaptiveSummarizer.ts) |
| Cognitive tools — `cg_generate_plan`, `cg_update_plan`, `cg_track_task`, `cg_list_open_tasks`, `cg_reflect` (§3.5) | [cassidy/src/corpgen/cognitiveTools.ts](../cassidy/src/corpgen/cognitiveTools.ts) |
| Sub-agents as tools — research + computer-use, isolated context (§3.4.2) | [cassidy/src/corpgen/subAgents.ts](../cassidy/src/corpgen/subAgents.ts) |
| Experiential learning — capture + top-K retrieval of trajectories (§3.6) | [cassidy/src/corpgen/experientialLearning.ts](../cassidy/src/corpgen/experientialLearning.ts) |
| Algorithm 1 — Day Init → Cycles → Day End | [cassidy/src/corpgen/digitalEmployee.ts](../cassidy/src/corpgen/digitalEmployee.ts) |
| Comm-channel fallback (Mail ↔ Teams) | [cassidy/src/corpgen/commFallback.ts](../cassidy/src/corpgen/commFallback.ts) |
| Upward propagation / escalation | [cassidy/src/corpgen/hierarchicalPlanner.ts](../cassidy/src/corpgen/hierarchicalPlanner.ts) (`propagateTaskChange`) |
| Artifact judge — task + day-level (LLM-as-judge) | [cassidy/src/corpgen/artifactJudge.ts](../cassidy/src/corpgen/artifactJudge.ts) |
| Multi-day continuity (§3.7) | `runMultiDay` in [cassidy/src/corpgen/digitalEmployee.ts](../cassidy/src/corpgen/digitalEmployee.ts) |
| Organisation-scale runs (§3.7) | `runOrganization` in [cassidy/src/corpgen/digitalEmployee.ts](../cassidy/src/corpgen/digitalEmployee.ts) |
| Cassidy ↔ CorpGen bridge | [cassidy/src/corpgenIntegration.ts](../cassidy/src/corpgenIntegration.ts) |
| Async job runner (App Service ~230 s cap) | [cassidy/src/corpgenJobs.ts](../cassidy/src/corpgenJobs.ts) |
| Autonomous workday phases + work-hours gating | [cassidy/src/corpgenIntegration.ts](../cassidy/src/corpgenIntegration.ts) (`WorkdayPhase`, `phasePresets`, `checkWorkHours`) |
| In-process daily scheduler (init / cycle / reflect / monthly) | [cassidy/src/corpgenScheduler.ts](../cassidy/src/corpgenScheduler.ts) |

## End-to-end workday lifecycle

A single workday is driven by `runWorkday` in [cassidy/src/corpgen/digitalEmployee.ts](../cassidy/src/corpgen/digitalEmployee.ts). It implements Algorithm 1 from the paper.

1. **Day Init**
   - Load (or persist) the digital employee's identity from the `CorpGenIdentities` table; apply ±10 min jitter to the `[t_start, t_end]` schedule.
   - Ensure a monthly plan exists (objectives + milestones); if not, generate one.
   - Ensure today's daily plan exists (6–12 DAG-ordered tasks); if not, derive it from the monthly plan.
   - Inject the identity (`identitySystemBlock`) as a stable system prompt prefix.

2. **Execution Cycles** (loop until `t_end`, or any safety cap fires)
   - **Planner** — `selectNextTask` picks the next runnable task, honouring DAG dependencies and priority.
   - **Retrieval** — `retrieveForCycle` pulls structured + semantic + experiential context for the cycle.
   - **ReAct loop** — up to 30 iterations per attempt, up to 3 attempts per task, then skip.
   - **Adaptive summarisation** — `compressIfNeeded` triggers above the 4 k-token threshold, retaining critical turns.
   - **Persistence** — `task_state_change`, `plan_update`, and failure records are written to `CorpGenStructuredMemory`.
   - **Experiential capture** — successful trajectories are saved (`captureSuccessfulTrajectory`) and re-rankable via cosine similarity for future runs.
   - **Upward propagation** — `propagateTaskChange` bumps dependent priorities, advances milestones at ≥ 50 % completion, and marks objectives done when all milestones complete.
   - Sleep until the minimum cycle interval (5 min default) has elapsed.

3. **Day End**
   - Generate an end-of-day reflection (LLM call) over the day's outcomes.
   - Consolidate lessons into structured long-term memory.
   - **Judge** — `judgeDay` and per-task `judgeTask` (LLM-as-judge) score artifacts produced during the day, with confidence and rationale.

The result is a `DayRunResult` containing `cyclesRun`, `tasksCompleted/Skipped/Failed`, `completionRate`, `toolCallsUsed`, `stopReason`, and `reflection`.

## Multi-day & organisation runs

Two higher-order runners compose `runWorkday`:

- **`runMultiDay`** — N consecutive workdays for one identity. The identity row in `CorpGenIdentities` is unchanged; `CorpGenStructuredMemory` accumulates rows across days, so day N+1 inherits the prior reflections, plan state, and trajectories. Optional `dayStepMs` lets benchmarks advance a synthetic clock.
- **`runOrganization`** — multi-employee × multi-day. Each member runs under its own `employeeId` (its own partition key in storage), so there is no shared in-process state. The only coordination channel is the same as the paper's: asynchronous Mail / Teams MCP messages between agents. `concurrent: true` runs all members in parallel via `Promise.all`; `false` serialises them.

The bridge layer adds two further conveniences for Cassidy:

- `defaultCassidyIdentity()` produces a stable Operations-Manager identity for the canonical Cassidy bot.
- `summariseDayForTeams`, `summariseMultiDay`, and `summariseOrganization` in [cassidy/src/corpgenIntegration.ts](../cassidy/src/corpgenIntegration.ts) format results as compact markdown for Teams or operator HTTP responses.

## Safety rails

Every CorpGen surface in Cassidy applies three caps and one fallback:

| Rail | Default (interactive) | Where set |
|---|---|---|
| `maxCycles` | 10 | [cassidy/src/corpgenIntegration.ts](../cassidy/src/corpgenIntegration.ts) `DEFAULT_INTERACTIVE` |
| `maxWallclockMs` | 5 minutes | same |
| `maxToolCalls` | 200 | same |
| Comm-channel fallback (Mail ↔ Teams) | enabled | `withCommFallback` wraps every executor |

When any cap fires the runner stops cleanly with `stopReason ∈ { plan_complete, schedule_end, cycle_cap, wallclock_cap, tool_call_cap }` and still emits a reflection.

In addition:

- **Table Storage tolerance** — [cassidy/src/memory/tableStorage.ts](../cassidy/src/memory/tableStorage.ts) treats `TableNotFound` identically to `ResourceNotFound`/`404` in `upsertEntity`, `getEntity`, `listEntities`, and `deleteEntity`. When the runtime managed identity lacks Table-create permission, `ensureTable()` swallows the auth failure and downstream CRUD degrades to `null`/`[]`/no-op rather than crashing CorpGen identity loads. Any new persistence code should go through these helpers (do not call `TableClient` directly).
- **Tool-array cap** — Azure OpenAI enforces a 128-tool ceiling per request; the bridge dedupes by name (live MCP wins over static) and the agent caps the merged array.

## HTTP and LLM-tool surfaces

CorpGen reaches the outside world through two coordinated entry points, both served by the same bridge in [cassidy/src/corpgenIntegration.ts](../cassidy/src/corpgenIntegration.ts).

### LLM tool — `cg_run_workday`

Defined in `CORPGEN_TOOL_DEFINITIONS` in [cassidy/src/tools/index.ts](../cassidy/src/tools/index.ts) and registered in `getAllTools()`. The dispatcher case uses a dynamic import of the bridge to break the circular dependency. Optional parameters: `maxCycles`, `maxWallclockMs`, `maxToolCalls`, `employeeId`. When the bot calls it from a Teams turn, the live `TurnContext` is forwarded, so the executor includes OBO-enriched MCP tools in addition to Cassidy's static tools.

### Operator HTTP routes

All four CorpGen routes are operator-only. They are registered **before** `server.use(authorizeJWT(authConfig))` in [cassidy/src/index.ts](../cassidy/src/index.ts) and protected with `verifySecret(SCHEDULED_SECRET)` (22-char secret) using header `x-scheduled-secret`. Long-running routes can be enqueued asynchronously (`async: true`) returning `202` + `jobId`.

| Route | Method | Body / params | Sync | Async |
|---|---|---|---|---|
| `/api/corpgen/run` | `POST` | `phase` (`init`/`cycle`/`reflect`/`monthly`/`manual`), `force`, `maxCycles`, `maxWallclockMs`, `maxToolCalls`, `employeeId`, `async` | yes | yes |
| `/api/corpgen/multi-day` | `POST` | `days` (1–30), plus run caps, plus `async: true` | yes | yes |
| `/api/corpgen/organization` | `POST` | `members[]` (1–10), `days` (1–30), `concurrent`, plus `async: true` | yes | yes |
| `/api/corpgen/jobs` | `GET` | — | n/a | lists recent jobs |
| `/api/corpgen/jobs/:id` | `GET` | — | n/a | polls one job |

Async jobs are managed by [cassidy/src/corpgenJobs.ts](../cassidy/src/corpgenJobs.ts) — an in-memory `Map`-backed runner with 1 h TTL, a 200-job cap, GC, and a `summariseJob` view used by both list and detail endpoints. Async mode exists because App Service Linux frontends cap HTTP responses at ~230 s; longer benchmark sweeps must run in the background and be polled.

```powershell
# Single workday (sync)
$ss = (az webapp config appsettings list -g rg-cassidy-ops-agent `
  -n cassidyopsagent-webapp `
  --query "[?name=='SCHEDULED_SECRET'].value" -o tsv)
$body = @{ maxCycles = 3; maxWallclockMs = 600000; maxToolCalls = 200 } | ConvertTo-Json
Invoke-RestMethod -Method POST `
  -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run' `
  -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body $body
```

```powershell
# Multi-day (async) → enqueue then poll
$body = @{ async = $true; days = 5; maxCycles = 2; maxToolCalls = 30 } | ConvertTo-Json
$enq = Invoke-RestMethod -Method POST `
  -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/multi-day' `
  -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body $body
Invoke-RestMethod `
  -Uri "https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/jobs/$($enq.jobId)" `
  -Headers @{ 'x-scheduled-secret' = $ss }
```

## Autonomous scheduling

Cassidy runs its CorpGen workday **unattended** via the in-process scheduler in [cassidy/src/corpgenScheduler.ts](../cassidy/src/corpgenScheduler.ts). A 60 s tick from `index.ts` checks the wall clock (Australia/Sydney, default — overridable via `CORPGEN_WORK_TZ`) against four phase windows and fires `POST /api/corpgen/run` (in-process, not HTTP) with the matching `phase`:

| Phase | Window (Sydney local, weekdays) | Preset (cycles / wallclock / tool calls) | CorpGen analogue |
|---|---|---|---|
| `init` | 08:50 | 1 / 90 s / 30 | Day Init (Algorithm 1, lines 1–6) |
| `cycle` | every 20 min, 09:00 → 17:00 | 1 / 120 s / 40 | Single execution cycle |
| `reflect` | 17:20 | 1 / 90 s / 30 | Day End reflection + `judgeDay` |
| `monthly` | 1st of month, 08:00 | 1 / 60 s / 20 | Regenerate monthly plan |

Toggle with `CORPGEN_SCHEDULER_ENABLED=false`. Started by `startCorpGenScheduler()` and stopped on `SIGTERM`/`SIGINT`.

### Concurrency semaphore

`runWorkdayForCassidy` holds a per-employee `_inflight` map. A second invocation for the same `employeeId` while one is already running returns a synthetic `DayRunResult` in 0 ms with `stopReason: 'skipped:in_flight'`. This prevents the LLM/MCP lane from piling up when phases overlap or when a manual run lands during a scheduled cycle.

### Manager briefing

After `init`, `reflect`, and `monthly` phases (cycles stay quiet), the bridge calls `briefManager(phase, result)` which:

1. Resolves the manager via env (`CORPGEN_MANAGER_USER_ID` → `CORPGEN_MANAGER_EMAIL` → display-name match `MOD Administrator`, overridable via `CORPGEN_MANAGER_NAME`).
2. Sends a Teams DM via `sendDirectMessage(userId, text)` exported from [cassidy/src/proactive/proactiveEngine.ts](../cassidy/src/proactive/proactiveEngine.ts) (uses the cloud adapter's `continueConversation` with the stored `ConversationReference`).
3. Best-effort email via the `sendEmail` MailTools MCP — succeeds when the brief is triggered from a Teams turn (OBO available); the scheduler-driven path logs a warn and skips when no `TurnContext` is present.

### Work-hours / weekday gating

`runWorkdayForCassidy(turn?, opts)` wraps every non-`manual` phase in `checkWorkHours()`. The check uses `Intl.DateTimeFormat` against the configured timezone and treats Mon–Fri 09:00–17:30 Sydney local as in-hours. Outside that window, non-manual phases return a synthetic `DayRunResult` in 0 ms with one of these `stopReason` values:

- `'skipped:weekend'`
- `'skipped:before_hours'`
- `'skipped:after_hours'`
- `'skipped:in_flight'` (per-employee semaphore — see above)

Manual runs (`phase: 'manual'` or no phase) ignore the gate. To override the gate for a forced phase test, send `force: true` in the body of `/api/corpgen/run`.

```powershell
# Force a reflect phase right now, ignoring work-hours gate
$ss = (az webapp config appsettings list -g rg-cassidy-ops-agent `
  -n cassidyopsagent-webapp `
  --query "[?name=='SCHEDULED_SECRET'].value" -o tsv)
$body = @{ phase = 'reflect'; force = $true; async = $true } | ConvertTo-Json
Invoke-RestMethod -Method POST `
  -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run' `
  -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body $body
```

### Function App alternative (future)

[cassidy/azure-function-trigger/src/corpgenTriggers.ts](../cassidy/azure-function-trigger/src/corpgenTriggers.ts) holds Timer-trigger handlers (`corpgenInit`, `corpgenCycle`, `corpgenReflect`, `corpgenMonthly`) ready to drive the same `/api/corpgen/run?phase=…&force=…` HTTP endpoints from a separate Function App if/when the Azure Function trigger surface is provisioned. Today the in-process scheduler is the production path.

### Autonomy verification

Three operator scripts under [skill-assets/](../skill-assets/) exercise the scheduling surface end-to-end:

| Script | What it does |
|---|---|
| [autonomy-battery.ps1](../skill-assets/autonomy-battery.ps1) | A1 unforced `cycle` (proves gating returns `skipped:*` in 0 s after-hours), A2–A5 forced `init`/`cycle`/`reflect`/`monthly` (async), A6 `/jobs` health |
| [autonomy-sequential.ps1](../skill-assets/autonomy-sequential.ps1) | Same four phases one at a time (avoids LLM/MCP lane contention) |
| [corpgen-battery.ps1](../skill-assets/corpgen-battery.ps1) | 6-job async load test against `/api/corpgen/run` |

## Faithful to the paper vs. extensions

| Area | Status | Notes |
|---|---|---|
| Algorithm 1 (Day Init / Cycles / Day End) | Faithful | Implemented in [cassidy/src/corpgen/digitalEmployee.ts](../cassidy/src/corpgen/digitalEmployee.ts). |
| Hierarchical planner | Faithful | Strategic → Tactical → Operational with DAG-aware selection and propagation. |
| Tiered memory | Faithful | Working / Structured LTM / Semantic, with cycle-start retrieval. |
| Adaptive summarisation | Faithful | 4 k-token threshold; critical-turn retention. |
| Cognitive tools (§3.5) | Faithful | All five tools shipped. |
| Sub-agents as tools (§3.4.2) | Faithful (extended) | Default CUA returns a structured intent plan only — Cassidy's MCP servers already cover Office actions. A real CUA backend (UFO2, OpenAI computer-use-preview, etc.) can be plugged via `registerCuaProvider`. |
| Experiential learning (§3.6) | Faithful | Cosine on Azure OpenAI embeddings, Jaccard fallback when embeddings unavailable. |
| Identity + jitter | Faithful | ±10 min jitter, 5-min minimum cycle interval. |
| Retry-and-skip (3 × 30) | Faithful | Plus skip-to-keep-the-day-moving semantics. |
| Emergent collaboration (§3.7) | Operationally aligned | Cassidy collaborates via the same async Mail + Teams MCP servers, no shared in-process state. |
| Multi-day / organisation runs | Operationally aligned | `runMultiDay` and `runOrganization` are plumbed end-to-end and exercised by smoke scripts; the **paper-equivalent benchmark sweeps still need empirical runs at scale** to publish completion-rate trends. |
| LLM-as-judge (`judgeTask` / `judgeDay`) | Extension | Adds artifact-level and day-level grading on top of the paper's framework. |
| Comm-channel fallback (Mail ↔ Teams) | Extension | Practical safety net for the M365 surface; not in the paper. |
| Operator HTTP harness + async jobs | Extension | Required by App Service's ~230 s response cap and operator workflows. |
| Autonomous in-process scheduler + work-hours gating | Extension | Drives `init`/`cycle`/`reflect`/`monthly` phases on a UTC clock so the digital employee runs unattended. Gating returns synthetic `skipped:*` `DayRunResult`s outside Mon–Fri 07–18 UTC. |

In short: Cassidy is **algorithmically faithful** to the paper today; the **operational benchmark sweeps** are now possible (the surfaces and async runner exist) but the headline completion-rate numbers from the paper still need empirical replication.

## Operator runbook

### Local validation

From `cassidy/`:

```pwsh
npm ci
npm run build      # tsc, must finish with no diagnostics
npm run lint       # eslint --max-warnings 0
npm test           # vitest run — 513 tests across 45 suites
```

The corpgen module suites (`src/corpgen/*.test.ts`) plus the new wiring tests
([cassidy/src/corpgenIntegration.test.ts](../cassidy/src/corpgenIntegration.test.ts) and [cassidy/src/corpgenJobs.test.ts](../cassidy/src/corpgenJobs.test.ts)) must all pass.

### Live smoke scripts

All four scripts auto-resolve `SCHEDULED_SECRET` via `az webapp config appsettings list`.

| Scenario | Script |
|---|---|
| Single workday (sync) | [skill-assets/smoke-corpgen-http.ps1](../skill-assets/smoke-corpgen-http.ps1) |
| Multi-day, sync | [skill-assets/smoke-corpgen-multi-day.ps1](../skill-assets/smoke-corpgen-multi-day.ps1) |
| Organisation (3 employees, sync) | [skill-assets/smoke-corpgen-organization.ps1](../skill-assets/smoke-corpgen-organization.ps1) |
| Async enqueue + poll (multi-day or org) | [skill-assets/smoke-corpgen-async.ps1](../skill-assets/smoke-corpgen-async.ps1) |

For the live deploy handoff procedure see [TESTING_CORPGEN_LIVE.md](../TESTING_CORPGEN_LIVE.md). For the full local + post-deploy regression matrix see [TESTING_CORPGEN.md](../TESTING_CORPGEN.md).

### Teams test

In any Cassidy chat: *"Cassidy, run an autonomous workday."* The bot should call `cg_run_workday` and reply with the markdown summary produced by `summariseDayForTeams`. If the bot replies with prose only, increase intent strength: *"Run the cg_run_workday tool now with maxCycles=2."*

### Known operational caveats

- **MCP tools require delegated/OBO tokens** — operator HTTP calls run app-only and will surface `AADSTS82001` from the MCP gateway. MCP tools light up only inside Teams turns where a `TurnContext` is available. The smoke scripts therefore exercise the runner with whatever non-MCP tools are reachable; the algorithmic loop is unaffected.
- **Async jobs are in-memory only** — they are lost on process restart (App Service slot swap, scale event, or deploy). For durable benchmark runs, persist results out-of-band.
- **App Service ~230 s response cap** — long sweeps must use `async: true`. Do not increase the synchronous timeout.
- **Storage permissions** — the runtime managed identity needs `Storage Table Data Contributor` on the storage account that backs the `CorpGen*` tables (`cassidyschedsa` in the live deployment). If Table-create is denied, persistence degrades silently per the tolerance fix above.
