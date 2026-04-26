# Voice / CTE Calling — Architecture & Wiring

> **Status:** F2 (Custom Teams Endpoint, dashboard browser) deployed and ringing
> end-to-end as of 26 Apr 2026. Audio path: dashboard browser mic ↔ MOD Admin's
> Teams app via federation. Foundry Realtime audio bridge **not yet wired** —
> Cassidy can call but cannot speak with the GPT voice yet.

## Why CTE / federation (not ACS Call Automation, not Graph Calling Bot)

| Path | Live AI audio? | Teams Phone licence? | Node-friendly? | Verdict |
|---|---|---|---|---|
| ACS Call Automation → Teams user (initial attempt) | yes (PCM WS bridge) | **required** (got `403/10391`) | yes | rejected by user |
| Graph Calling Bot — service-hosted media | no (`playPrompt` .wav only) | no | yes | not viable for live duplex |
| Graph Calling Bot — app-hosted media | yes | no | **C# only** | multi-day rebuild |
| **CTE — dashboard browser (F2)** | **yes** (browser MediaStream) | **no** (federation) | yes | **chosen** |
| CTE — headless Chromium (F1) | yes (in theory) | no | n/a | unsupported by MS, "might or might not work" |

CTE = Cassidy *is* a real Teams user. Federation routes the call natively, so
no Phone licence is involved.

---

