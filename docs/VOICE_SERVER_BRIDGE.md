# Cassidy Voice — Server-Side ACS ⇄ Foundry Realtime Bridge

How the **🖥️ Server-side bridge** path works end-to-end: an outbound Teams call placed
by Azure Communication Services Call Automation, with bidirectional audio streamed to
Azure OpenAI / Foundry Realtime so Cassidy can speak and listen 24/7 (no browser tab
required).

This doc captures **every fix** that was needed to take the path from "permanently
broken with 403/401" to working. Future-you, read this before touching `acsBridge.ts`.

---

## Architecture

```
 ┌──────────────┐  createCall  ┌────────────────┐  CallConnected  ┌─────────────────┐
 │ Cassidy app  │─────────────▶│  ACS Call      │────────────────▶│ Teams user      │
 │ (Linux App   │              │  Automation    │   (federated)   │ (same tenant)   │
 │  Service)    │◀─────────────│                │◀────────────────│                 │
 └──────┬───────┘  webhooks    └────────┬───────┘   media         └─────────────────┘
        │                               │  (bidirectional PCM)
        │  /api/calls/acs-events        │
        │  /api/calls/acs-media (wss)   ▼
        │                       ┌─────────────────┐
        │                       │ acsBridge media │
        │                       │ WS handler      │
        ▼                       └────────┬────────┘
 ┌──────────────┐                        │ pcm16 base64
 │ AzureOpenAI/ │◀───────────────────────┘
 │ Foundry      │  AAD bearer (system MI / cognitiveservices.azure.com)
 │ Realtime WS  │  wss://<aoai>.openai.azure.com/openai/realtime?deployment=…
 └──────────────┘
```

Components:

| Piece | Identity / endpoint | Role |
|---|---|---|
| ACS resource `acs-cassidy` | immutableResourceId `4d993b69-6809-4e79-823b-e0bb0f01eb5a` | Call Automation + identity service |
| Source ACS user | `8:acs:<resourceId>_<guid>` (provisioned at runtime) | Outbound caller identity |
| Target | Teams user OID `2ebb7524-…` (`admin@ABSx02771022`) | Callee |
| Cassidy app | `cassidyopsagent-webapp` (B1, Linux Node 20) system MI | Hosts callbacks + media WS, signs Realtime calls |
| AOAI | `oai-cassidy-ops.openai.azure.com` | Realtime model `gpt-realtime-mini` |

---

## Pre-requisites (one-time)

Most of these were already in place, but document them here so we know what to recreate
in DR.

### 1. Azure resources

```powershell
# Resource group + plan
az group create -n rg-cassidy-ops-agent -l eastus
az appservice plan create -g rg-cassidy-ops-agent -n rg-cassidy-ops-plan --sku B1 --is-linux
az webapp create -g rg-cassidy-ops-agent -p rg-cassidy-ops-plan -n cassidyopsagent-webapp --runtime "NODE|20-lts"
az webapp config set -g rg-cassidy-ops-agent -n cassidyopsagent-webapp --always-on true

# ACS
az communication create -n acs-cassidy -g rg-cassidy-ops-agent -l global --data-location unitedstates

# AOAI with gpt-realtime-mini deployment (manual — Foundry Hub portal)
```

> **Plan tier matters**: F1 Free has a per-day CPU quota. When it tripped we got
> hours of "deploy hangs / container won't start". Always run voice on **B1+**.

### 2. Identity / RBAC

- App Service has **system-assigned managed identity** enabled.
- That MI needs **Cognitive Services OpenAI User** on the AOAI resource so it can
  request `https://cognitiveservices.azure.com/.default` and open the Realtime WS.
- ACS connection string lives in `ACS_CONNECTION_STRING` app setting.

### 3. App settings

| Key | Value | Purpose |
|---|---|---|
| `ACS_CONNECTION_STRING` | `endpoint=…;accesskey=…` | Call Automation client |
| `AZURE_OPENAI_ENDPOINT` | `https://oai-cassidy-ops.openai.azure.com` | Used as the host for the Realtime WS — see fix #2 |
| `AZURE_OPENAI_REALTIME_DEPLOYMENT` | `gpt-realtime-mini` | Deployment name |
| `AZURE_OPENAI_REALTIME_REGION` | `eastus2` | Only used for the *browser* WebRTC URL we hand to the dashboard |
| `WEBSITE_HOSTNAME` | (auto) | ACS callbacks + media WS use this |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | Forces Oryx build on deploy |
| `ENABLE_ORYX_BUILD` | `true` | Forces Oryx build on deploy |
| `ACS_SOURCE_USER_ID` | _(optional)_ `8:acs:…_<guid>` | Persists the source identity across restarts. If unset, we provision lazily — see fix #1 |

### 4. Teams federation

ACS-to-Teams interop is gated by two policies on the Teams tenant:

```powershell
# Run in MicrosoftTeams PowerShell as a Teams admin
Connect-MicrosoftTeams

# Tenant-wide ACS <-> Teams federation, scoped to OUR ACS resource only
Set-CsTeamsAcsFederationConfiguration `
  -EnableAcsUsers $true `
  -AllowedAcsResources @('4d993b69-6809-4e79-823b-e0bb0f01eb5a')

# External access policy must allow ACS federation
Get-CsExternalAccessPolicy -Identity Global  # confirm EnableAcsFederationAccess = True
```

