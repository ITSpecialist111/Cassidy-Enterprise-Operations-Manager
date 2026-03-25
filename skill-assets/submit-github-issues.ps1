#!/usr/bin/env pwsh
# =============================================================================
# Submit 5 GitHub issues to microsoft/Agent365-devTools
#
# Prerequisites:
#   1. GitHub CLI installed (gh --version)
#   2. Logged in: gh auth status
#   3. SAML SSO authorized for microsoft org:
#      gh auth refresh --scopes repo
#      OR manually visit: https://github.com/settings/tokens
#      → Configure SSO → Authorize for "microsoft" org
#
# Usage:
#   ./submit-github-issues.ps1
#
# To submit a single issue:
#   ./submit-github-issues.ps1 -IssueFilter A
# =============================================================================

param(
    [ValidateSet("A","B","C","D","E","All")]
    [string]$IssueFilter = "All"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = "microsoft/Agent365-devTools"

# Verify auth before starting
Write-Host "Checking GitHub CLI auth..." -ForegroundColor Cyan
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged in to GitHub CLI. Run: gh auth login"
    exit 1
}
Write-Host "Auth OK" -ForegroundColor Green

function Submit-Issue {
    param([string]$Title, [string]$Body, [string[]]$Labels, [string]$Id)
    Write-Host "`nSubmitting Issue $Id..." -ForegroundColor Yellow
    $labelArgs = $Labels | ForEach-Object { "--label"; $_ }
    $url = gh issue create --repo $repo --title $Title --body $Body @labelArgs 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] $url" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $url" -ForegroundColor Red
        if ($url -match "SAML") {
            Write-Host "  SAML SSO not authorized. Run: gh auth refresh --scopes repo" -ForegroundColor Red
            Write-Host "  Then visit the URL printed and authorize for the 'microsoft' org" -ForegroundColor Red
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# ISSUE A
# ─────────────────────────────────────────────────────────────────────────────
$issueATitle = "[Bug][Docs] ``a365 publish`` does not publish — contradiction between CLI reference and AI-guided setup instructions"
$issueABody = @'
## Description

There is a direct contradiction between two official sources regarding what `a365 publish` does in v1.1.115-preview:

**Source 1 — CLI reference docs** (`/developer/reference/cli/publish`):
> "Update the ID values in manifest.json and create a manifest.zip package for uploading to the Microsoft 365 admin center. After running this command, follow the printed instructions to upload the package through the Microsoft 365 admin center."

**Source 2 — AI-guided setup instructions** (`a365-setup-instructions.md`, Step 5):
> "It then publishes the agent manifest/package to your tenant's catalog (so that the agent can be 'hired' or installed in Teams and other apps)."

The CLI reference is correct — `a365 publish` only creates `manifest.zip` and prints instructions. It does NOT upload to the admin center.

Additionally, attempting to automate the upload via the Graph API `POST /v1.0/appCatalogs/teamsApps` returns `Forbidden` even with `AppCatalog.ReadWrite.All` application permission granted:
```
"User not authorized to perform this operation. UserId: '55d8545b-0bb2-4eeb-816a-6b3a32578e84'"
```
The user ID resolves to the **Microsoft Teams Graph Service** service principal — indicating the Agent 365 blueprint format (`manifestVersion: devPreview`) is rejected by the standard Teams app catalog API. There is no programmatic API for this upload in the current preview.

## Expected Behavior

One of the following:
1. `a365 publish` should auto-upload `manifest.zip` to the M365 Admin Center (preferred)
2. OR `a365-setup-instructions.md` Step 5 should be corrected to say "creates manifest.zip" not "publishes to catalog"

## SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

## Language/Runtime
Node.js v22.15.0

## OS
Windows 11

## How to Reproduce
1. Complete `a365 setup all` successfully
2. Run `a365 publish` — observe it creates `manifest/manifest.zip` and prints manual upload instructions
3. Attempt programmatic upload: `POST https://graph.microsoft.com/v1.0/appCatalogs/teamsApps` with `Content-Type: application/zip` using an app-only token with `AppCatalog.ReadWrite.All`
4. Observe `Forbidden` response

## Output
```
Package created: C:\...\manifest\manifest.zip
To publish: https://admin.microsoft.com > Agents > All agents > Upload custom agent
```

### Code of Conduct
- [x] I agree to follow the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
'@

# ─────────────────────────────────────────────────────────────────────────────
# ISSUE B
# ─────────────────────────────────────────────────────────────────────────────
$issueBTitle = "[Bug] ``a365 config init`` defaults to F1 App Service tier which causes guaranteed cold-start timeout on Node.js deployments"
$issueBBody = @'
## Description

When `a365 config init` runs interactively, it sets `appServicePlanSku: "F1"` in the generated `a365.config.json`. The F1 (Free) tier has an Azure App Service container startup timeout of **230 seconds**.

A Node.js agent deployed with `a365 deploy` (using Oryx remote build) consistently takes longer than 230s to start on F1 because:
1. Oryx runs `npm install` + `npm run build` (TypeScript compilation) inside the container on first start
2. F1 runs on shared, low-resource infrastructure

This causes `a365 deploy` to report failure with no clear indication that the tier is the root cause:
```
[Azure] Status: Starting the site... Time: 230(s)
[Azure] ERROR: Deployment failed because the site failed to start within 10 mins.
[Azure] InprogressInstances: 0, SuccessfulInstances: 0, FailedInstances: 1
```

The app starts successfully after upgrading to B1 — the code itself is not the issue.

## Expected Behavior

One of the following:
1. CLI should default to `B1` for the `needDeployment: true` path
2. OR CLI should warn during `a365 setup all`: "F1 tier has a 230s cold-start limit — B1 or higher recommended for Node.js agents"
3. OR `a365 deploy` failure message should hint that upgrading the App Service Plan tier may resolve the timeout

## SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

## Language/Runtime
Node.js v22.15.0

## OS
Windows 11

## How to Reproduce
1. Run `a365 config init` interactively — accept default SKU (F1)
2. Run `a365 setup all`
3. Build a standard Node.js + TypeScript agent
4. Run `a365 deploy`
5. Observe site consistently fails to start within 230s timeout

## Workaround
```powershell
az appservice plan update --name <plan-name> --resource-group <rg> --sku B1
```
Or set `"appServicePlanSku": "B1"` in `a365.config.json` before running `a365 setup all`.

### Code of Conduct
- [x] I agree to follow the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
'@

# ─────────────────────────────────────────────────────────────────────────────
# ISSUE C
# ─────────────────────────────────────────────────────────────────────────────
$issueCTitle = "[Bug][Docs] Entra portal 'Grant admin consent' button silently deletes AgentIdentityBlueprint.* beta permissions — no warning in docs"
$issueCBody = @'
## Description

The custom client app registration requires two beta Graph permissions not visible in the Entra admin center UI:
- `AgentIdentityBlueprint.ReadWrite.All`
- `AgentIdentityBlueprint.UpdateAuthProperties.All`

The official docs correctly recommend granting these via Graph API `appRoleAssignments` (Option B). However, the docs contain **no warning** about a critical destructive interaction:

**If a Global Admin clicks "Grant admin consent" in the Entra portal AFTER using Option B, it silently deletes both `AgentIdentityBlueprint.*` permissions.**

This happens because the portal consent button calls `POST /oauth2PermissionGrants` which only processes permissions visible in the Entra UI — the beta `appRoleAssignments` are not included and are removed in the process.

The result is the CLI app loses its most critical permissions with no error or warning. Subsequent `a365` commands fail with:
```
[ERR] Failed to create blueprint. Status: Forbidden
```
There is no indication that the permissions were deleted. A developer must manually re-run the Graph API grants to recover, with no documentation pointing to this as the cause.

## Expected Behavior

The [Custom client app registration](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/custom-client-app-registration) docs should include a prominent warning:

> ⚠️ **Do NOT click "Grant admin consent" in the Microsoft Entra admin center** for this app registration after completing Option B. The portal's consent mechanism does not recognise beta permissions and will remove the `AgentIdentityBlueprint.*` grants. Manage all permissions exclusively via the Graph API `appRoleAssignments` endpoint.

## SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

## OS
Windows 11

## How to Reproduce
1. Complete Option B — grant all 5 permissions via `POST /v1.0/servicePrincipals/{id}/appRoleAssignments`
2. Verify `AgentIdentityBlueprint.*` grants exist in `appRoleAssignments`
3. Open Entra admin center > App registrations > CLI app > API permissions
4. Click "Grant admin consent for [tenant]" and confirm
5. Re-check `appRoleAssignments` — `AgentIdentityBlueprint.*` grants are now gone

### Code of Conduct
- [x] I agree to follow the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
'@

# ─────────────────────────────────────────────────────────────────────────────
# ISSUE D
# ─────────────────────────────────────────────────────────────────────────────
$issueDTitle = "[Bug][Docs] Agent 365 blueprint not discoverable in Teams Apps after publishing — only visible via M365 Copilot during Frontier preview"
$issueDBody = @'
## Description

The [Create agent instances](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance) and [Onboard agents](https://learn.microsoft.com/en-us/microsoft-agent-365/onboard) docs state agents appear in:
> "Microsoft 365 Copilot Store under **Agents for your team** or in the **Apps** area in Microsoft Teams"

After completing all steps correctly — admin center upload ✅, Teams Developer Portal configured (Bot Based + Bot ID) ✅, app confirmed `publishingState: published` in Graph API — the blueprint does **not** appear in:
- Teams > Apps > search by name
- Teams > Apps > "Agents for your team" category (category not visible)

The blueprint **is** discoverable and instantiable via:
- M365 Copilot > Apps > search by name ✅

After creating an instance via M365 Copilot, the resulting agent user then becomes accessible in Teams chat.

Without knowing this, developers assume their deployment is broken and spend significant time troubleshooting a working deployment.

## Expected Behavior

Either:
1. Blueprint should appear in Teams Apps search as documented
2. OR docs should clarify that during Frontier preview, the primary discovery path is **M365 Copilot** (not Teams Apps), and Teams visibility follows after instance creation

## SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

## OS
Windows 11 / Teams desktop (latest)

## How to Reproduce
1. Complete full deployment: `a365 setup all` → `a365 deploy` → `a365 publish` → upload manifest.zip to admin center → configure Teams Dev Portal
2. Confirm `publishingState: published` via `GET /v1.0/appCatalogs/teamsApps?$filter=distributionMethod eq 'organization'`
3. Open Teams desktop → Apps → search for blueprint display name → not found
4. Open M365 Copilot → Apps → search same name → found, Request/Create available

### Code of Conduct
- [x] I agree to follow the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
'@

# ─────────────────────────────────────────────────────────────────────────────
# ISSUE E
# ─────────────────────────────────────────────────────────────────────────────
$issueETitle = "[Bug][Docs] Node.js Oryx remote build fails when TypeScript is in devDependencies — standard npm practice breaks ``a365 deploy``"
$issueEBody = @'
## Description

`a365 deploy` uses Azure App Service Oryx for remote builds. Oryx runs `npm install --production`, which deliberately skips `devDependencies`.

If `typescript` / `tsc` is in `devDependencies` — which is **standard npm practice** and how most Node.js projects are structured — the Oryx build fails with:
```
npm run build
> tsc
sh: tsc: not found
npm ERR! code 127
```

This causes `a365 deploy` to report the site failed to start, with no indication that a missing `tsc` binary is the root cause. The error manifests as a startup failure, not a build failure, making it very difficult to diagnose.

The standard Node.js project scaffold (and likely the official quickstart templates) places `typescript` in `devDependencies` by convention — making the default project structure incompatible with `a365 deploy` on Azure App Service out of the box.

## Expected Behavior

One of the following (in order of preference):
1. `a365 deploy` docs should explicitly state: "For Node.js/TypeScript projects, `typescript` must be in `dependencies` (not `devDependencies`) for Oryx remote build to succeed"
2. OR `a365 deploy` should detect TypeScript in `devDependencies` and warn before uploading
3. OR `a365 deploy` should compile TypeScript locally before creating the deployment zip, deploying only compiled `dist/` output (eliminating the Oryx dependency on `tsc`)
4. OR quickstart templates should place `typescript` in `dependencies`

## SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

## Language/Runtime
Node.js v22.15.0 / TypeScript 5.4.5

## OS
Windows 11

## How to Reproduce
1. Create a Node.js + TypeScript agent project with `typescript` in `devDependencies` (standard scaffold)
2. Run `a365 deploy`
3. Observe Oryx build failure: `sh: tsc: not found` / exit code 127

## Fix
Move `typescript` from `devDependencies` to `dependencies` in `package.json`:
```json
"dependencies": {
  "@microsoft/agents-hosting": "^1.2.2",
  "typescript": "^5.4.5"
},
"devDependencies": {
  "ts-node": "^10.9.2"
}
```

### Code of Conduct
- [x] I agree to follow the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
'@

# ─────────────────────────────────────────────────────────────────────────────
# SUBMIT
# ─────────────────────────────────────────────────────────────────────────────
$issues = @(
    @{ Id="A"; Title=$issueATitle; Body=$issueABody; Labels=@("documentation") },
    @{ Id="B"; Title=$issueBTitle; Body=$issueBBody; Labels=@("bug") },
    @{ Id="C"; Title=$issueCTitle; Body=$issueCBody; Labels=@("documentation","bug") },
    @{ Id="D"; Title=$issueDTitle; Body=$issueDBody; Labels=@("documentation","bug") },
    @{ Id="E"; Title=$issueETitle; Body=$issueEBody; Labels=@("documentation","bug") }
)

$submitted = 0
$failed = 0

foreach ($issue in $issues) {
    if ($IssueFilter -ne "All" -and $issue.Id -ne $IssueFilter) { continue }
    Submit-Issue -Id $issue.Id -Title $issue.Title -Body $issue.Body -Labels $issue.Labels
    if ($LASTEXITCODE -eq 0) { $submitted++ } else { $failed++ }
    Start-Sleep -Seconds 2  # avoid rate limiting
}

Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
Write-Host "Submitted: $submitted / $($issues.Count)" -ForegroundColor $(if ($failed -eq 0) {"Green"} else {"Yellow"})
if ($failed -gt 0) {
    Write-Host "Failed: $failed — see SAML note above" -ForegroundColor Red
    Write-Host "To authorize SAML SSO:" -ForegroundColor White
    Write-Host "  1. gh auth refresh --scopes repo" -ForegroundColor White
    Write-Host "  2. Open the URL printed and authorize for the 'microsoft' org" -ForegroundColor White
    Write-Host "  3. Re-run this script" -ForegroundColor White
}