## End-to-end identity & token flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  Provisioned ONCE (interactive, with MFA)                            │
│                                                                      │
│  AAD app "Cassidy CTE Calling"  ── admin-consented ──▶ ACS resource  │
│   clientId 97345671-…                                  acs-cassidy   │
│   delegated: Teams.ManageCalls + Teams.ManageChats                   │
│                                                                      │
│  M365 user cassidy@ABSx02771022.onmicrosoft.com                      │
│   id d261efd9-… · Teams Enterprise (Free) licence                    │
│   first sign-in: device-code flow → password change → MFA enrol      │
│   → refresh_token captured to webapp setting CTE_REFRESH_TOKEN       │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Per call (server side, voice/cteToken.ts)                           │
│                                                                      │
│  1. CTE_REFRESH_TOKEN ──▶ POST https://login.microsoftonline.com     │
│                            /{tenant}/oauth2/v2.0/token               │
│                            grant_type=refresh_token                  │
│                            scope=Teams.ManageCalls Teams.ManageChats │
│                                  offline_access                      │
│                            ──▶ AAD access_token (~75 min)            │
│                                                                      │
│  2. AAD access_token ──▶ POST {acs-endpoint}                         │
│                          /teamsUser/:exchangeAccessToken             │
│                          api-version=2023-10-01                      │
│                          HMAC-SHA256 signed with ACS access key      │
│                          body: { token, appId, userId }              │
│                          ──▶ ACS Teams-user token (~75 min)          │
│                                                                      │
│  Both tokens cached in-process; refresh when <5 min from expiry.     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Per call (browser, dashboard/CteCallPanel.tsx)                      │
│                                                                      │
│  POST /api/dashboard/voice/cte-token   (Easy Auth gated)             │
│   ──▶ { token, expiresOn, userObjectId, defaultTargetTeamsUserId }   │
│                                                                      │
│  AzureCommunicationTokenCredential({                                 │
│    token,                                                            │
│    tokenRefresher: () => POST /api/dashboard/voice/cte-token,        │
│    refreshProactively: true,                                         │
│  })                                                                  │
│                                                                      │
│  client = new CallClient()                                           │
│  await client.getDeviceManager().askDevicePermission({ audio: true })│
│  agent = await client.createTeamsCallAgent(credential)               │
│   (NB: displayName cannot be set on Teams users — inherited from     │
│        the Cassidy AAD account's M365 displayName)                   │
│                                                                      │
│  call = agent.startCall({ microsoftTeamsUserId: '<target-aad-oid>' })│
│   ──▶ federation rings target's Teams natively as "Cassidy"          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Azure / AAD inventory (current state)

| Resource | Identifier |
|---|---|
| Tenant | `e4ccbd32-1a13-4cb6-8fda-c392e7ea359f` (`ABSx02771022.onmicrosoft.com`) |
| Subscription | `260948a4-1d5e-42c8-b095-33a6641ad189` |
| Resource group | `rg-cassidy-ops-agent` |
| ACS resource | `acs-cassidy` · immutable id `4d993b69-6809-4e79-823b-e0bb0f01eb5a` |
| ACS region | `unitedstates` (data location) |
| Cassidy M365 user | `cassidy@ABSx02771022.onmicrosoft.com` · id `d261efd9-8a9a-461c-bda7-92454aa245a4` |
| Cassidy licence | Teams Enterprise (Free) — sku `7e31c0d9-9551-471d-836f-32ee72be4a01` (freed from `alans@`) |
| AAD app reg | `Cassidy CTE Calling` · objectId `06dfa107-9e8d-473a-a243-542862f190ae` · clientId `97345671-86a9-4a01-b2be-f7d52ffe413b` |
| App SP | `35e13120-391f-4299-8439-4209e8c353df` |
| ACS SP (resource being called) | `18f370db-bf08-482c-94b6-ef24aa57e4ee` (appId `1fd5118e-2576-4263-8130-9503064c837a`) |
| Delegated scopes (admin consented) | `Teams.ManageCalls` (`de8ec1df-066a-4817-bc5d-9a985b986262`), `Teams.ManageChats` (`6290af7f-b407-49f9-92d5-bf584fdc4019`) |
| Default call target | `2ebb7524-6596-4f40-83e3-452c11d4298d` (MOD Administrator) |
| Federation policy | `EnableFederationAccess=True`, `EnableAcsFederationAccess=True`, ACS resource id allowed |

### Required webapp app settings (`cassidyopsagent-webapp`)

```
ACS_CONNECTION_STRING            = endpoint=https://acs-cassidy.unitedstates.communication.azure.com/;accesskey=…
CTE_TENANT_ID                    = e4ccbd32-1a13-4cb6-8fda-c392e7ea359f
CTE_CLIENT_ID                    = 97345671-86a9-4a01-b2be-f7d52ffe413b
CTE_USER_OBJECT_ID               = d261efd9-8a9a-461c-bda7-92454aa245a4
CTE_REFRESH_TOKEN                = <captured via device-code flow as Cassidy>
CTE_DEFAULT_TARGET_TEAMS_USER_ID = 2ebb7524-6596-4f40-83e3-452c11d4298d
```

App Service settings are encrypted at rest — no Key Vault dependency in this RG.

### AAD app reg requirements

- `signInAudience: AzureADMyOrg`
- `isFallbackPublicClient: true` (enables device-code flow without a secret)
- Redirect URIs: `http://localhost`, `https://login.microsoftonline.com/common/oauth2/nativeclient`
- `requiredResourceAccess` → ACS SP (`1fd5118e-…`) → both Teams.ManageCalls
  + Teams.ManageChats (delegated, type=`Scope`)
- Tenant-wide admin consent grant (`/oauth2PermissionGrants` with
  `consentType: AllPrincipals`)

---

## Code surface

| File | Purpose |
|---|---|
| [cassidy/src/voice/cteToken.ts](cassidy/src/voice/cteToken.ts) | Refresh-token grant → ACS exchange. In-process cache. `getCteAcsToken()` is the public surface. |
| [cassidy/src/index.ts](cassidy/src/index.ts) | `dashApi.post('/voice/cte-token', …)` — Easy-Auth gated, returns `{ token, expiresOn, userObjectId, defaultTargetTeamsUserId }`. |
| [cassidy/dashboard/src/CteCallPanel.tsx](cassidy/dashboard/src/CteCallPanel.tsx) | React component. Mints token, asks mic permission, builds `TeamsCallAgent`, dials `microsoftTeamsUserId`, surfaces status / mute / participant count. |
| [cassidy/dashboard/src/App.tsx](cassidy/dashboard/src/App.tsx) | Renders `<CteCallPanel />` under the 🎙️ Voice tab beneath `<VoicePanel />`. |
| [cassidy/dashboard/package.json](cassidy/dashboard/package.json) | Adds `@azure/communication-calling` + `@azure/communication-common`. |

### Critical browser-side gotchas (learned)

1. **`createTeamsCallAgent` rejects `displayName`** — Teams user identity is
   bound to the underlying AAD account; the M365 `displayName` ("Cassidy
   (Autonomous Agent)") is what shows on the callee's Teams.
2. **Mic permission must be requested before `startCall`.** Without an
   explicit `deviceManager.askDevicePermission({ audio: true })` the call
   succeeds but with no outgoing audio track — caller side hears nothing.
3. **Refreshable credential is mandatory.** ACS Teams-user tokens expire in
   ~75 min. The `tokenRefresher` callback re-hits `/api/dashboard/voice/
   cte-token`, which itself refreshes the AAD token via the cached
   refresh_token. Long calls just keep working.

---

## Re-provisioning a Cassidy refresh token (when CTE_REFRESH_TOKEN expires)

Refresh tokens for AAD app users live ~90 days inactive / 14 days from
sign-in (depends on tenant CA policy). When ACS calls start failing with
`AAD refresh failed: 400 invalid_grant`, re-run the device-code flow:

```powershell
$tenant   = 'e4ccbd32-1a13-4cb6-8fda-c392e7ea359f'
$clientId = '97345671-86a9-4a01-b2be-f7d52ffe413b'
$scope    = 'https://auth.msft.communication.azure.com/Teams.ManageCalls ' +
            'https://auth.msft.communication.azure.com/Teams.ManageChats ' +
            'offline_access openid profile'

$dc = Invoke-RestMethod -Method POST `
  -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/devicecode" `
  -Body @{ client_id = $clientId; scope = $scope } `
  -ContentType 'application/x-www-form-urlencoded'

"Open: $($dc.verification_uri)"
"Code: $($dc.user_code)"
# Sign in as cassidy@ABSx02771022.onmicrosoft.com (interactive MFA), then poll:

$tokenResp = $null
while (-not $tokenResp) {
  Start-Sleep -Seconds $dc.interval
  try {
    $tokenResp = Invoke-RestMethod -Method POST `
      -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" `
      -Body @{
        grant_type    = 'urn:ietf:params:oauth:grant-type:device_code'
        client_id     = $clientId
        device_code   = $dc.device_code
      } -ContentType 'application/x-www-form-urlencoded' -ErrorAction Stop
  } catch { Write-Host -NoNewline '.' }
}