Verify with `Get-CsTeamsAcsFederationConfiguration` — `AllowedAcsResources` should
contain our immutableResourceId and `EnableAcsUsers` should be `True`.

---

## The Three Fixes That Actually Made It Work

### Fix #1 — ACS source identity (`403#10391`)

**Symptom**: `createCall` succeeded, ringtone never played, callback fired
`Microsoft.Communication.CreateCallFailed` with `code:403, subCode:10391, "Forbidden.
DiagCode: 403#10391"`. Call lasted 6 seconds.

**Cause**: ACS-to-Teams interop calls **must** carry a valid ACS communication user as
the source identity. The Teams interop service validates that identity against the
`AllowedAcsResources` allow-list. The original code passed only `sourceDisplayName`
without provisioning a real ACS user, so the call had no source identity and Teams
rejected it.

**Fix** (in `cassidy/src/voice/acsBridge.ts`):

1. Added `@azure/communication-identity@1.3.1` dependency.
2. Added an `ensureSourceIdentity()` helper that:
   - Reads `ACS_SOURCE_USER_ID` from app settings if set.
   - Otherwise calls `CommunicationIdentityClient.createUser()` once and caches
     the result in module-scope memory.
3. Made `getAcsClient()` async so the source identity is resolved before
   `createCall` is invoked.
4. Logs the provisioned id with the hint `"Set ACS_SOURCE_USER_ID app setting to
   persist across restarts"` — recommended so we don't leak ACS users on every
   cold start.

After deploy, the call connects: callback fires `CallConnected → ParticipantsUpdated
→ MediaStreamingStarted` and the recipient's Teams client rings.

> **Note on same-tenant Teams users**: Microsoft documents a separate limitation
> where ACS Call Automation cannot direct-call same-tenant Teams users *via PSTN-style
> dial paths*. The federated path we use here (ACS user → Teams user via federation)
> works fine for same-tenant once the source identity + AllowedAcsResources are
> aligned. Verified live with `admin@ABSx02771022`.

### Fix #2 — Foundry Realtime WS host (`401 Unexpected server response`)

**Symptom**: Call connected, ACS opened the media WebSocket, but the Cassidy side
logged `Foundry Realtime WS error: Error: Unexpected server response: 401` within
~1.5s. ACS then declared `MediaStreamingFailed` (`subCode:8581 — Transport url is not
valid or web socket server is not operational`). Call was silent — Cassidy never
spoke.

**Cause**: The bridge was opening the WebSocket against the **WebRTC preview host**:

```
wss://<region>.realtimeapi-preview.ai.azure.com/v1/realtime?deployment=…
```

That host is for **browser WebRTC** clients and only accepts **ephemeral keys**
(minted via `/openai/realtimeapi/sessions`). It rejects AAD bearer tokens with 401.

For **server-side AAD-authenticated** Realtime WS, you must use the **AOAI resource
host** instead:

```
wss://<aoai>.openai.azure.com/openai/realtime?deployment=…&api-version=2025-04-01-preview
```

**Fix** (in `cassidy/src/voice/acsBridge.ts` `handleAcsMediaSocket`):

```ts
const tokenResp = await credential.getToken('https://cognitiveservices.azure.com/.default');
const aoaiHost = (config.openAiEndpoint || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
const realtimeUrl =
  `wss://${aoaiHost}/openai/realtime?deployment=${encodeURIComponent(VOICE_DEPLOYMENT)}` +
  `&api-version=${REALTIME_API_VERSION}`;

realtimeWs = new WebSocket(realtimeUrl, {
  headers: { Authorization: `Bearer ${tokenResp.token}` },
});
```

After deploy, logs show:

```
Foundry Realtime WS connecting url=wss://oai-cassidy-ops.openai.azure.com/openai/realtime?deployment=gpt-realtime-mini&api-version=2025-04-01-preview
Foundry Realtime WS open
```

…and audio starts flowing. The `realtimeapi-preview.ai.azure.com` host is still used
for the **browser** Realtime client, served via `/api/dashboard/voice/session` →
`webrtcUrl`; that one keeps the ephemeral key flow.

### Fix #3 — `MediaStreamingOptions` shape

The `createCall` options must include `mediaStreamingOptions` with all of:

```ts
{
  transportUrl: `wss://${PUBLIC_HOSTNAME}/api/calls/acs-media`,
  transportType: 'websocket',
  contentType: 'audio',
  audioChannelType: 'mixed',        // single mixed track
  startMediaStreaming: true,        // start immediately, don't wait for StartMediaStreaming
  enableBidirectional: true,        // we send AudioData frames back too
  audioFormat: 'Pcm24KMono',        // matches what Realtime expects (no resampling)
}
```

Plus `callIntelligenceOptions: { cognitiveServicesEndpoint }` — without this, ACS
rejects bidirectional streaming with a generic 400. We point it at the same AOAI
endpoint (`config.openAiEndpoint`); the ACS resource must have the AOAI resource
linked under **Cognitive Services connections** in the portal.

---

## Deploy Pipeline (Oryx-built slim zip)

The full `node_modules` zip approach kept biting us (cached `node_modules.tar.gz`
without `@azure/communication-identity`, 504 timeouts on 80MB+ uploads). The
canonical workflow now:

```powershell
cd 'c:\…\Cassidy Autonomous\cassidy'
npm run build  # tsc → dist/

