# Cassidy — Enterprise Operations Manager

![Tests](https://img.shields.io/badge/tests-467%20passed-brightgreen)
![Suites](https://img.shields.io/badge/suites-38-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Platform](https://img.shields.io/badge/platform-Microsoft%20Teams-6264A7)
![AI](https://img.shields.io/badge/model-GPT--5-orange)
![MCP Tools](https://img.shields.io/badge/MCP%20tools-72%20live-green)
![Version](https://img.shields.io/badge/version-1.7.0-blue)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF)
![Observability](https://img.shields.io/badge/telemetry-App%20Insights-68217A)

A sophisticated autonomous agent for enterprise task coordination, project tracking, approvals, and team workflows. Built on Microsoft Agent Framework with live MCP (Model Context Protocol) integration for Calendar, Mail, Planner, and Teams via the Agent 365 Work IQ platform.

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
│   ├── tools/                    # MCP tool setup, OBO auth & handlers
│   ├── voice/                    # Call management & speech processing
│   └── workQueue/                # Work decomposition & queue management
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

    subgraph MCP["MCP Servers (72 live tools)"]
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

    subgraph Memory["Persistence (Azure Table Storage)"]
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
    Channel -->|@mention| AgentTS
    AgentTS <-->|OBO token exchange| MCP
    AgentTS --> Intelligence
    AgentTS --> Autonomous
    AgentTS <--> Memory
    AgentTS --> Orchestrator
    Loop --> Queue
    Queue --> Decomp
    Proactive -->|notifications| User
    Intelligence --> Proactive
    AgentTS --> Output
    Notifier -->|Teams/email| User

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

### Health
- `GET /health` — Agent health/readiness status

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
npm test              # Run tests (38 suites, 467 tests)
npm run lint          # Code quality checks (ESLint, zero warnings)
npm run test:coverage # Run tests with V8 coverage report
```

### Testing

The test suite covers all production modules (38 suites, 467 tests):

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

**Error 13: AADSTS82001 "MCP app-only token blocked"**
- Cause: Using app-only credentials instead of delegated user token
- Fix: Ensure `TurnContext` is passed through tool setup; app-only fallback is for discovery only

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

- **Changelog**: [CHANGELOG.md](CHANGELOG.md) - Full deployment history (23 deploys)
- **Testing Guide**: [TESTING.md](TESTING.md) - Complete test suite with expected outcomes
- **Test Results**: [TEST_RESULTS.md](TEST_RESULTS.md) - Latest live test results and deploy status
- **Deployment Issues**: See [SKILL.md](SKILL.md) for detailed troubleshooting
- **API Reference**: [agent.yaml](cassidy/agent.yaml) defines all environment variables
- **Architecture Deep Dive**: [SKILL.md](SKILL.md) includes error codes and design patterns

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

**Last Updated**: March 26, 2026  
**Version**: 1.7.0  
**Status**: Production — 72+ live MCP tools (6 servers), 38 test suites / 467 tests, input sanitization, tool caching, analytics, correlation IDs, rate limiting, structured logging, retry/circuit breakers, Adaptive Cards, CI pipeline, App Insights