az webapp config appsettings set `
  --resource-group rg-cassidy-ops-agent `
  --name cassidyopsagent-webapp `
  --settings "CTE_REFRESH_TOKEN=$($tokenResp.refresh_token)"
```

App Service will recycle automatically when the setting changes.

---

## Build / deploy

```powershell
# Backend
cd cassidy
npm run build

# Dashboard (CTE panel pulls in ACS Calling SDK; bundle is ~5.5 MB raw, ~1.4 MB gzip)
cd dashboard
npm run build

# Stage + zip + push
cd ..
$stage = 'c:\temp\cassidy-deploy'
robocopy . $stage /E /XD node_modules dist .git .vscode coverage tests dashboard\node_modules /XF *.log .env .env.* /NFL /NDL /NJH /NJS | Out-Null
robocopy .\dist $stage\dist /E /NFL /NDL /NJH /NJS | Out-Null
robocopy .\dashboard\dist $stage\dashboard\dist /E /NFL /NDL /NJH /NJS | Out-Null

$zip = 'c:\temp\cassidy-deploy.zip'
if (Test-Path $zip) { Remove-Item $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Fastest, $false)

az webapp deploy `
  --resource-group rg-cassidy-ops-agent `
  --name cassidyopsagent-webapp `
  --src-path $zip --type zip --async true