$staging = 'c:\temp\cassidy-deploy-rt'
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Recurse dist $staging\
Copy-Item -Recurse src  $staging\          # Oryx needs src + tsconfig to rebuild
Copy-Item package.json,package-lock.json,tsconfig.json $staging\

$zip = 'c:\temp\cassidy-deploy.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $staging, $zip,
  [System.IO.Compression.CompressionLevel]::Fastest, $false)

az webapp deploy `
  -g rg-cassidy-ops-agent -n cassidyopsagent-webapp `
  --src-path $zip --type zip --timeout 600

az webapp restart -g rg-cassidy-ops-agent -n cassidyopsagent-webapp
```

If the container ever boots with `Cannot find module '@azure/communication-identity'`
or similar, Oryx is reusing a stale `node_modules.tar.gz`. Nuke it via Kudu VFS:

```powershell
$tok = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv
$h = @{ Authorization = "Bearer $tok" }
Invoke-RestMethod -Method DELETE `
  -Uri 'https://cassidyopsagent-webapp.scm.azurewebsites.net/api/vfs/site/wwwroot/node_modules.tar.gz' `
  -Headers $h
Invoke-RestMethod -Method DELETE `
  -Uri 'https://cassidyopsagent-webapp.scm.azurewebsites.net/api/vfs/site/wwwroot/oryx-manifest.toml' `
  -Headers $h
# then redeploy
```

---

## Verification — full smoke test

```powershell
# 1. Health
Invoke-RestMethod https://cassidyopsagent-webapp.azurewebsites.net/api/health

# 2. Live log tail (filter for the bridge)
$tok = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv
$h = @{ Authorization = "Bearer $tok" }
$files = Invoke-RestMethod 'https://cassidyopsagent-webapp.scm.azurewebsites.net/api/vfs/LogFiles/' -Headers $h
$latest = $files | Where-Object name -like '*default_docker.log' | Sort-Object mtime -Desc | Select -First 1
$content = Invoke-RestMethod $latest.href -Headers $h
$content -split "`n" | Where-Object { $_ -match 'voice\.acs|Foundry Realtime' } | Select -Last 30
```

Place a call from the dashboard ("Server-side bridge" toggle ON, click Dial). The log
sequence for a healthy call is:

```
ACS source identity provisioned communicationUserId=8:acs:...
ACS createCall — outbound to Teams user
ACS callback event type=Microsoft.Communication.CallConnected
ACS media WS opened
Foundry Realtime WS connecting url=wss://oai-cassidy-ops.openai.azure.com/openai/realtime?...
ACS callback event type=Microsoft.Communication.MediaStreamingStarted
Foundry Realtime WS open
```

If you don't see `Foundry Realtime WS open` within ~3s, see Fix #2.
If you see `403#10391`, see Fix #1.
If you see `MediaStreamingFailed subCode:8581`, the upstream Realtime WS died; check
its error first — that's almost always the underlying cause.

---

## Known Limitations

- **Same-tenant via Call Automation direct dial**: still blocked at the platform
  level for non-federated paths (e.g. PSTN-bridged scenarios). The federated path
  documented here works.
- **Speech feature flag**: `speech: false` in `/api/health` is expected — we don't
  use Azure Speech for the bridge, only Foundry Realtime.
- **Source identity persistence**: currently in-memory only. Persist to
  `ACS_SOURCE_USER_ID` to avoid leaking ACS users on cold start.
- **Table Storage `authorization failed` warnings**: cosmetic, the app falls back
  to in-memory state. To clean up, grant the App Service MI `Storage Table Data
  Contributor` on `cassidyopsstorage` for tables `CassidyAgentRegistry`, `…Jobs`,
  `…Plans`.

---

## Files of interest

| File | What it owns |
|---|---|
| [cassidy/src/voice/acsBridge.ts](../cassidy/src/voice/acsBridge.ts) | `placeOutboundCall`, `handleAcsMediaSocket`, source identity, Realtime WS |
| [cassidy/src/voice/cteToken.ts](../cassidy/src/voice/cteToken.ts) | Browser CTE token mint (separate path — not used by the server bridge) |
| [cassidy/src/index.ts](../cassidy/src/index.ts) | Routes: `/api/calls/acs-events`, `/api/calls/acs-media`, `/api/dashboard/voice/*` |
| [cassidy/dashboard/src/CteCallPanel.tsx](../cassidy/dashboard/src/CteCallPanel.tsx) | Dashboard UI with "Server-side bridge" toggle |
| [docs/VOICE_CTE.md](./VOICE_CTE.md) | The browser CTE Teams-as-user path |
