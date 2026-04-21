# Cassidy — Enterprise Operations Manager

![Tests](https://img.shields.io/badge/tests-513%20passed-brightgreen)
![Suites](https://img.shields.io/badge/suites-45-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Platform](https://img.shields.io/badge/platform-Microsoft%20Teams-6264A7)
![AI](https://img.shields.io/badge/model-GPT--5-orange)
![MCP Tools](https://img.shields.io/badge/MCP%20tools-72%20live-green)
![Version](https://img.shields.io/badge/version-1.7.0-blue)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF)
![Observability](https://img.shields.io/badge/telemetry-App%20Insights-68217A)
![CorpGen](https://img.shields.io/badge/CorpGen-digital%20employee-purple)

Cassidy is two things in one process:

1. **A Microsoft Agent Framework Teams bot** — enterprise task coordination, project tracking, approvals, and team workflows, built on the Agent 365 SDK with live MCP (Model Context Protocol) integration for Calendar, Mail, Planner, and Teams via the Work IQ platform.
2. **An autonomous CorpGen-style digital employee** — a faithful implementation of [**CORPGEN: Simulating Corporate Environments with Autonomous Digital Employees in Multi-Horizon Task Environments**](https://arxiv.org/abs/2602.14229) (Jaye et al., Microsoft Research, arXiv:2602.14229, Feb 2026) layered on top of the bot. The runtime in [cassidy/src/corpgen/](cassidy/src/corpgen/) drives a hierarchical-planner / ReAct / adaptive-summariser / experiential-learning workday loop, with multi-day and multi-employee organisation runs.

The two surfaces share one tool catalogue: the bot can call CorpGen as an LLM tool (`cg_run_workday`) inside a Teams turn, and operators can invoke the same runner over the secret-protected `/api/corpgen/*` HTTP routes. See [docs/CORPGEN.md](docs/CORPGEN.md) for the deep dive and [docs/README.md](docs/README.md) for the docs index.

## Overview

Cassidy is an AI-powered operations manager that autonomously handles:
- **Task Coordination** — Breaking down complex goals into actionable work items
- **Project Tracking** — Monitoring progress, deadlines, and dependencies
- **Approval Workflows** — Routing decisions to appropriate stakeholders
- **Team Communications** — Proactive notifications via Teams and email
- **Meeting Intelligence** — Transcription analysis and action item extraction
- **Report Generation** — Automated insights and performance summaries
- **Voice & Call Management** — Integration with call systems and voice processing
- **Calendar & Scheduling** — Live calendar scanning, event monitoring, and deadline management via MCP CalendarTools
- **Autonomous workdays (CorpGen)** — Self-directed digital employee that plans, executes, reflects, and learns across days and across an organisation of agents. Driven unattended by an in-process scheduler that fires `init` / `cycle` / `reflect` / `monthly` phases on a UTC clock with Mon–Fri 07–18 work-hours gating.

## Architecture

### Core Components

```
cassidy/
├── src/                          # Main agent source code
│   ├── agent.ts                  # Agent initialization, GPT-5 orchestration & tool dispatch
│   ├── auth.ts                   # Authentication & token management
│   ├── persona.ts                # Agent personality & system prompts
│   ├── autonomous/               # Autonomous loop & decision-making
│   ├── intelligence/             # AI reasoning (org graph, predictive engine, profiling)
│   ├── meetings/                 # Meeting context & transcription analysis
│   ├── memory/                   # Long-term & conversation memory (Table Storage)
│   ├── orchestrator/             # Task routing & agent registry
│   ├── proactive/                # Event triggers & proactive workflows
│   ├── reports/                  # Report generation & distribution
│   ├── scheduler/                # Scheduled notifications & reminders
│   ├── tools/                    # MCP tool setup, OBO auth & handlers (incl. cg_run_workday)
│   ├── voice/                    # Call management & speech processing
│   ├── workQueue/                # Work decomposition & queue management
│   ├── corpgen/                  # CorpGen digital-employee runtime (paper-faithful)
│   ├── corpgenIntegration.ts     # Bridge: Cassidy tools ↔ CorpGen ToolExecutor
│   ├── corpgenScheduler.ts       # In-process daily scheduler (init/cycle/reflect/monthly UTC)
│   └── corpgenJobs.ts            # In-memory async job runner for long sweeps
├── ToolingManifest.json          # MCP server declarations (Calendar, Mail, Planner, Teams)
├── publish/                      # Azure App Service deployment package
├── azure-function-trigger/       # Logic App trigger for scheduled tasks
└── manifest/                     # Agent manifest & Teams integration
```

### System Architecture

```mermaid
flowchart TB
    subgraph Teams["Microsoft Teams"]
        User([👤 User])
        Channel([📢 Channel])
    end

    subgraph Agent["Cassidy Agent Core"]
        direction TB
        AgentTS["agent.ts\nGPT-5 Orchestration\n10-iteration agentic loop"]
        Persona["persona.ts\nSystem Prompt"]
    end

    subgraph MCP["MCP Servers — 72 live tools"]
        direction LR
        Cal["📅 Calendar\n13 tools"]
        Mail["📧 Mail\n22 tools"]
        Plan["📋 Planner\n10 tools"]
        TeamsS["💬 Teams\n27 tools"]
    end

    subgraph Intelligence["Intelligence Layer"]
        direction LR
        Predict["Predictive\nEngine"]
        OrgGraph["Org\nGraph"]
        Profiler["User\nProfiler"]
    end

    subgraph Autonomous["Autonomous Execution"]
        direction LR
        Loop["Autonomous\nLoop"]
        Queue["Work\nQueue"]
        Decomp["Goal\nDecomposer"]
    end

    subgraph Memory["Persistence — Azure Table Storage"]
        direction LR
        Conv["Conversation\nMemory"]
        LTM["Long-term\nMemory"]
        Registry["User\nRegistry"]
    end

    subgraph Orchestrator["Multi-Agent Orchestration"]
        direction LR
        AgentReg["Agent\nRegistry"]
        Router["Task\nRouter"]
    end

    subgraph Proactive["Proactive Engine"]
        direction LR
        Triggers["Event\nTriggers"]
        Notifier["Proactive\nNotifier"]
    end

    subgraph Output["Output Channels"]
        direction LR
        Reports["📊 Reports"]
        Voice["🔊 Voice"]
        Meetings["🎤 Meetings"]
    end

    User -->|message| AgentTS
    Channel -->|mention| AgentTS
    AgentTS -->|OBO token exchange| MCP
    MCP -->|tool results| AgentTS
    AgentTS --> Intelligence
    AgentTS --> Autonomous
    AgentTS --> Memory
    Memory --> AgentTS
    AgentTS --> Orchestrator
    Loop --> Queue
    Queue --> Decomp
    Proactive -->|notifications| User
    Intelligence --> Proactive
    AgentTS --> Output
    Notifier -->|Teams + email| User

    style Agent fill:#1a1a2e,color:#fff
    style MCP fill:#16213e,color:#fff
    style Intelligence fill:#0f3460,color:#fff
    style Autonomous fill:#533483,color:#fff
    style Memory fill:#2c3e50,color:#fff
    style Orchestrator fill:#1e3799,color:#fff
    style Proactive fill:#e55039,color:#fff
    style Output fill:#2c3e50,color:#fff
    style Teams fill:#6264A7,color:#fff
```

### Key Subsystems

| Subsystem | Purpose | Key Files |
|-----------|---------|-----------|
| **Autonomous Loop** | Self-directed task execution and decision-making | `autonomous/autonomousLoop.ts` |
| **Meeting Intelligence** | Transcription analysis, name detection, context extraction | `meetings/meetingContext.ts`, `nameDetection.ts` |
| **Memory System** | Long-term user/org knowledge, conversation history | `memory/longTermMemory.ts`, `tableStorage.ts` |
| **Orchestration** | Agent coordination, task routing across multiple agents | `orchestrator/taskRouter.ts` |
| **Proactive Engine** | Event-driven workflows, user notifications | `proactive/proactiveEngine.ts` |
| **Work Queue** | Goal decomposition, dependency resolution | `workQueue/goalDecomposer.ts` |
| **Tools** | Live MCP integration — 72 tools across Calendar (13), Mail (22), Planner (10), Teams (27) | `tools/mcpToolSetup.ts` |
| **Input Sanitizer** | Prompt injection guard — 5 pattern categories, control char stripping | `inputSanitizer.ts` |
| **Tool Cache** | LRU cache (500 entries, 60s TTL) for read-only tool results | `toolCache.ts` |
| **Analytics** | In-memory conversation metrics, response times, tool usage | `analytics.ts` |
| **Webhook Manager** | Graph subscription CRUD with auto-renewal loop | `webhookManager.ts` |
| **Conversation Export** | Audit trail with date filtering and PII redaction | `conversationExport.ts` |
| **Correlation IDs** | AsyncLocalStorage-based request-scoped distributed tracing | `correlation.ts` |
| **Rate Limiter** | Per-user sliding-window rate limiting | `rateLimiter.ts` |
| **Structured Logger** | JSON-formatted logging with module tagging | `logger.ts` |
| **LRU Cache** | Generic LRU cache with TTL for user insights and memory | `lruCache.ts` |
| **CorpGen runtime** | Autonomous digital-employee workday loop — hierarchical planner, tiered memory, adaptive summarisation, experiential learning, multi-day + organisation runners, LLM-as-judge | `corpgen/` |
| **CorpGen bridge** | Wires CorpGen to Cassidy's tool surface; exposes `runWorkdayForCassidy`, `runMultiDayForCassidy`, `runOrganizationForCassidy` to the LLM tool and HTTP harness | `corpgenIntegration.ts` |
| **CorpGen async jobs** | In-memory job runner (1 h TTL, 200-job cap) for long benchmark sweeps that exceed the App Service ~230 s response cap | `corpgenJobs.ts` |

## Features

### 🤖 Autonomous Capabilities
- Self-directed work execution without human intervention
- Real-time decision-making based on org context
- Automatic error handling and recovery
- Continuous learning from interactions

### 📊 Intelligence & Analytics
- Organizational graph analysis (reporting structures, team dynamics)
- User profiling (preferences, availability, expertise)
- Predictive task routing based on historical patterns
- Meeting transcription analysis with action item extraction
- Conversation analytics — avg/p95 response times, top tools/users, rate-limited/degraded counts
- Real-time ops dashboard via `/api/analytics` endpoint
- **Mission Control SPA** at `/dashboard/` (Entra SSO via App Service Easy Auth) — live ops, CorpGen runs, org agents, activity tail. Includes the **Agent Mind** view: an Obsidian-style 2D knowledge graph (powered by [`force-graph`](https://github.com/vasturiano/force-graph) on canvas) that visualises Cassidy's live cognition — central core + cognitive hubs (Memory, Reasoning, Tool Belt, Agent Mesh, Today's Plan, Users), per-invocation tool nodes, individual thoughts chained by correlation, long-term memory atoms grouped by `#tag`, and an outer "starfield" ring of orphan thoughts. Hover highlights neighbours; click recentres and opens detail. Backend builder lives at `dashApi.get('/mindmap')` in [cassidy/src/index.ts](cassidy/src/index.ts). See [cassidy/dashboard/](cassidy/dashboard/) and the dashboard section in [CHANGELOG.md](CHANGELOG.md).

### 🔒 Security & Compliance
- Input sanitization — prompt injection guard (5 pattern categories + control char stripping)
- Per-user sliding-window rate limiting with configurable thresholds
- Conversation export with PII redaction (email, phone, SSN, card numbers)
- Request correlation IDs (AsyncLocalStorage) for distributed tracing
- Structured JSON logging with module tagging

### 💬 Communication
- Multi-channel delivery (Teams, email, voice)
- Smart notification timing based on user availability
- Conversation memory across sessions
- Natural language responses personalized to user context

### 📅 Workflow Automation
- Calendar-driven event monitoring
- Deadline tracking and escalation
- Approval routing to appropriate stakeholders
- Report generation on configurable schedules

### 🔊 Voice Integration
- Call management (inbound/outbound)
- Real-time speech processing
- Voice-based task creation and queries

### 🧭 Autonomous Digital Employee (CorpGen)
- Hierarchical planner — strategic (monthly) → tactical (daily) → operational (per-cycle), DAG-aware
- Tiered memory — working / structured LTM / semantic, with cycle-start retrieval
- Adaptive summarisation at the 4 k-token threshold, retaining critical turns
- Experiential learning — capture successful trajectories and re-rank by cosine similarity
- ReAct loop with retry-and-skip (3 × 30 iterations) to keep the day moving
- Comm-channel fallback (Mail ↔ Teams) and graceful Table-Storage degradation
- Multi-day continuity (`runMultiDay`) and multi-employee organisation runs (`runOrganization`)
- LLM-as-judge for per-task and per-day artefact grading
- Reachable from Teams via `cg_run_workday`, or from operators via `/api/corpgen/*` (see below)

## Getting Started

### Prerequisites
- Node.js 20+ (LTS)
- Azure subscription with:
  - Azure App Service (Linux)
  - Azure OpenAI (GPT-5 deployment)
  - Microsoft Graph access
  - Teams/Microsoft 365 tenant enrolled in Frontier preview
  - Azure Table Storage for long-term memory (with public network access enabled)
- Microsoft Entra ID app registration (Agent 365 blueprint)
- `a365` CLI (Microsoft.Agents.A365.DevTools.Cli --prerelease)

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/ITSpecialist111/Cassidy-Enterprise-Operations-Manager.git
   cd Cassidy-Enterprise-Operations-Manager
   ```

2. **Configure Azure credentials**
   ```bash
   cd cassidy
   cp a365.config.template.json a365.config.json
   # Edit a365.config.json with your:
   # - Azure Tenant ID
   # - Subscription ID
   # - Resource Group
   # - App registration details
   ```

3. **Set environment variables**
   ```bash
   cp .env.template .env
   # Edit .env with your:
   # - MicrosoftAppId (blueprint app client ID)
   # - MicrosoftAppPassword (blueprint app secret)
   # - AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT
   # - OPS_TEAMS_CHANNEL_ID (for standup posts)
   # - MANAGER_EMAIL (for notifications)
   # - SCHEDULED_SECRET (for authenticated API calls)
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Build locally**
   ```bash
   npm run build
   ```

6. **Test locally** (if supported)
   ```bash
   npm test
   ```

### Deployment to Azure

#### Using Azure Developer CLI (recommended)

```bash
# Initialize project (if not already done)
azd init

# Deploy to Azure
azd up
```

#### Using a365 CLI (recommended)

```bash
cd cassidy

# One-time setup: permissions, MCP servers, bot registration
a365 setup all
a365 setup permissions mcp

# Add MCP servers (creates ToolingManifest.json)
a365 develop add-mcp-servers mcp_CalendarTools mcp_PlannerServer mcp_MailTools mcp_TeamsServer

# Deploy to Azure App Service
a365 deploy

# Publish to M365 tenant
a365 publish
```

#### Manual Docker Deployment

1. **Build Docker image** (via `cassidy/Dockerfile`)
   ```bash
   docker build -t cassidy:latest .
   docker tag cassidy:latest <acr-name>.azurecr.io/cassidy:latest
   docker push <acr-name>.azurecr.io/cassidy:latest
   ```

2. **Deploy to Azure App Service**
   ```bash
   az webapp create --resource-group <rg> --plan <plan> --name <app> \
     --runtime "NODE|20-lts" --deployment-container-image-name <image>
   ```

## Configuration

### agent.yaml
Defines the agent blueprint for Foundry deployment:
- Agent name, description, and metadata
- Required environment variables
- Protocol specifications
- Resource requirements

### Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `MicrosoftAppId` | Entra app client ID (blueprint) | `151d7bf7-...` |
| `MicrosoftAppPassword` | Entra app secret | `AQAANCMnd8B...` |
| `MicrosoftAppTenantId` | Entra tenant ID | `e4ccbd32-...` |
| `AZURE_OPENAI_ENDPOINT` | OpenAI resource endpoint | `https://<name>.openai.azure.com/` |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name | `gpt-5` |
| `MCP_PLATFORM_ENDPOINT` | Work IQ gateway | `https://agent365.svc.cloud.microsoft` |
| `agentic_connectionName` | OBO auth handler name | `AgenticAuthConnection` |
| `OPS_TEAMS_CHANNEL_ID` | Teams channel for standup | `19:abc...@thread.v2` |
| `MANAGER_EMAIL` | Manager notification email | `admin@contoso.onmicrosoft.com` |
| `SCHEDULED_SECRET` | Auth token for scheduled API calls | `cassidy-sched-2026-ops` |
| `ORG_NAME` | Display organization name | `Contoso Corp` |
| `NODE_ENV` | Runtime environment | `production` |

### MCP Server Configuration

Cassidy connects to 4 MCP servers via the Agent 365 Work IQ platform:

| Server | Tools | Scope |
|--------|-------|-------|
| `mcp_CalendarTools` | 13 tools (read/create events, free/busy) | `McpServers.Calendar.All` |
| `mcp_MailTools` | 22 tools (read/send/search email) | `McpServers.Mail.All` |
| `mcp_PlannerServer` | 10 tools (tasks, plans, buckets) | `McpServers.Planner.All` |
| `mcp_TeamsServer` | 27 tools (channels, messages, teams) | `McpServers.Teams.All` |

Servers are declared in `ToolingManifest.json` and registered via `a365 setup permissions mcp`.

Authentication uses OBO (On-Behalf-Of) token exchange — the SDK's `AgenticAuthenticationService.GetAgenticUserToken()` obtains a delegated token for the MCP platform scope, and `Utility.GetToolRequestHeaders()` builds the proper `Authorization`, `x-ms-agentid`, and `x-ms-tenant-id` headers.

### Memory Storage

Conversation and long-term memory use Azure Table Storage via managed identity (DefaultAzureCredential):

| Table | Purpose |
|-------|---------|
| `CassidyConversations` | Per-user conversation history |
| `CassidyLongTermMemory` | Extracted facts and preferences |
| `CassidyUserRegistry` | User profiles and registration |
| `CassidyUserInsights` | Behavioral analytics |
| `CassidyAgentRegistry` | Multi-agent coordination |
| `CassidyWorkQueue` | Autonomous work items |

**Requirements:** Storage account must have public network access enabled (or VNet integration), and the web app's managed identity needs `Storage Table Data Contributor` role.

## API Endpoints

### Messaging
- `POST /api/messages` — Primary message endpoint (from Teams/channels)

### Scheduled Tasks
- `POST /api/scheduled` — Trigger daily standup or other scheduled operations
  - Header: `Authorization: Bearer <SCHEDULED_SECRET>`

### Health & analytics
- `GET /api/health` — Agent health/readiness status (version, uptime, feature flags, circuit-breaker states)
- `GET /api/analytics` — Conversation metrics (response times, top tools/users, rate-limited / degraded counts)
- `GET /api/conversations/export` — Conversation export with PII redaction

### CorpGen autonomous runs (operator-only)

All routes require header `x-scheduled-secret: <SCHEDULED_SECRET>` and are registered before the JWT middleware. Long sweeps should use `async: true` to avoid the App Service ~230 s response cap.

| Route | Method | Purpose |
|---|---|---|
| `/api/corpgen/run` | `POST` | Single workday (sync). Body: `maxCycles`, `maxWallclockMs`, `maxToolCalls`, `employeeId` |
| `/api/corpgen/multi-day` | `POST` | N consecutive days (sync; `async:true` → 202 + `jobId`). Body adds `days` (1–30) |
| `/api/corpgen/organization` | `POST` | Multi-employee × multi-day (sync or async). Body adds `members[]` (1–10), `concurrent` |
| `/api/corpgen/jobs` | `GET` | List recent async jobs |
| `/api/corpgen/jobs/:id` | `GET` | Poll a specific async job |

Deep dive: [docs/CORPGEN.md](docs/CORPGEN.md). Smoke scripts under [skill-assets/](skill-assets/): [smoke-corpgen-http.ps1](skill-assets/smoke-corpgen-http.ps1), [smoke-corpgen-multi-day.ps1](skill-assets/smoke-corpgen-multi-day.ps1), [smoke-corpgen-organization.ps1](skill-assets/smoke-corpgen-organization.ps1), [smoke-corpgen-async.ps1](skill-assets/smoke-corpgen-async.ps1).

## Usage Examples

### Start Cassidy in Teams
1. Add Cassidy app to your Teams workspace
2. @ mention Cassidy in any channel or 1:1 chat
3. Natural language requests:
   - "Break down the Q2 roadmap into sprints"
   - "Who's available for a meeting on Friday?"
   - "Summarize this week's project status"
   - "Escalate this request to finance approval"

### Scheduled Operations
Configure standup via Logic App (`cassidy/azure-function-trigger/standup-logic-app.json`):
- Runs daily at configured time
- Collects updates from team members
- Generates summary report
- Posts to ops channel
- Sends manager email digest

### Voice Queries
Call Cassidy's voice endpoint to:
- Report status updates
- Create new tasks
- Ask questions about schedules/deadlines

## Development

### Project Structure
- **src/** — Main agent implementation
- **publish/** — Azure App Service deployment assets
- **azure-function-trigger/** — Scheduled task orchestration
- **manifest/** — Teams app manifest and branding
- **skill-assets/** — Deployment scripts and templates

### Building
```bash
npm run build          # Compile TypeScript
npm run dev           # Watch mode (if supported)
npm test              # Run tests (45 suites, 513 tests)
npm run lint          # Code quality checks (ESLint, zero warnings)
npm run test:coverage # Run tests with V8 coverage report
```

### Testing

The test suite covers all production modules (45 suites, 513 tests). For CorpGen-specific procedures see [TESTING_CORPGEN.md](TESTING_CORPGEN.md) (local + post-deploy regression matrix) and [TESTING_CORPGEN_LIVE.md](TESTING_CORPGEN_LIVE.md) (live operator handoff).

```bash
npx vitest run        # Run full suite
npx vitest run src/meetings/  # Run specific module
```

| Area | Suites | Tests |
|------|--------|-------|
| Meetings (context, monitor, names) | 3 | 57 |
| Reports (distribution) | 1 | 30 |
| Tools (ops, dispatch, intelligence) | 3 | 63 |
| Intelligence (predictions, org, profiler) | 3 | 66 |
| Orchestrator (registry, router) | 2 | 19 |
| Autonomous & Work Queue | 2 | 14 |
| Memory (table storage) | 1 | 5 |
| Reports (generator) | 1 | 11 |
| Core (featureConfig, auth, persona, telemetry) | 4 | 35 |
| Integration (E2E pipeline) | 1 | 10 |
| Retry & Circuit Breaker | 1 | 23 |
| Adaptive Cards | 1 | 15 |
| Conversation Memory | 1 | 11 |
| Logger | 1 | 7 |
| Rate Limiter | 1 | 10 |
| LRU Cache | 1 | 13 |
| Input Sanitizer | 1 | 16 |
| Tool Cache | 1 | 9 |
| Analytics | 1 | 12 |
| Webhook Manager | 1 | 8 |
| Conversation Export | 1 | 11 |
| Correlation IDs | 1 | 9 |
| **Total** | **38** | **467** |

- Integration tests: Azure Function trigger verification
- E2E testing: Via Teams or Foundry test console

### Code Style
- TypeScript strict mode enabled
- ESLint configuration: [See tsconfig.json](cassidy/tsconfig.json)
- Format: Prettier (if configured)

## Troubleshooting

### Common Issues

**Error 13: AADSTS82001 "MCP app-only token blocked" / `liveMcp:0` on every turn**
- Cause: Agentic apps are barred by Entra from `client_credentials`-with-secret. The `@microsoft/agents-hosting` SDK falls back to `MicrosoftAppPassword` only when no FIC is configured, and that fallback is rejected by the platform.
- Fix: Configure a Federated Identity Credential backed by a **user-assigned** managed identity (system-assigned is not consumed by msal-node's `ManagedIdentityApplication`):
  1. `az identity create -g <rg> -n <mi-name> -l <region>` — note the `clientId` and `principalId`.
  2. `az webapp identity assign -g <rg> -n <webapp> --identities <mi-resource-id>`.
  3. On the bot's Entra app reg, create a federated credential: `issuer=https://login.microsoftonline.com/<tenant>/v2.0`, `subject=<MI principalId>`, `audiences=["api://AzureADTokenExchange"]`.
  4. Set webapp env var `connections__<connectionName>__settings__FICClientId=<MI clientId>` (e.g. `connections__service_connection__settings__FICClientId`). The SDK then takes the FIC path in `MsalTokenProvider.getAgenticApplicationToken()` and produces valid OBO tokens for MCP discovery.

**TenantIdInvalid on MCP tool loading**
- Cause: The tooling gateway returns `MCPServerConfig` objects without auth headers; the SDK's `getMcpClientTools()` passes `config.headers` directly to the MCP transport
- Fix: Perform OBO token exchange via `AgenticAuthenticationService.GetAgenticUserToken()`, then enrich each server config with `Utility.GetToolRequestHeaders()` before calling `getMcpClientTools()`. See `tools/mcpToolSetup.ts` `getOboToolHeaders()` and `buildToolDefinitions()`.

**OpenAI 400: tools array too long (>128)**
- Cause: Too many MCP + static tools combined exceed OpenAI's 128-tool limit
- Fix: Filter to only configured MCP servers (skip canary/preview variants), cap merged array at 128 in `agent.ts`

**Table Storage 403 AuthorizationFailure**
- Cause: Storage account has public network access disabled and no VNet integration
- Fix: Enable public network access: `az storage account update --name <sa> --public-network-access Enabled`
- Also verify: `Storage Table Data Contributor` role assigned to web app managed identity

**Meeting transcriptions not processing**
- Check: `meetings/meetingMonitor.ts` event subscriptions
- Verify: Microsoft Graph `OnlineMeetingTranscript.Read.All` scope granted

**Scheduled API calls failing**
- Verify: `SCHEDULED_SECRET` environment variable matches Logic App trigger
- Check: Function trigger endpoint accessible and healthy

**Memory not persisting across restarts**
- Ensure: Table Storage connection strings configured in `.env`
- Create: Required tables before first run

## Security Considerations

- **Never commit** `a365.config.json` or `.env` files (protected in `.gitignore`)
- **Rotate secrets** regularly (MicrosoftAppPassword, SCHEDULED_SECRET)
- **Limit permissions** — Grant only required Microsoft Graph scopes
- **Monitor access** — Enable audit logging for governance workflows
- **Container security** — Base image updates and vulnerability scanning

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and commit: `git commit -m "Add my feature"`
4. Push to branch: `git push origin feature/my-feature`
5. Open a Pull Request

## Monitoring & Logs

### Foundry Agent Console
- View real-time logs and execution traces
- Monitor token usage and performance
- Review conversation history (with appropriate permissions)

### Azure Monitor / Application Insights
- Configure Application Insights for deeper observability
- Query execution metrics, error rates, latency
- Set up alerts for critical failures

## Testing & Demo

For a complete walkthrough of all features with step-by-step test scenarios, expected behaviors, and demo talking points, see [TESTING.md](TESTING.md).

**Quick Test Checklist:**
- [ ] NLU & context awareness
- [ ] Task decomposition & work queue
- [ ] Meeting intelligence
- [ ] Proactive notifications
- [ ] Report generation
- [ ] Memory & preferences
- [ ] Multi-agent coordination
- [ ] Error handling
- [ ] Voice interaction (optional)

## Support & Documentation

- **Docs index**: [docs/README.md](docs/README.md) — links every Cassidy doc together
- **CorpGen deep dive**: [docs/CORPGEN.md](docs/CORPGEN.md) — paper-concept mapping, lifecycle, HTTP & LLM-tool surfaces, faithful-vs-extension status
- **Changelog**: [CHANGELOG.md](CHANGELOG.md) — full release history
- **Testing — bot scenarios**: [TESTING.md](TESTING.md) — end-user / Teams walkthroughs
- **Testing — CorpGen regression**: [TESTING_CORPGEN.md](TESTING_CORPGEN.md) — local + post-deploy procedure
- **Testing — CorpGen live**: [TESTING_CORPGEN_LIVE.md](TESTING_CORPGEN_LIVE.md) — operator handoff against the running webapp
- **Test Results**: [TEST_RESULTS.md](TEST_RESULTS.md) — latest live test results and deploy status
- **Deployment skill**: [SKILL.md](SKILL.md) — Agent 365 end-to-end deployment with error catalogue
- **API reference**: [cassidy/agent.yaml](cassidy/agent.yaml) — defines all environment variables

## License

This project is provided as-is. Modify and use according to your organization's policies.

## Roadmap

- [x] ~~Expanded calendar integration (Outlook sync)~~ — Live via MCP CalendarTools (13 tools)
- [x] ~~MCP tool wiring~~ — 72 live tools across Calendar, Mail, Planner, Teams
- [x] ~~Security hardening~~ — timingSafeEqual auth, OData injection prevention, log scrubbing
- [x] ~~Codebase quality~~ — Consolidated 13 AzureOpenAI clients to 1, eliminated `as any` casts
- [x] ~~Live data integration~~ — Graph Planner API replacing mock operations data
- [x] ~~Subsystem wiring~~ — Prediction engine, user profiler, org graph all connected
- [x] ~~Full test coverage~~ — 29 suites, 372 tests covering every production module
- [x] ~~CI/CD Pipeline~~ — GitHub Actions: lint, type-check, test with coverage on every push/PR
- [x] ~~Application Insights~~ — Telemetry module with OpenAI/tool call tracking, exception tracing
- [x] ~~Environment configuration~~ — 15 timeouts/intervals extracted to env-configurable AppConfig
- [x] ~~Infrastructure as Code~~ — Bicep template: App Service, Storage, App Insights, role assignments
- [x] ~~ESLint integration~~ — Zero-warning TypeScript linting with flat config
- [x] ~~Adaptive Card responses~~ — Rich task lists, approvals, reports, and health cards in Teams
- [x] ~~Error recovery~~ — Retry with exponential backoff + circuit breakers for OpenAI, Graph, MCP
- [x] ~~SharePoint MCP server integration~~
- [x] ~~OneDrive MCP server integration~~
- [x] ~~Structured JSON logger~~ — Replaced console.* with structured logger across agent + index
- [x] ~~Per-user rate limiting~~ — Sliding-window rate limiter with configurable thresholds
- [x] ~~LRU cache with TTL~~ — Generic cache for user profiles and memory recall
- [x] ~~Approval action handler~~ — Adaptive Card invoke handler for Approve/Reject buttons
- [x] ~~Graceful degradation~~ — Fallback responses when OpenAI circuit is open
- [x] ~~Input sanitization~~ — Prompt injection guard with 5 pattern categories
- [x] ~~Tool result caching~~ — LRU cache for 12 read-only Graph/MCP tools (60s TTL)
- [x] ~~Conversation analytics~~ — /api/analytics endpoint with real-time ops metrics
- [x] ~~Webhook subscription manager~~ — Graph subscription CRUD with auto-renewal
- [x] ~~Conversation export~~ — /api/conversations/export with PII redaction
- [x] ~~Request correlation IDs~~ — AsyncLocalStorage-based distributed tracing
- [ ] Multi-language support (localization)
- [ ] Custom skill marketplace integration
- [ ] Advanced sentiment analysis
- [ ] Custom Azure OpenAI models support
- [ ] Graph connector support for custom data sources

---

**Last Updated**: April 20, 2026  
**Version**: 1.7.0  
**Status**: Production — Microsoft Agent Framework Teams bot + autonomous CorpGen digital employee. 72+ live MCP tools (6 servers), 45 test suites / 513 tests, input sanitisation, tool caching, analytics, correlation IDs, rate limiting, structured logging, retry/circuit breakers, Adaptive Cards, CI pipeline, App Insights, CorpGen LLM tool + `/api/corpgen/*` operator harness with async job runner.