```

---

## Smoke test

1. Sign in to <https://cassidyopsagent-webapp.azurewebsites.net/dashboard/> as MOD Admin.
2. 🎙️ **Voice** tab → scroll to **📞 Teams Call (CTE — federated)**.
3. Target field is pre-populated with MOD Admin's AAD object id.
4. Click **Dial**. Allow microphone when prompted.
5. **Expected:**
   - Status: `minting → connecting → ringing → connected`
   - Mic: `live`, Remote participants: `1`
   - Teams app rings showing **"Cassidy (Autonomous Agent)"** as caller
6. Answer in Teams → silent two-way audio (browser mic ↔ Teams). Cassidy
   doesn't *speak* yet — that's the next phase.

---

## Phase 2 — Server-side bridge (24/7, tab-independent)

The browser CTE flow is great for identity-correct calls but dies the
moment you close the dashboard. **Server-side mode** moves the bridge into
Node so calls run unattended.

| Aspect | Browser CTE (Phase 1) | Server bridge (Phase 2) |
|---|---|---|
| Identity in Teams | Cassidy as a real Teams user (federated) | "Anonymous" / ACS resource endpoint |
| Lifetime | Browser tab open | App Service uptime (24/7) |
| Inbound calls | No | **Yes** (Event Grid auto-answer) |
| Autonomous trigger | No | **Yes** (`/api/internal/voice/server-call`) |
| Code path | `CteCallPanel.tsx` + ACS Calling SDK | `acsBridge.ts` + ACS Call Automation + WS |
| Audio transport | WebRTC (in browser) | PCM16 24 kHz over WebSocket (in Node) |

### Architecture

```
                          ┌─────────────────────┐
   Outbound:              │ ACS Call Automation │
   POST /server-call ───▶ │   (Microsoft side)  │ ──▶ Teams user rings
                          └─────────┬───────────┘
                                    │ media stream WS
                                    ▼
                       wss://<host>/api/calls/acs-media
                                    │
                          ┌─────────┴───────────┐
                          │   acsBridge.ts      │
                          │  (PCM16 24k, both)  │
                          └─────────┬───────────┘
                                    │ Foundry Realtime WS
                                    ▼
                wss://<region>.realtimeapi-preview.ai.azure.com/v1/realtime
```

Inbound flow:

```
Anyone in tenant calls Cassidy's ACS endpoint
        ▼
Event Grid topic on acs-cassidy fires Microsoft.Communication.IncomingCall
        ▼
POST https://<host>/api/calls/incoming-call
        ▼
handleIncomingCallEvent → answerCall(incomingCallContext, …)
        ▼
Same media-stream bridge as outbound
```

### Code surface added

| File | Function | Purpose |
|---|---|---|
| [cassidy/src/voice/acsBridge.ts](cassidy/src/voice/acsBridge.ts#L138) | `answerInboundCall()` | Picks up Event Grid IncomingCall and wires the same Foundry Realtime bridge |
| [cassidy/src/voice/acsBridge.ts](cassidy/src/voice/acsBridge.ts#L194) | `handleIncomingCallEvent()` | Handles EG SubscriptionValidation handshake + IncomingCall dispatch |
| [cassidy/src/voice/acsBridge.ts](cassidy/src/voice/acsBridge.ts#L420) | `getActiveCallSnapshot()` | Diagnostics for the dashboard polling loop |
| [cassidy/src/index.ts](cassidy/src/index.ts) | `POST /api/dashboard/voice/server-call` | Easy Auth-gated dashboard trigger |
| [cassidy/src/index.ts](cassidy/src/index.ts) | `GET /api/dashboard/voice/server-calls` | Active call list |
| [cassidy/src/index.ts](cassidy/src/index.ts) | `POST /api/internal/voice/server-call` | `SCHEDULED_SECRET`-gated autonomous trigger |
| [cassidy/src/index.ts](cassidy/src/index.ts) | `POST /api/calls/incoming-call` | Event Grid webhook (validation + IncomingCall) |
| [cassidy/dashboard/src/CteCallPanel.tsx](cassidy/dashboard/src/CteCallPanel.tsx) | `serverMode` toggle | Sends server-call request, polls active-call snapshot |

### One-time Azure setup — Event Grid IncomingCall subscription

```powershell
$acsId = az communication show -n acs-cassidy -g rg-cassidy-ops-agent --query id -o tsv
az eventgrid event-subscription create `
  --name cassidy-incoming-calls `
  --source-resource-id $acsId `
  --endpoint https://cassidyopsagent-webapp.azurewebsites.net/api/calls/incoming-call `
  --endpoint-type webhook `
  --included-event-types Microsoft.Communication.IncomingCall `
  --event-delivery-schema EventGridSchema
