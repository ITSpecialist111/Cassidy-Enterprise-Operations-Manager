# Proposed GitHub Issues for microsoft/Agent365-devTools

Repo: https://github.com/microsoft/Agent365-devTools/issues/new

Cross-referenced against all open issues (#100, #143, #268, #274, #285, #287, #294, #295, #303, #306, #307, #310) to confirm these are NOT duplicates.

---

## Issue A — `a365 publish` does not publish: documentation contradiction between CLI reference and AI-guided setup instructions

**Labels:** `documentation`, `bug`

### Description

There is a direct contradiction between two official sources regarding what `a365 publish` actually does in v1.1.115-preview:

**Source 1 — CLI reference docs** (`/developer/reference/cli/publish`):
> "Update the ID values in manifest.json and create a manifest.zip package for uploading to the Microsoft 365 admin center. After running this command, follow the printed instructions to upload the package through the Microsoft 365 admin center."

**Source 2 — AI-guided setup instructions** (`a365-setup-instructions.md`, Step 5):
> "It then publishes the agent manifest/package to your tenant's catalog (so that the agent can be 'hired' or installed in Teams and other apps)."

The CLI reference is correct — `a365 publish` only creates `manifest.zip` and prints instructions. It does NOT upload to the admin center.

Additionally, attempting to automate the upload via the Graph API `POST /v1.0/appCatalogs/teamsApps` returns `Forbidden` even with `AppCatalog.ReadWrite.All` application permission, with the message:
```
"User not authorized to perform this operation. UserId: '55d8545b-0bb2-4eeb-816a-6b3a32578e84'"
```
The user ID resolves to the "Microsoft Teams Graph Service" service principal — indicating the Agent 365 blueprint format (`manifestVersion: devPreview`) is rejected by the standard Teams app catalog API entirely.

### Expected Behavior

One of the following:
1. `a365 publish` should auto-upload `manifest.zip` to the M365 Admin Center (preferred — eliminates a manual browser-only step)
2. OR `a365-setup-instructions.md` Step 5 should be corrected to say "creates manifest.zip" not "publishes to catalog"

### SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

### Language/Runtime
Node.js v22.15.0

### OS
Windows 11

### How to Reproduce
1. Complete `a365 setup all` successfully
2. Run `a365 publish` — observe it creates `manifest/manifest.zip` and prints manual upload instructions
3. Attempt programmatic upload: `POST https://graph.microsoft.com/v1.0/appCatalogs/teamsApps` with `Content-Type: application/zip` and the manifest.zip body using a token with `AppCatalog.ReadWrite.All` application permission
4. Observe `Forbidden` response

### Output
```
Package created: C:\...\manifest\manifest.zip
To publish: https://admin.microsoft.com > Agents > All agents > Upload custom agent
For details: https://learn.microsoft.com/...
```

---

## Issue B — `a365 config init` defaults to F1 App Service tier which guarantees cold-start timeout failure

**Labels:** `bug`, `cli`, `deployment`

### Description

When `a365 config init` runs interactively, it sets `appServicePlanSku: "F1"` in the generated `a365.config.json`. The F1 (Free) tier has an Azure App Service container startup timeout of **230 seconds**.

A Node.js agent deployed with `a365 deploy` (using Oryx remote build) consistently takes longer than 230s to start on F1 because:
1. Oryx runs `npm install` + `npm run build` (TypeScript compilation) inside the container on first start
2. F1 runs on shared, low-resource infrastructure

This causes `a365 deploy` to report failure with:
```
[Azure] Status: Starting the site... Time: 230(s)
[Azure] Status: Site failed to start. Time: 643(s)
[Azure] ERROR: Deployment failed because the site failed to start within 10 mins.
```

The app actually does start successfully after upgrading to B1 — the code is not the issue, the tier is.

### Expected Behavior

One of the following:
1. CLI should default to `B1` (or at minimum `B1` for the `needDeployment: true` path)
2. OR CLI should print a warning during `a365 setup all`: "F1 tier has a 230s cold-start limit. For Node.js agents, B1 or higher is recommended."
3. OR `a365 deploy` error message should hint that upgrading the App Service Plan tier may resolve the timeout

### SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

### Language/Runtime
Node.js v22.15.0

### OS
Windows 11

### How to Reproduce
1. Run `a365 config init` interactively — accept default SKU (F1)
2. Run `a365 setup all`
3. Build a standard Node.js + TypeScript agent
4. Run `a365 deploy`
5. Observe site fails to start within 230s timeout

### Workaround
```powershell
# Get plan name
az appservice plan list --resource-group <rg> --query "[].name" -o tsv

# Upgrade to B1
az appservice plan update --name <plan-name> --resource-group <rg> --sku B1
```

---

## Issue C — Entra portal "Grant admin consent" button silently deletes `AgentIdentityBlueprint.*` beta permissions (no warning in docs)

**Labels:** `bug`, `documentation`, `security`

### Description

The custom client app registration setup requires two beta Graph permissions that are not visible in the Entra admin center UI:
- `AgentIdentityBlueprint.ReadWrite.All`  
- `AgentIdentityBlueprint.UpdateAuthProperties.All`

The official docs correctly recommend granting these via Graph API `appRoleAssignments` (Option B). However, the docs contain **no warning** about a critical destructive interaction:

**If a Global Admin clicks "Grant admin consent" in the Entra portal AFTER using Option B, it silently deletes both beta `AgentIdentityBlueprint.*` permissions.**

This happens because the portal's consent button calls `POST /oauth2PermissionGrants` which only processes permissions visible in the Entra UI. The beta `appRoleAssignments` are not included in this process and are subsequently removed or overwritten.

The result is that the CLI app loses its most critical permissions with no error message — subsequent `a365` commands fail with cryptic errors such as:
```
[ERR] Failed to create blueprint. Status: Forbidden
```
There is no indication that the permissions were deleted — a developer must manually re-run the Graph API grants to recover.

### Expected Behavior

The documentation for [Custom client app registration](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/custom-client-app-registration) should include a prominent warning box:

> ⚠️ **Do NOT click "Grant admin consent" in the Microsoft Entra admin center** for this app registration after completing Option B. The portal's consent mechanism does not recognise beta permissions and will remove the `AgentIdentityBlueprint.*` grants. All permission grants must be managed exclusively via the Graph API `appRoleAssignments` endpoint.

### SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

### OS
Windows 11

### How to Reproduce
1. Follow Option B in the custom client app registration docs — grant all 5 permissions via `POST /v1.0/servicePrincipals/{id}/appRoleAssignments`
2. Verify all 5 are present in the app's `appRoleAssignments`
3. Open Entra admin center > App registrations > your CLI app > API permissions
4. Click "Grant admin consent for [tenant]" and confirm
5. Re-check `appRoleAssignments` — `AgentIdentityBlueprint.*` grants are now gone

---

## Issue D — Agent 365 blueprint not discoverable in Teams Apps after publishing — only visible via M365 Copilot

**Labels:** `bug`, `documentation`

### Description

The [Create agent instances](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance) documentation and the [Onboard agents](https://learn.microsoft.com/en-us/microsoft-agent-365/onboard) page both state agents appear in:
> "Microsoft 365 Copilot Store under **Agents for your team** or in the **Apps** area in Microsoft Teams"

After completing all steps (admin center upload ✅, Teams Developer Portal configured with Bot Based + Bot ID ✅, app confirmed as `publishingState: published` in Graph API), the blueprint does **not** appear in:
- Teams > Apps > search by name
- Teams > Apps > "Agents for your team" category (category is not visible)

The blueprint **is** discoverable and instantiable via:
- M365 Copilot > Apps > search by name ✅

After creating an instance via M365 Copilot, the agent user then becomes accessible in Teams chat.

### Expected Behavior

Either:
1. The blueprint should appear in Teams Apps search and "Agents for your team" category as documented
2. OR the documentation should clarify that during Frontier preview, the primary discovery path is **M365 Copilot** (not Teams Apps), and that Teams visibility follows after instance creation

This is a significant developer experience issue — without this knowledge, developers assume their deployment is broken when it is actually working correctly.

### SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

### Tenant
ABSx02771022.onmicrosoft.com (Frontier preview enrolled)

### OS
Windows 11 / Teams desktop client (latest)

### How to Reproduce
1. Complete full deployment: `a365 setup all` → `a365 deploy` → `a365 publish` → upload manifest.zip to admin center → configure Teams Dev Portal
2. Confirm app is published: `GET /v1.0/appCatalogs/teamsApps?$filter=distributionMethod eq 'organization'` — app shows `publishingState: published`
3. Open Teams desktop → Apps → search for blueprint display name
4. Observe: app not found in search
5. Open M365 Copilot → Apps → search for same name
6. Observe: app found, Request/Create available

---

## Issue E — Node.js Oryx remote build fails when TypeScript is in devDependencies (standard npm practice)

**Labels:** `bug`, `documentation`, `deployment`

### Description

`a365 deploy` uses Azure App Service Oryx for remote builds. Oryx runs `npm install --production`, which deliberately skips `devDependencies`. 

If TypeScript (`typescript` / `tsc`) is in `devDependencies` — which is standard npm practice and how most Node.js agent templates are structured — the Oryx build fails with:
```
npm run build
> tsc
sh: tsc: not found
npm ERR! code 127
```

This silently causes `a365 deploy` to report the site failed to start, with no clear indication that the root cause is a missing `tsc` binary.

The official Agent 365 Node.js quickstart samples and scaffolded projects place `typescript` in `devDependencies` by convention. This means the default project structure is incompatible with `a365 deploy` on Azure App Service.

### Expected Behavior

One of the following (in order of preference):
1. `a365 deploy` documentation should explicitly state: "For Node.js/TypeScript projects deployed to Azure App Service, `typescript` must be in `dependencies` (not `devDependencies`) to ensure Oryx can run `tsc` during remote build."
2. OR `a365 deploy` should detect TypeScript in `devDependencies` and warn the user before uploading
3. OR `a365 deploy` should compile TypeScript locally before creating the deployment zip, deploying only the compiled `dist/` output (which eliminates the Oryx build dependency on `tsc` entirely)
4. OR quickstart templates and samples should be updated to place `typescript` in `dependencies`

### SDK Version
Microsoft.Agents.A365.DevTools.Cli 1.1.115-preview+fd1f775761

### Language/Runtime
Node.js v22.15.0 / TypeScript 5.4.5

### OS
Windows 11

### How to Reproduce
1. Scaffold a standard Node.js + TypeScript agent project with `typescript` in `devDependencies`
2. Run `a365 deploy`
3. Observe Oryx build failure: `sh: tsc: not found`

### Fix
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

---

## Summary Table

| Issue | Type | Impact | Existing issue? |
|-------|------|--------|----------------|
| A — `a365 publish` doc contradiction | Doc bug | High — developers think publish is automated | No |
| B — F1 tier default causes guaranteed timeout | CLI bug | High — first deployment always fails | No |
| C — Entra consent button deletes beta permissions | Doc/security bug | High — silent failure, hard to diagnose | No |
| D — Blueprint not discoverable in Teams Apps | Doc/platform bug | High — developers think deployment is broken | No |
| E — TypeScript in devDependencies breaks Oryx | Doc/template bug | High — standard project structure is broken | No |
