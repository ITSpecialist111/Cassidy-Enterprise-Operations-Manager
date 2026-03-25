#!/usr/bin/env pwsh
# =============================================================================
# Agent 365 — Step 5: Verify deployment health + catalog status
#
# Run after 'a365 deploy' and 'a365 publish' to confirm everything is live.
#
# Usage:
#   ./05-verify-deployment.ps1 -WebAppName "myagent-webapp" -AgentDisplayName "MyAgent Blueprint"
# =============================================================================

param(
    [Parameter(Mandatory)]
    [string]$WebAppName,

    [Parameter(Mandatory)]
    [string]$AgentDisplayName,

    [string]$ClientId,
    [string]$TenantId,
    [string]$ClientSecret
)

Set-StrictMode -Version Latest

Write-Host "=== Agent 365 Deployment Verification ===" -ForegroundColor Cyan

# 1. Health endpoint
Write-Host "`n[1/3] Checking health endpoint..." -ForegroundColor Yellow
$url = "https://$WebAppName.azurewebsites.net/api/health"
try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 15
    if ($r.StatusCode -eq 200) {
        Write-Host "  [OK] $url" -ForegroundColor Green
        Write-Host "  Response: $($r.Content)" -ForegroundColor DarkGray
    }
} catch {
    Write-Host "  [FAIL] Health check failed: $_" -ForegroundColor Red
}

# 2. Teams app catalog
Write-Host "`n[2/3] Checking M365 Teams app catalog..." -ForegroundColor Yellow
if ($ClientId -and $TenantId -and $ClientSecret) {
    $tokenResponse = Invoke-RestMethod `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -Method POST `
        -Body @{ grant_type="client_credentials"; client_id=$ClientId; client_secret=$ClientSecret; scope="https://graph.microsoft.com/.default" }
    $t = $tokenResponse.access_token

    $apps = Invoke-RestMethod `
        "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?`$filter=distributionMethod eq 'organization'" `
        -Headers @{ "Authorization" = "Bearer $t" }
    $match = $apps.value | Where-Object { $_.displayName -eq $AgentDisplayName }

    if ($match) {
        Write-Host "  [OK] '$AgentDisplayName' found in org catalog (id: $($match.id))" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] '$AgentDisplayName' not found in catalog — has manifest.zip been uploaded to admin.cloud.microsoft?" -ForegroundColor DarkYellow
        Write-Host "  Upload at: https://admin.cloud.microsoft/#/agents/all" -ForegroundColor White
    }
} else {
    Write-Host "  [SKIP] No credentials provided — skipping catalog check" -ForegroundColor DarkGray
    Write-Host "  Pass -ClientId, -TenantId, -ClientSecret to enable this check" -ForegroundColor DarkGray
}

# 3. Reminders
Write-Host "`n[3/3] Post-deploy manual steps checklist:" -ForegroundColor Yellow
Write-Host "  [ ] Upload manifest/manifest.zip to https://admin.cloud.microsoft/#/agents/all" -ForegroundColor White
Write-Host "  [ ] Configure Teams Dev Portal: https://dev.teams.microsoft.com/tools/agent-blueprint/<blueprintId>/configuration" -ForegroundColor White
Write-Host "       Set: Agent Type = Bot Based, Bot ID = <blueprintId>" -ForegroundColor DarkGray
Write-Host "  [ ] In M365 Copilot: search for '$AgentDisplayName' → Request → Create instance" -ForegroundColor White
Write-Host "  [ ] Admin approve at: https://admin.cloud.microsoft/#/agents/all/requested" -ForegroundColor White
Write-Host "  [ ] Wait 5-15 min for Entra user provisioning" -ForegroundColor White
Write-Host "  [ ] Test in Teams chat" -ForegroundColor White

Write-Host "`n=== DONE ===" -ForegroundColor Cyan
