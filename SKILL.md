# Skill: Microsoft Agent 365 SDK — End-to-End Deployment

> **Status:** Verified working as of 2026-03-16  
> **Agents deployed:** Hello World (echo + GPT-4o) + Morgan (autonomous finance analyst, GPT-5, 11 MCP servers)  
> **Outcome:** Both agents deployed to Azure, published to M365 tenant, instances running in Teams/M365 Copilot. All permissions granted, MCP OBO auth working.  
> **Frontier preview required:** https://adoption.microsoft.com/copilot/frontier-program/

---

## Table of Contents

1. [Overview — Agent 365 vs Other SDKs](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Step 1 — Create Entra App Registration for CLI (Option B)](#3-step-1-entra-app-registration)
4. [Step 2 — Build Agent Code](#4-step-2-build-agent-code)
5. [Step 3 — CLI Config Init](#5-step-3-cli-config-init)
6. [Step 4 — a365 setup all](#6-step-4-a365-setup-all)
7. [Step 5 — a365 deploy](#7-step-5-a365-deploy)
8. [Step 6 — a365 publish](#8-step-6-a365-publish)
9. [Step 7 — M365 Admin Center Upload (Manual)](#9-step-7-m365-admin-center)
10. [Step 8 — Teams Developer Portal Configuration (Manual)](#10-step-8-teams-developer-portal)
11. [Step 9 — Create Agent Instance](#11-step-9-create-agent-instance)
12. [Errors Encountered & Fixes](#12-errors--fixes)
13. [Known Gotchas](#13-known-gotchas)
14. [Reference Architecture](#14-reference-architecture)
15. [Official Sources](#15-official-sources)
16. [Morgan — Autonomous Finance Agent](#16-morgan--autonomous-finance-agent-second-deployment)
    - Error 12: GPT-5 API incompatibilities
    - Error 13: AADSTS82001 MCP app-only token blocked
    - Error 14: Teams markdown tables

---

## 1. Overview

### What is Microsoft Agent 365?

Agent 365 is an **enterprise governance layer** (Frontier preview) that adds Entra-backed identity, governed MCP tool access, OpenTelemetry observability, and M365 notifications on top of any existing agent SDK.

It is **NOT** a replacement for:
- Microsoft Agents SDK (`@microsoft/agents`) — that handles hosting/activity protocol
- Microsoft Teams SDK (`@microsoft/teams.apps`) — that handles Teams-specific apps
- Copilot Studio or Azure AI Foundry

### Correct SDK/CLI Stack

| Component | Package / Tool | Purpose |
|-----------|---------------|---------|
| Agent SDK | `@microsoft/agents-hosting` ^1.2.2 | CloudAdapter, AgentApplication, JWT auth |
| Activity types | `@microsoft/agents-activity` ^1.2.2 | ActivityTypes enum |
| CLI | `Microsoft.Agents.A365.DevTools.Cli --prerelease` | Setup, deploy, publish (`a365` command) |

### Wrong SDKs (do NOT use for Agent 365)

| Wrong Package | Why Wrong |
|--------------|-----------|
| `@microsoft/teams.apps` | Teams-only, no Agent 365 identity/governance |
| `atk` (M365 Agents Toolkit CLI) | Different deployment target — Teams apps, not Agent 365 blueprints |
| `@microsoft/agents` (bare) | Missing CloudAdapter enterprise auth layer |

---

## 2. Prerequisites

### Accounts & Roles

- M365 tenant enrolled in **Frontier preview** program
- Azure subscription (Contributor access)
- User account with **Global Administrator** or **Agent ID Administrator** role in Entra
- Account must NOT have `Directory.AccessAsUser.All` in app-only contexts — Agent APIs reject it

### Tools (install order matters)

```powershell
# 1. .NET 8.0+ (required for CLI)
# Download from https://dotnet.microsoft.com/download

# 2. Azure CLI
# Download from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli

# 3. Node.js 18.x+ with npm
# Download from https://nodejs.org/

# 4. Agent 365 CLI (always use --prerelease — no stable release yet)
dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease

# Verify
a365 -h
a365 --version
```

### Azure CLI Login

```powershell
az login
az account set --subscription "<your-subscription-id>"
az account show  # verify correct tenant/sub
```

---

## 3. Step 1 — Entra App Registration for CLI (Option B)

The CLI requires a custom Entra app registration with 5 specific permissions. **Two of these (`AgentIdentityBlueprint.*`) are beta permissions that do NOT appear in the Entra admin center UI** — they must be granted via the Graph API (Option B).

> ⚠️ **CRITICAL:** Do NOT use the "Grant admin consent" button in Entra admin center after granting via Graph API. It overwrites and deletes the beta permissions.

### Create the App Registration

```powershell
# Create the app (public client required for device-code auth)
$app = az ad app create `
  --display-name "Agent365-CLI-Client" `
  --public-client-redirect-uris "http://localhost:8400" `
  --query "{appId:appId, id:id}" -o json | ConvertFrom-Json

$clientId = $app.appId
$appObjectId = $app.id

# Create service principal
az ad sp create --id $clientId
```

### Get the Graph Service Principal ID

```powershell
$graphSpId = az ad sp show --id "00000003-0000-0000-c000-000000000000" --query id -o tsv
```

### Grant All 5 Required Permissions via Graph API

```powershell
$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
$spObjectId = az ad sp show --id $clientId --query id -o tsv

# Permission IDs (Microsoft Graph delegated)
$permissions = @(
    "3afa6a7d-9d1d-4dda-9b2f-54cd192b0e73",  # AgentIdentityBlueprint.ReadWrite.All (BETA)
    "5aef0bcc-1b8e-4379-8594-bc84a3ecbc08",  # AgentIdentityBlueprint.UpdateAuthProperties.All (BETA)
    "1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9",  # Application.ReadWrite.All
    "41ce6ca6-6826-4807-84f1-1c82854f7af5",  # DelegatedPermissionGrant.ReadWrite.All
    "06da0dbc-49e2-44d2-8312-53f166ab848a"   # Directory.Read.All
)

$headers = @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" }

foreach ($permId in $permissions) {
    $body = @{
        principalId = $spObjectId
        resourceId  = $graphSpId
        appRoleId   = $permId
    } | ConvertTo-Json
    $r = Invoke-RestMethod "https://graph.microsoft.com/v1.0/servicePrincipals/$spObjectId/appRoleAssignments" `
        -Method POST -Headers $headers -Body $body
    Write-Host "Granted: $permId"
}
```

> **Why Option B?** The Entra admin center UI does not show beta permissions. `az ad app permission add` can add them to the manifest, but the "Grant admin consent" button in the portal DELETES the beta permissions when it re-syncs. Option B (direct Graph API appRoleAssignments) bypasses the admin center entirely.

---

## 4. Step 2 — Build Agent Code

### Project Structure

```
hello-world-agent/
├── src/
│   ├── index.ts          # Express server + CloudAdapter setup
│   └── agent.ts          # AgentApplication with message handlers
├── package.json
├── tsconfig.json
└── .env                  # Populated by a365 config init + a365 setup all
```

### package.json — Critical: TypeScript must be in `dependencies` (not devDependencies)

```json
{
  "name": "hello-world-agent",
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "commonjs",
  "scripts": {
    "start": "node dist/index.js",
    "dev": "nodemon --watch src --exec ts-node src/index.ts",
    "build": "tsc",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@microsoft/agents-hosting": "^1.2.2",
    "@microsoft/agents-activity": "^1.2.2",
    "dotenv": "^16.4.5",
    "express": "^4.21.2",
    "typescript": "^5.4.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.9",
    "nodemon": "^3.1.10",
    "rimraf": "^5.0.0",
    "ts-node": "^10.9.2"
  }
}
```

> **Why `typescript` in `dependencies`?** Azure App Service uses Oryx for remote builds. Oryx only installs `dependencies`, not `devDependencies`. If `typescript`/`tsc` is in `devDependencies`, the Oryx build fails with `tsc: not found`.

### src/index.ts — Correct CloudAdapter Pattern

```typescript
// IMPORTANT: Load environment variables FIRST before any other imports
import { configDotenv } from 'dotenv';
configDotenv();

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request
} from '@microsoft/agents-hosting';
import express, { Response } from 'express';
import { agentApplication } from './agent';

const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();

const server = express();
server.use(express.json());

// Health endpoint (no auth — required for App Service warmup probe)
server.get('/api/health', (_req, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// JWT auth for all other routes
server.use(authorizeJWT(authConfig));

// CORRECT pattern (see GitHub issue #303 — do NOT return reply object from Express)
server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.PORT) || 3978;
// CRITICAL: bind to 0.0.0.0 in production (not localhost) for Azure App Service
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');

server.listen(port, host, () => {
  console.log(`Agent listening on ${host}:${port}`);
}).on('error', (err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

### src/agent.ts — AgentApplication

```typescript
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';

export const agentApplication = new AgentApplication<TurnState>({
  storage: new MemoryStorage(),
});

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
  const userMessage = context.activity.text?.trim() || '';
  const userName = context.activity.from?.name || 'there';
  await context.sendActivity(`Hello, ${userName}! You said: "${userMessage}"`);
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
  if (context.activity.action === 'add') {
    await context.sendActivity('Hello World Agent installed! Send me a message to get started.');
  }
});
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2019",
    "module": "commonjs",
    "lib": ["ES2019"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 5. Step 3 — CLI Config Init

### Option A: Interactive (recommended for first-time)

```powershell
cd <your-agent-project-dir>
a365 config init
```

Prompts you for: tenant, subscription, agent name, resource group, location, App Service plan SKU, manager email.

### Option B: Non-interactive (for automation/CI)

Create `a365.config.json` manually then import:

```json
{
  "tenantId": "<from az account show>",
  "subscriptionId": "<from az account show>",
  "resourceGroup": "rg-my-agent",
  "location": "australiaeast",
  "environment": "prod",
  "needDeployment": true,
  "clientAppId": "<CLI app clientId from Step 1>",
  "appServicePlanName": "rg-my-agent-plan",
  "appServicePlanSku": "B1",
  "webAppName": "myagent-webapp",
  "agentIdentityDisplayName": "MyAgent Identity",
  "agentBlueprintDisplayName": "MyAgent Blueprint",
  "agentUserPrincipalName": "myagent@<yourtenant>.onmicrosoft.com",
  "agentUserDisplayName": "MyAgent Agent User",
  "managerEmail": "admin@<yourtenant>.onmicrosoft.com",
  "agentUserUsageLocation": "US",
  "deploymentProjectPath": "<absolute path to project>",
  "agentDescription": "MyAgent - Agent 365 Agent"
}
```

```powershell
a365 config init -c ./a365.config.json
```

### Verify config

```powershell
a365 config display -g
```

---

## 6. Step 4 — a365 setup all

```powershell
a365 setup all
```

**What this does:**
- Creates Azure Resource Group, App Service Plan, Web App with system-assigned Managed Identity
- Creates Entra Agent Identity application
- Creates Entra Agent Blueprint application (this becomes your `MicrosoftAppId`)
- Grants all required MCP/Bot/Observability/PowerPlatform permissions
- Registers the messaging endpoint with Bot Framework

**Outputs to capture** (from `a365 config display -g` after setup):
- `agentBlueprintId` — used as `MicrosoftAppId` in `.env`, and as `Bot ID` in Teams Developer Portal
- `botMessagingEndpoint` — your Azure Web App `/api/messages` URL

**Time:** ~3–5 minutes

> ⚠️ There is a WARNING about Frontier enrollment auto-verification — this is a non-fatal warning, setup continues. The CLI cannot auto-verify Frontier enrollment but the commands still work if your tenant is enrolled.

---

## 7. Step 5 — a365 deploy

```powershell
a365 deploy
```

**What this does:**
- Detects Node.js project
- Runs `npm install` + `npm run build` (tsc) locally
- Creates deployment zip with `dist/` contents + Oryx manifest
- Uploads to Azure App Service via zip deploy
- Converts `.env` to Azure App Settings
- Oryx on Azure runs `npm install --production` + `npm run build` again

**Verify deployment:**

```powershell
Invoke-WebRequest "https://<your-webapp>.azurewebsites.net/api/health"
# Expected: 200 {"status":"healthy","timestamp":"..."}
```

---

## 8. Step 6 — a365 publish

```powershell
a365 publish
```

**What this does:**
- Extracts manifest templates to `manifest/` folder
- Updates `manifest.json` with your `agentBlueprintId`
- Creates `manifest/manifest.zip` (includes `manifest.json`, `agenticUserTemplateManifest.json`, `color.png`, `outline.png`)
- Prints upload instructions (does NOT auto-upload in v1.1.115)

**Before running**, optionally customise `manifest/manifest.json`:
- `name.short` (30 chars max) — display name in Teams
- `name.full` — full name
- `description.short/full` — shown in Teams app store
- `developer.name` / URLs — your org info

> **Note on v1.1.115:** The `a365 publish` command creates `manifest.zip` but does NOT automatically upload it to the M365 Admin Center (despite what the AI-guided setup documentation implies). You must upload it manually — see Step 7.

---

## 9. Step 7 — M365 Admin Center Upload (Manual — browser required)

This step **cannot be automated**. The Teams app catalog API (`/v1.0/appCatalogs/teamsApps`) rejects Agent 365 blueprint manifests (`manifestVersion: devPreview`) with `Forbidden` even with `AppCatalog.ReadWrite.All` permissions.

**Steps:**

1. Log in as Global Administrator or Agent ID Administrator
2. Navigate to: **https://admin.cloud.microsoft/#/agents/all**
3. Click **"Upload custom agent"**
4. Upload `manifest/manifest.zip` from your project directory
5. Wait **5–10 minutes** for propagation

**Verify upload:**

```powershell
# Using app-only token with AppCatalog.ReadWrite.All
$apps = Invoke-RestMethod `
    "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?`$filter=distributionMethod eq 'organization'" `
    -Headers @{ "Authorization" = "Bearer $appToken" }
$apps.value | Where-Object { $_.displayName -like "*YourAgentName*" }
# Should show: publishingState = published
```

---

## 10. Step 8 — Teams Developer Portal Configuration (Manual — browser required)

**Without this step, the agent cannot receive messages from Teams/M365.**

1. Get your blueprint ID:
   ```powershell
   a365 config display -g
   # Copy the agentBlueprintId value
   ```

2. Navigate directly to:
   ```
   https://dev.teams.microsoft.com/tools/agent-blueprint/<agentBlueprintId>/configuration
   ```

3. Set:
   - **Agent Type:** `Bot Based`
   - **Bot ID:** `<agentBlueprintId>` (same GUID)

4. Click **Save**

> The Teams Developer Portal has no public REST API — this configuration must be done via the browser UI.

---

## 11. Step 9 — Create Agent Instance

Agent 365 blueprints use a **request → approve → create** model, unlike regular Teams apps.

### Discovery path

Agent 365 blueprints do NOT appear in the regular Teams Apps search bar. They appear in:
- **M365 Copilot** → Apps → search by name ← **This worked reliably**
- Teams → Apps → "Agents for your team" category ← may have propagation delay

### Flow

1. In **M365 Copilot**, search for your agent blueprint name
2. Click **"Request"** (sends request to admin)
3. As admin, approve at: **https://admin.cloud.microsoft/#/agents/all/requested**
4. Return to M365 Copilot → find the blueprint → click **"Create"**
5. Enter instance name (no spaces/special characters), configure → **Save**
6. Agent user is created asynchronously in Entra (`UPN.<name>@<tenant>`) — takes 5–15 min
7. Agent becomes searchable in Teams chat after user creation

---

## 12. Errors Encountered & Fixes

### Error 1: Wrong SDK (`@microsoft/teams.apps`)

**Symptom:** Deployed successfully with `atk` CLI but no Agent 365 identity, blueprint, or governance  
**Root cause:** Used Teams SDK instead of Agent 365 SDK  
**Fix:** Full teardown + rebuild with `@microsoft/agents-hosting` and `a365` CLI  
**Lesson:** Agent 365 SDK ≠ Teams SDK ≠ M365 Agents SDK — these are three distinct things

---

### Error 2: `tsc: not found` during Oryx build

**Symptom:**
```
npm run build
> tsc
sh: tsc: not found
```
**Root cause:** `typescript` was in `devDependencies`. Azure Oryx remote build only runs `npm install --production`, skipping devDeps.  
**Fix:** Move `typescript` from `devDependencies` to `dependencies` in `package.json`.

---

### Error 3: App binds to `localhost` on Azure (exit code 137 / timeout)

**Symptom:** App Service startup probe times out, container exits  
**Root cause:** App listening on `localhost:3978` — not accessible from Azure's load balancer  
**Fix:**
```typescript
// WRONG
server.listen(3978, 'localhost', ...)

// CORRECT — always bind to 0.0.0.0 in production
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');
server.listen(port, host, ...)
```
Also set `NODE_ENV=production` in `.env`

---

### Error 4: F1 (Free) App Service tier — 230-second startup timeout

**Symptom:** `a365 setup all` creates F1 tier by default. Container startup times out at 230s before `node dist/index.js` is ready.  
**Root cause:** F1 tier cold-start timeout is 230s — insufficient for Node.js + Oryx remote build on shared resources  
**Fix:** Upgrade to B1:
```powershell
az appservice plan update \
  --name <plan-name> \
  --resource-group <rg> \
  --sku B1
```
> Set `appServicePlanSku: "B1"` in `a365.config.json` from the start to avoid this entirely.

---

### Error 5: `SCM_DO_BUILD_DURING_DEPLOYMENT=false` + missing `node_modules`

**Symptom:** After disabling Oryx to work around Error 2, Azure App Service had no `node_modules` and exited with code 127  
**Root cause:** Disabling Oryx also disables `npm install`. Without `node_modules`, `node dist/index.js` can't find any packages.  
**Fix:** Don't disable Oryx — fix the root cause (Error 2) by moving `typescript` to `dependencies` instead.

---

### Error 6: Old `oryx-manifest.toml` blocking redeployments

**Symptom:** App exits with code 127 after redeployment; container can't find startup command  
**Root cause:** Previous failed `a365 deploy` left a malformed `oryx-manifest.toml` on the App Service filesystem  
**Fix:** Upgrade App Service tier (triggers fresh container instance) or delete via Kudu VFS API  
```powershell
# Kudu VFS delete (requires Basic Auth enabled on App Service)
Invoke-RestMethod \
  -Uri "https://<webapp>.scm.azurewebsites.net/api/vfs/site/wwwroot/oryx-manifest.toml" \
  -Method DELETE \
  -Headers @{ Authorization = "Basic <base64 username:password>" }
```

---

### Error 7: `AgentIdentityBlueprint.*` permissions disappear after "Grant admin consent"

**Symptom:** `a365 config init` fails with missing permissions after granting admin consent via Entra portal  
**Root cause:** The Entra admin center "Grant admin consent" button calls Graph API `oauth2PermissionGrants`, which only recognises non-beta permissions. Beta permissions previously granted via `appRoleAssignments` are removed in the process.  
**Fix:** Never use the Entra portal consent button for this app. Grant all permissions via Graph API `appRoleAssignments` (Option B) and leave them alone.

---

### Error 8: `Directory.AccessAsUser.All` rejected by Agent APIs

**Symptom:**
```json
"Agent APIs do not support calls that include the Directory.AccessAsUser.All permission"
```
**Root cause:** Delegated tokens from `az account get-access-token` include `Directory.AccessAsUser.All`. Agent ID API endpoints explicitly block this.  
**Fix:** Use app-only (client credentials) tokens for any Agent API calls. The `a365` CLI handles this correctly internally.

---

### Error 9: Teams app catalog API rejects Agent 365 manifests

**Symptom:** `POST /v1.0/appCatalogs/teamsApps` returns `Forbidden` even with `AppCatalog.ReadWrite.All`  
**Root cause:** The standard Teams app catalog API does not support `manifestVersion: devPreview` (Agent 365 blueprint format)  
**Fix:** Upload via M365 Admin Center UI at `https://admin.cloud.microsoft/#/agents/all` — there is no programmatic API for this in the preview.

---

### Error 10: `a365 deploy` reports failure but app is actually running

**Symptom:** CLI exits with "Site failed to start within 10 mins" but health endpoint returns 200  
**Root cause:** The CLI was polling a deployment ID from a run started on the F1 tier, before the B1 upgrade. The subsequent startup on B1 succeeded but the CLI's polling loop had already failed.  
**Fix:** Always check the health endpoint independently. The deployment itself was fine — the CLI's polling was tracking an old failed deployment ID.

---

### Error 11: `@types/express` in both `dependencies` AND `devDependencies`

**Symptom:**
```
src/index.ts(15,35): error TS7016: Could not find a declaration file for module 'express'.
```
Despite `@types/express` appearing in `dependencies`, Oryx's `npm install` + `tsc` still fails.

**Root cause:** When the same package (`@types/express`, `@types/node`) appears in both `dependencies` and `devDependencies` with different version ranges, npm deduplication behaves unpredictably. Oryx's remote build ends up with the package unresolved.

**Fix:** Remove all `@types/*` packages from `devDependencies` entirely — keep them only in `dependencies`:
```json
// WRONG — same package in both sections
"dependencies": { "@types/express": "^4.17.21" },
"devDependencies": { "@types/express": "*" }

// CORRECT — only in dependencies
"dependencies": { "@types/express": "^4.17.21" },
"devDependencies": {}
```

---

### Error 12: GPT-5 API incompatibilities (400 Bad Request — silent)

**Symptom:** Morgan responds "encountered an error" in Teams. No error visible in Azure App Service docker logs. Health endpoint is fine.

**Root cause:** Three GPT-5 incompatibilities cause silent 400s from Azure OpenAI:
1. `apiVersion: '2024-08-01-preview'` — too old for GPT-5 (reasoning models need `2025-04-01-preview`)
2. `max_tokens: 2000` — renamed to `max_completion_tokens` for reasoning models
3. `temperature: 0.3` — GPT-5 only supports the default value (1); any override causes 400

**Fix:**
```typescript
const openai = new AzureOpenAI({
  apiVersion: '2025-04-01-preview',  // ← updated
  ...
});

await openai.chat.completions.create({
  model: 'gpt-5',
  messages,
  max_completion_tokens: 4000,  // ← renamed from max_tokens
  // temperature removed entirely
});
```

---

### Error 13: AADSTS82001 — MCP gateway rejects app-only tokens

**Symptom:**
```
[MCP] Failed to discover servers: unauthorized_client: AADSTS82001:
Agentic application 'f9fb9ca0...' is not permitted to request app-only tokens
for resource 'ea9ffc3e-8a23-4a7d-836d-234d7c7565c1'.
```

**Root cause:** The Work IQ MCP gateway explicitly blocks app-only (client credentials) tokens. It requires a **delegated OBO token** from a user session. The `ClientSecretCredential` fallback in `mcpToolSetup.ts` was being used when `TurnContext` wasn't threaded through.

**Fix:** Thread `TurnContext` from the agent message handler all the way into every MCP call:
- `agent.ts` → pass `context` to `executeTool(name, params, context)`
- `tools/index.ts` → `executeTool` accepts optional `context?: TurnContext`, passes to all MCP wrappers
- `mcpToolSetup.ts` → all exported functions accept `context?: TurnContext`, call `buildToolDefinitions(context)` before `invokeMcpTool`
- `getServerConfigs(context)` uses `mcpService.listToolServers(context, agentApplication.authorization, 'AgenticAuthConnection')` when context is present

---

### Error 14: Teams markdown tables render as garbled text

**Symptom:** Budget vs actuals table appears as: `Budget vs Actuals | Category | Budget | Actual | ---------|---------...` all on one line.

**Root cause:** Teams bot message rendering does NOT support markdown tables (`|col|col|` pipe syntax). Only Teams Adaptive Cards and tab pages render tables — not chat messages.

**Fix:**
1. Add to system prompt: "NEVER use markdown tables — Teams does not render them"
2. Add `convertMarkdownTables()` utility in `reportTools.ts` that transforms pipe tables to bold-label lines
3. Call it inside `formatForTeams()` before sending

```typescript
// Before: | Revenue | $4.94M | $4.88M |
// After:  **Revenue** · Budget: $4.94M · Actual: $4.88M
function convertMarkdownTables(md: string): string {
  return md.replace(
    /^\|(.+)\|\r?\n\|[-|: ]+\|\r?\n((?:^\|.+\|\r?\n?)*)/gm,
    (fullMatch) => { /* parse headers + rows → bold-label lines */ }
  );
}
```

---

---

## 17. Cassidy — Autonomous Operations Manager (Third Deployment)

### Overview

Cassidy is the third Synthetic Worker deployed. She is an **autonomous, agentic** enterprise Operations Manager with:
- **GPT-5** agentic loop (manual while loop with tool calling)
- 6 native operations tools (overdue tasks, team workload, backlog prioritisation, pending approvals, standup reports, project status)
- 7 Work IQ MCP tools (Teams, Mail, Planner create/update, Calendar, SharePoint Lists)
- Proactive 30-min overdue task alerts ("start notifications")
- Daily ops standup (Mon–Fri 9am AEST) and weekly project summary (Monday) via Azure Logic Apps
- Multi-agent ready (`/api/agent-messages` endpoint for A2A)
- Express server with 4 endpoints: `/api/health`, `/api/messages`, `/api/scheduled`, `/api/agent-messages`

### Key Credentials

| Item | Value |
|------|-------|
| Blueprint ID | `151d7bf7-772f-489b-b407-a8541f3eb7a6` |
| Web App | `cassidyopsagent-webapp.azurewebsites.net` |
| M365 UPN | `cassidy@ABSx02771022.onmicrosoft.com` (pending instance creation) |
| Managed Identity | `b67995a8-a408-413e-973e-0e23d227ba50` |
| Resource Group | `rg-cassidy-ops-agent` (australiaeast) |
| Azure OpenAI | `oai-zava-signal-intel` (shared with Morgan / Hello World) |
| Ops Teams Channel | `19:0de58db237834ea1bb59a2aeb56b29e9@thread.tacv2` (shared channel — update to Ops channel once created) |
| Scheduled Secret | `cassidy-sched-2026-ops` |
| Logic App (daily standup) | `cassidy-daily-standup` (Mon–Fri 22:00 UTC = 9am AEST) |
| Logic App (weekly summary) | `cassidy-weekly-summary` (Sun 22:00 UTC = Mon 9am AEST) |
| Source | `c:\Users\graham\Documents\GitHub\Cassidy Autonomous\cassidy\` |

### Completed Automated Steps

All automated steps have been completed:

1. ✅ **Entra Blueprint** — Created (`151d7bf7-772f-489b-b407-a8541f3eb7a6`) via `a365 setup all`
2. ✅ **Azure App Service** — `cassidyopsagent-webapp` (B1, australiaeast) deployed and healthy
3. ✅ **MCP permissions** — All 11 Graph scopes + McpServersMetadata via `a365 setup permissions custom + mcp + bot`
4. ✅ **`a365 deploy`** — Health endpoint returns `200 {"status":"healthy","agent":"Cassidy"}`
5. ✅ **manifest.zip** — Published at `cassidy/manifest/manifest.zip` (name.short: "Cassidy")
6. ✅ **Scheduled endpoint** — `/api/scheduled` returns `200 standup_complete` when called with correct secret
7. ✅ **Logic Apps** — `cassidy-daily-standup` (Mon–Fri) and `cassidy-weekly-summary` (Mon) created in Azure

### Pending Manual Steps

1. ⬜ **Upload manifest** — `cassidy\manifest\manifest.zip` → https://admin.cloud.microsoft/#/agents/all → "Upload custom agent"
2. ⬜ **Teams Dev Portal** — https://dev.teams.microsoft.com/tools/agent-blueprint/151d7bf7-772f-489b-b407-a8541f3eb7a6/configuration → Agent Type: Bot Based, Bot ID: `151d7bf7-772f-489b-b407-a8541f3eb7a6`
3. ⬜ **Create instance** — M365 Copilot → Apps → search "Cassidy" → Request → Approve → Create → name: `cassidy`

### Manifest Fix Note

The initial manifest generated by `a365 publish` used em dashes (`—`) in the `name.full` and `description.full` fields. The M365 Admin Center rejected these as non-ASCII. Fixed by replacing with plain hyphens (`-`) and repackaging with `Compress-Archive`.

### GPT-5 + Agent Framework Notes

Identical to Morgan — see [Section 16 GPT-5 Compatibility](#740) for API version, `max_completion_tokens`, no temperature rules.

---

### Overview

Morgan is the second Synthetic Worker deployed after Hello World. It is an **autonomous, agentic** finance analyst with:
- **GPT-5** agentic loop (manual while loop with tool calling)
- 8 native finance tools (budget analysis, variance, anomaly detection, report generation)
- 11 Work IQ MCP servers (Mail, Teams, SharePoint, OneDrive, Excel, Word, Calendar, Planner, Knowledge, SharePointLists, ODSP)
- Scheduled autonomous briefings (Monday 8am AEST P&L summary via `/api/scheduled`)
- Multi-agent ready (`/api/agent-messages` endpoint for A2A)
- Express server with 4 endpoints: `/api/health`, `/api/messages`, `/api/scheduled`, `/api/agent-messages`

### Key Credentials

| Item | Value |
|------|-------|
| Blueprint ID | `f9fb9ca0-04a2-4e4a-9344-c7f329313bcf` |
| Web App | `morganfinanceagent-webapp.azurewebsites.net` |
| M365 UPN | `morganfinanceagent@ABSx02771022.onmicrosoft.com` |
| Managed Identity | `894aeeb3-6022-4257-b005-f91d6d1c3022` |
| Resource Group | `rg-morgan-finance-agent` (australiaeast) |
| Azure OpenAI | `oai-zava-signal-intel` (shared with Hello World) |
| Finance Teams Channel | `19:0de58db237834ea1bb59a2aeb56b29e9@thread.tacv2` (Accounting and Finance, Operations Dept team `a4963ea8-eb95-4b66-a7f8-82ecb87a8a14`) |

### Completed Manual Steps

All manual steps have been completed:

1. ✅ **Admin consent for Graph permissions** — Granted 13 delegated Graph scopes via `a365 setup permissions custom` using `customBlueprintPermissions` in `a365.config.json`
2. ✅ **Upload manifest** — `manifest/manifest.zip` (v1.1.5) uploaded to `https://admin.cloud.microsoft/#/agents/all`
3. ✅ **Teams Developer Portal** — Bot ID set at `https://dev.teams.microsoft.com/tools/agent-blueprint/f9fb9ca0.../configuration`
4. ✅ **Create instance** — Instance created via M365 Copilot → "morganfinanceagent"
5. ✅ **Finance Teams Channel ID** — Set in `.env` (Accounting and Finance channel, Operations Department team)
6. ✅ **MCP permissions** — All 11 servers granted via `a365 setup permissions mcp`
7. ✅ **Bot permissions** — `a365 setup permissions bot` confirmed

### GPT-5 Compatibility (critical — applies to all future reasoning models)

GPT-5 is a reasoning model with different API requirements:

```typescript
// WRONG — GPT-5 will return 400 Bad Request
apiVersion: '2024-08-01-preview'   // too old
max_tokens: 2000                    // unsupported — use max_completion_tokens
temperature: 0.3                    // unsupported — only default (1) allowed

// CORRECT
apiVersion: '2025-04-01-preview'
max_completion_tokens: 4000
// no temperature field at all
```

GPT-5 also returns **empty content** (`finish_reason: 'stop'` with `message.content === null`) after tool use if it considers the tools sufficient. The agent loop must handle this:

```typescript
if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
  const content = choice.message.content?.trim();
  if (content) { reply = content; break; }
  // Re-prompt once for summary; don't silently swallow
  messages.push({ role: 'user', content: 'Please summarise what you found or did.' });
  continue;
}
```

### Teams Formatting Rules (critical)

**Teams bot messages do NOT render markdown tables.** Pipe-separated table syntax (`| Col | Col |`) appears as garbled inline text. Always:
- Convert tables to bold-label lines: `**Revenue**: $4.88M · Budget: $4.94M · Variance: -$59.6k (-1.21%) 🟢`
- Flatten headings (`#`, `##`) to `**bold**`
- Replace `---` dividers with unicode line chars `─────────`
- Instruct the model explicitly in system prompt: "NEVER use markdown tables"

See `reportTools.ts` → `convertMarkdownTables()` for the working implementation.

### MCP Authentication Architecture (OBO required)

The Work IQ MCP gateway (`ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`) **rejects app-only tokens** (AADSTS82001). It requires **delegated OBO tokens** — on-behalf-of the signed-in user.

**Critical pattern:** Pass `TurnContext` all the way from the agent loop into every MCP call:

```typescript
// agent.ts — pass context to tool executor
const result = await executeTool(toolCall.function.name, params, context);

// tools/index.ts — pass to MCP wrappers
case 'sendTeamsMessage':
  result = await sendTeamsMessage(params, context);

// mcpToolSetup.ts — use context for OBO in listToolServers
const configs = await mcpService.listToolServers(
  context,                        // ← TurnContext enables OBO
  agentApplication.authorization,
  'AgenticAuthConnection',
);
```

Without `TurnContext`, the fallback uses `ClientSecretCredential` (app-only) which is blocked by AADSTS82001.

### `customBlueprintPermissions` Config Format

The `a365 setup permissions custom` command reads from `a365.config.json`:

```json
{
  "customBlueprintPermissions": [
    {
      "resourceAppId": "00000003-0000-0000-c000-000000000000",
      "resourceName": "Microsoft Graph",
      "scopes": [
        "Mail.ReadWrite", "Mail.Send", "User.Read", "Sites.ReadWrite.All",
        "Chat.ReadWrite", "ChannelMessage.Send", "Files.ReadWrite.All",
        "Calendars.ReadWrite", "Tasks.ReadWrite", "Notes.ReadWrite.All"
      ]
    }
  ]
}
```

These are **delegated** scopes (inherited by agent instances at runtime via OBO). The CLI's internal property name is `CustomBlueprintPermissions` → JSON key `customBlueprintPermissions`.

### Agentic Loop Pattern (Correct for openai v6 + GPT-5)

```typescript
const messages: ChatCompletionMessageParam[] = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: userMessage }
];

for (let i = 0; i < 10; i++) {
  const response = await openai.chat.completions.create({
    model: 'gpt-5',
    messages,
    tools: getAllTools(),
    tool_choice: 'auto',
    max_completion_tokens: 4000,   // NOT max_tokens
    // NO temperature field for GPT-5
    apiVersion: '2025-04-01-preview',
  });

  const choice = response.choices[0];
  messages.push(choice.message as ChatCompletionMessageParam);

  if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
    const content = choice.message.content?.trim();
    if (content) { reply = content; break; }
    // GPT-5: empty content after tools → ask for summary
    messages.push({ role: 'user', content: 'Please summarise what you found or did.' });
    continue;
  }

  // Execute tool calls in parallel, pass TurnContext for OBO
  const results = await Promise.all(choice.message.tool_calls.map(async tc => ({
    role: 'tool' as const,
    tool_call_id: tc.id,
    content: await executeTool(tc.function.name, JSON.parse(tc.function.arguments), context),
  })));
  messages.push(...results);
}
```

### MCP Live Catalog

- **Endpoint**: `https://agent365.svc.cloud.microsoft`
- **Audience**: `ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`
- **18 servers available** (as of 2026-03-16): MailTools, TeamsServer, SharePointRemoteServer, SharePointListsTools, ODSPRemoteServer, OneDriveRemoteServer, ExcelServer, WordServer, CalendarTools, PlannerServer, KnowledgeTools, M365Copilot, DASearch, Admin365_GraphTools, AdminTools, W365ComputerUse + 2 canary variants
- **11 configured for Morgan**: Mail, Teams, SharePoint (×2), ODSP, OneDrive, Excel, Word, Calendar, Planner, Knowledge

---


| Gotcha | Detail |
|--------|--------|
| **Frontier enrollment required** | Tenant must be enrolled. CLI shows a WARNING (non-fatal) if it can't auto-verify. Commands still work if enrolled. |
| **Instance discovery is via M365 Copilot, not Teams Apps** | Agent 365 blueprints don't appear in the Teams Apps search bar until after an instance is created. Discover them in M365 Copilot first. |
| **Instance creation is async** | After clicking "Create", the Entra user takes 5–15 min to propagate. Agent won't appear in Teams chat until then. |
| **`a365 publish` ≠ auto-upload** | In v1.1.115-preview, `a365 publish` creates `manifest.zip` only — it does NOT upload it. The AI-guided setup docs imply otherwise (documentation gap). |
| **`a365 config.json` has `appServicePlanSku: "F1"` by default** | Always change to `"B1"` or higher before running `a365 setup all`. F1 cold start timeout is too short for Node.js. |
| **Agent 365 blueprint app secret** | `MicrosoftAppPassword` in `.env` is the blueprint app's client secret (not the CLI app's secret). They are separate Entra apps. |
| **GitHub issue #303** | Official docs show a broken Express pattern (returning reply object). Use `CloudAdapter.process()` instead — see the correct pattern in Step 2 above. |
| **`a365.generated.config.json`** | Contains DPAPI-encrypted client secret — do NOT commit to source control. Add to `.gitignore`. |

---

## 14. Reference Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        DEVELOPER MACHINE                        │
│                                                                 │
│  a365 CLI (dotnet global tool)                                  │
│    ├── a365 config init  → creates a365.config.json             │
│    ├── a365 setup all    → provisions Azure + Entra blueprint   │
│    ├── a365 deploy       → builds + zip deploys to App Service  │
│    └── a365 publish      → creates manifest.zip                 │
└─────────────────────┬───────────────────────────────────────────┘
                      │
          ┌───────────▼────────────┐
          │      AZURE             │
          │                        │
          │  Resource Group        │
          │  └── App Service Plan  │  (B1 minimum)
          │      └── Web App       │  helloworldagent-webapp
          │          ├── /api/health    (no auth)
          │          └── /api/messages (JWT auth via CloudAdapter)
          └───────────┬────────────┘
                      │  Bot Framework messaging
          ┌───────────▼────────────┐
          │    MICROSOFT ENTRA     │
          │                        │
          │  CLI App Registration  │  Agent365-CLI-Client
          │  Agent Identity App    │  HelloWorldAgent Identity
          │  Agent Blueprint App   │  HelloWorldAgent Blueprint
          │    └── MicrosoftAppId  │  (used by CloudAdapter for JWT)
          └───────────┬────────────┘
                      │
          ┌───────────▼────────────┐
          │     M365 TENANT        │
          │                        │
          │  Admin Center          │  admin.cloud.microsoft
          │  └── Agents catalog    │  ← upload manifest.zip here
          │                        │
          │  Teams Dev Portal      │  dev.teams.microsoft.com
          │  └── Blueprint config  │  ← set Bot Based + Bot ID here
          │                        │
          │  M365 Copilot          │  ← discover + create instance here
          │  └── Agent Instance    │  → Entra user UPN.xxx@tenant
          │                        │
          │  Teams Chat            │  ← talk to agent here
          └────────────────────────┘
```

---

## 15. Official Sources

| Resource | URL |
|----------|-----|
| Agent 365 Developer Overview | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/ |
| Agent 365 CLI Reference | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli |
| CLI Command Reference | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/reference/cli/ |
| Custom Client App Registration | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/custom-client-app-registration |
| Development Lifecycle | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/a365-dev-lifecycle |
| Publish to Admin Center | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish |
| Create Agent Instances | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance |
| Onboard Agents (end-user flow) | https://learn.microsoft.com/en-us/microsoft-agent-365/onboard |
| AI-Guided Setup Instructions | https://learn.microsoft.com/en-us/microsoft-agent-365/developer/ai-guided-setup |
| AI-Guided Setup Instruction File | https://raw.githubusercontent.com/microsoft/Agent365-devTools/main/docs/agent365-guided-setup/a365-setup-instructions.md |
| Agent365-devTools GitHub Repo | https://github.com/microsoft/Agent365-devTools |
| Agent365-devTools GitHub Issues | https://github.com/microsoft/Agent365-devTools/issues |
| NuGet — CLI Package | https://www.nuget.org/packages/Microsoft.Agents.A365.DevTools.Cli |
| Entra Agent Blueprint | https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-blueprint |
| Frontier Preview Program | https://adoption.microsoft.com/copilot/frontier-program/ |
| Upload Agents to Admin Center | https://learn.microsoft.com/en-us/copilot/microsoft-365/agent-essentials/agent-lifecycle/agent-upload-agents |
| Teams Developer Portal | https://dev.teams.microsoft.com |
| M365 Admin Center — Agents | https://admin.cloud.microsoft/#/agents/all |
| M365 Admin Center — Requested Agents | https://admin.cloud.microsoft/#/agents/all/requested |

---

## Quick Reference — Deployment Checklist

```
PRE-FLIGHT
□ Frontier preview enrollment confirmed for tenant
□ dotnet 8.0+ installed
□ Azure CLI installed + logged in to correct tenant/subscription
□ Node.js 18+ installed
□ a365 CLI installed (dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease)

AUTOMATED (run in sequence)
□ Create Entra CLI app + grant 5 permissions via Graph API (Option B)
□ Build agent code (typescript in dependencies, bind to 0.0.0.0)
□ a365 config init  (use B1 SKU, not F1)
□ a365 setup all
□ a365 deploy
□ Verify health: GET /api/health → 200
□ a365 publish  → creates manifest/manifest.zip

MANUAL (one browser session as Global Admin)
□ Upload manifest.zip at admin.cloud.microsoft/#/agents/all
□ Configure Teams Dev Portal: dev.teams.microsoft.com/tools/agent-blueprint/<blueprintId>/configuration
  → Agent Type: Bot Based, Bot ID: <blueprintId>

END-USER (M365 Copilot)
□ Search for agent blueprint → Request
□ Admin approves request
□ Create instance (give it a name)
□ Wait 5–15 min for Entra user provisioning
□ Test in Teams chat
```