```

The first POST is the Event Grid validation handshake — `handleIncomingCallEvent`
echoes the `validationCode` and the subscription transitions to *Succeeded*.
After that, every call placed to Cassidy's ACS identity is auto-answered.

### Calling Cassidy autonomously (Phase 3 hook)

The autonomous loop can place calls without a dashboard at all:

```ts
await fetch('https://cassidyopsagent-webapp.azurewebsites.net/api/internal/voice/server-call', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cassidy-secret': process.env.SCHEDULED_SECRET! },
  body: JSON.stringify({
    teamsUserAadOid: '<target AAD oid>',
    requestedBy: 'Cassidy (proactive)',
    instructions: 'Call to brief them on the urgent CorpGen blocker that just appeared.',
  }),
});
```

### Smoke test

1. Hard-refresh dashboard.
2. Tick **🖥️ Server-side bridge** on the CTE panel; click **Dial**.
3. Status: `minting → connecting → ringing → connected (Server bridge live N s)`.
4. Teams rings; the caller card shows the ACS resource (not "Cassidy" as
   federated user — that's expected for this mode).
5. Close the dashboard tab — call keeps running. Hang up from Teams when done.

### Known caveats

- **Identity tradeoff:** server-side ACS Call Automation cannot present the
  federated Teams identity. If "Cassidy" name + avatar matter, use Phase 1.
- **PSTN not enabled:** to call a phone number instead of a Teams user, buy
  an ACS phone number and use `phoneNumberId` instead of `microsoftTeamsUserId`.
- **No barge-in tuning yet:** `server_vad threshold:0.5` is the default —
  bump to 0.7 if Cassidy interrupts callers too eagerly.

---

## Next phase — Cassidy actually speaks

The audio currently flows browser-mic → Cassidy → MOD Admin's Teams. To
swap in the GPT voice we need to feed a `MediaStreamTrack` produced by the
Foundry Realtime peer connection into ACS, instead of the local mic. Sketch:

1. Open the existing Foundry Realtime `RTCPeerConnection`
   ([cassidy/dashboard/src/VoicePanel.tsx](cassidy/dashboard/src/VoicePanel.tsx))
   with `recvonly` audio so the AI's TTS arrives as a remote track.
2. Capture that remote track and pass it to the ACS call via
   `call.startAudio(localAudioStream)` where `localAudioStream` is built
   from `LocalAudioStream(new MediaStream([realtimeRemoteTrack]))`.
3. For the reverse direction (caller → AI), capture the remote track from
   the ACS `call.remoteAudioStreams[0]` and feed it to Foundry Realtime as
   the inbound audio, replacing `getUserMedia` mic.
4. Disable echo cancellation on the bridge to avoid double-AGC.

That's a single component refactor — no further infra work needed.

---

## Provenance — facts independently verified during build-out

- `acsBridge.ts` 403/10391 only happens when target lacks Teams Phone licence
  (confirmed via ACS `resultInformation` after JWT-route-order fix).
- ACS `/teamsUser/:exchangeAccessToken` returns a token with
  `acsScope: voip,chat` and `resourceId` matching `acs-cassidy` immutable id —
  validated end-to-end before deploy.
- AAD device-code flow against `Cassidy CTE Calling` succeeded with one MFA
  prompt; refresh_token length 1516 bytes; access token JWT decodes to
  `aud: https://auth.msft.communication.azure.com/`.
- Federation policy `EnableAcsFederationAccess=True` is required tenant-side
  for cross-resource-id calling; already enabled on `ABSx02771022`.
