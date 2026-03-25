#!/usr/bin/env pwsh
# =============================================================================
# Agent 365 CLI — Step 1: Create Entra App Registration (Option B)
# 
# Creates the custom client app registration required by the a365 CLI.
# Uses Graph API appRoleAssignments to grant beta permissions that are
# NOT visible in the Entra admin center UI.
#
# CRITICAL: Do NOT use the "Grant admin consent" button in Entra portal
#           after running this script — it will delete the beta permissions.
#
# Prerequisites:
#   - az login completed with Global Administrator account
#   - Az CLI installed
#
# Usage:
#   ./01-create-entra-cli-app.ps1 -DisplayName "Agent365-CLI-Client"
# =============================================================================

param(
    [string]$DisplayName = "Agent365-CLI-Client"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Agent 365 CLI App Registration Setup ===" -ForegroundColor Cyan

# Step 1: Create app registration
Write-Host "`n[1/4] Creating Entra app registration '$DisplayName'..." -ForegroundColor Yellow
$app = az ad app create `
    --display-name $DisplayName `
    --public-client-redirect-uris "http://localhost:8400" `
    --query "{appId:appId, id:id}" -o json | ConvertFrom-Json

$clientId = $app.appId
$appObjectId = $app.id
Write-Host "  Client ID: $clientId" -ForegroundColor Green
Write-Host "  Object ID: $appObjectId" -ForegroundColor Green

# Step 2: Create service principal
Write-Host "`n[2/4] Creating service principal..." -ForegroundColor Yellow
$sp = az ad sp create --id $clientId --query "{id:id}" -o json | ConvertFrom-Json
$spObjectId = $sp.id
Write-Host "  SP Object ID: $spObjectId" -ForegroundColor Green

# Step 3: Get Graph SP ID
Write-Host "`n[3/4] Getting Microsoft Graph service principal..." -ForegroundColor Yellow
$graphSpId = az ad sp show --id "00000003-0000-0000-c000-000000000000" --query id -o tsv
Write-Host "  Graph SP ID: $graphSpId" -ForegroundColor Green

# Step 4: Grant permissions via Graph API
Write-Host "`n[4/4] Granting 5 required permissions via Graph API..." -ForegroundColor Yellow
$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
$headers = @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" }

$permissions = @(
    @{ Id = "3afa6a7d-9d1d-4dda-9b2f-54cd192b0e73"; Name = "AgentIdentityBlueprint.ReadWrite.All (BETA)" },
    @{ Id = "5aef0bcc-1b8e-4379-8594-bc84a3ecbc08"; Name = "AgentIdentityBlueprint.UpdateAuthProperties.All (BETA)" },
    @{ Id = "1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9"; Name = "Application.ReadWrite.All" },
    @{ Id = "41ce6ca6-6826-4807-84f1-1c82854f7af5"; Name = "DelegatedPermissionGrant.ReadWrite.All" },
    @{ Id = "06da0dbc-49e2-44d2-8312-53f166ab848a"; Name = "Directory.Read.All" }
)

foreach ($perm in $permissions) {
    $body = @{
        principalId = $spObjectId
        resourceId  = $graphSpId
        appRoleId   = $perm.Id
    } | ConvertTo-Json

    try {
        $r = Invoke-RestMethod `
            "https://graph.microsoft.com/v1.0/servicePrincipals/$spObjectId/appRoleAssignments" `
            -Method POST -Headers $headers -Body $body
        Write-Host "  [OK] $($perm.Name)" -ForegroundColor Green
    }
    catch {
        $errMsg = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($errMsg.error.code -eq "Permission_Duplicate") {
            Write-Host "  [SKIP] $($perm.Name) — already granted" -ForegroundColor DarkYellow
        } else {
            Write-Host "  [FAIL] $($perm.Name): $($errMsg.error.message)" -ForegroundColor Red
            throw
        }
    }
}

Write-Host "`n=== DONE ===" -ForegroundColor Cyan
Write-Host "Client App ID (use in a365 config init): $clientId" -ForegroundColor White
Write-Host ""
Write-Host "IMPORTANT: Do NOT click 'Grant admin consent' in the Entra portal" -ForegroundColor Red
Write-Host "           for this app. It will delete the beta AgentIdentityBlueprint permissions." -ForegroundColor Red
