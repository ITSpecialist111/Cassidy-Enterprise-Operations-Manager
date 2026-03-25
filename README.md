# Cassidy — Enterprise Operations Manager

A sophisticated autonomous agent for enterprise task coordination, project tracking, approvals, and team workflows. Built on Microsoft Agent Framework and deployed to Microsoft Foundry.

## Overview

Cassidy is an AI-powered operations manager that autonomously handles:
- **Task Coordination** — Breaking down complex goals into actionable work items
- **Project Tracking** — Monitoring progress, deadlines, and dependencies
- **Approval Workflows** — Routing decisions to appropriate stakeholders
- **Team Communications** — Proactive notifications via Teams and email
- **Meeting Intelligence** — Transcription analysis and action item extraction
- **Report Generation** — Automated insights and performance summaries
- **Voice & Call Management** — Integration with call systems and voice processing
- **Calendar & Scheduling** — Event monitoring and deadline management

## Architecture

### Core Components

```
cassidy/
├── src/                          # Main agent source code
│   ├── agent.ts                  # Agent initialization & request handling
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
│   ├── tools/                    # MCP tool setup & handlers
│   ├── voice/                    # Call management & speech processing
│   └── workQueue/                # Work decomposition & queue management
├── publish/                      # Azure App Service deployment package
├── azure-function-trigger/       # Logic App trigger for scheduled tasks
└── manifest/                     # Agent manifest & Teams integration
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
| **Tools** | MCP integration for Microsoft Graph, Teams, SharePoint | `tools/mcpToolSetup.ts` |

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
- Node.js 18+
- Azure subscription with:
  - Azure App Service
  - Azure OpenAI (GPT-4 or GPT-5)
  - Microsoft Graph access
  - Teams/Microsoft 365 tenant
  - (Optional) Azure Table Storage for long-term memory
- Microsoft Entra ID (Azure AD) app registration

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

#### Manual Deployment

1. **Build Docker image** (via `cassidy/Dockerfile`)
   ```bash
   docker build -t cassidy:latest .
   docker tag cassidy:latest <acr-name>.azurecr.io/cassidy:latest
   docker push <acr-name>.azurecr.io/cassidy:latest
   ```

2. **Deploy to Microsoft Foundry**
   ```bash
   # Use a365 CLI or Azure Portal to:
   # 1. Create hosted agent from agent.yaml
   # 2. Configure environment variables
   # 3. Start the agent container
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
| `OPS_TEAMS_CHANNEL_ID` | Teams channel for standup | `19:abc...@thread.v2` |
| `MANAGER_EMAIL` | Manager notification email | `admin@contoso.onmicrosoft.com` |
| `SCHEDULED_SECRET` | Auth token for scheduled API calls | `cassidy-sched-2026-ops` |
| `ORG_NAME` | Display organization name | `Contoso Corp` |
| `NODE_ENV` | Runtime environment | `production` |

### Memory Storage

By default, conversation history is held in-memory. For production:

1. **Configure Azure Table Storage**
   - Update connection strings in `memory/tableStorage.ts`
   - Creates tables: `ConversationMemory`, `UserProfiles`, `OrgGraph`

2. **Data Schema**
   - Partition keys: User ID, timestamp
   - Retention: Configurable (default: 90 days)

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
npm test              # Run tests
npm run lint          # Code quality checks
```

### Testing
- Unit tests: `**/*.test.ts`
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
- Fix: Ensure `TurnContext` is passed through tool setup

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

## Support & Documentation

- **Deployment Issues**: See [SKILL.md](SKILL.md) for detailed troubleshooting
- **API Reference**: [agent.yaml](cassidy/agent.yaml) defines all environment variables
- **Architecture Deep Dive**: [SKILL.md](SKILL.md) includes error codes and design patterns

## License

This project is provided as-is. Modify and use according to your organization's policies.

## Roadmap

- [ ] Multi-language support (localization)
- [ ] Custom skill marketplace integration
- [ ] Advanced sentiment analysis
- [ ] Expanded calendar integration (Outlook sync)
- [ ] Custom Azure OpenAI models support
- [ ] Graph connector support for custom data sources

---

**Last Updated**: March 25, 2026  
**Version**: 1.0.0  
**Status**: Production-Ready
