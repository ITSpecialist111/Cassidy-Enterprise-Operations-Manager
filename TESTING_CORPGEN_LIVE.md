# CorpGen Live Test Procedure

CorpGen is wired into the running Cassidy bot. Two surfaces are live:

| Surface | Path | Auth |
|---|---|---|
| **Teams / chat (LLM tool)** | bot calls `cg_run_workday` | normal Teams sign-in |
| **Operator HTTP** | `POST https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run` | `x-scheduled-secret: $SCHEDULED_SECRET` |

Verified end-to-end on `2026-04-20`: deploy `33936059…366f` returned `RuntimeSuccessful`; HTTP smoke returned `STATUS=200` with a real `DayRunResult` (1 cycle, 2 tool calls, reflection generated).

---

## 1. Operator HTTP smoke (one-liner)

```powershell
pwsh -NoProfile -File "skill-assets\smoke-corpgen-http.ps1"
```

Expected:

```
secret-len=22
STATUS=200
ok=True  timestamp=...
cyclesRun, completionRate, stopReason, toolCallsUsed, reflection
```

The script auto-resolves `SCHEDULED_SECRET` from the webapp's app settings.

### Custom payload

```powershell
$secret = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp `
  --query "[?name=='SCHEDULED_SECRET'].value" -o tsv
$body = @{
  maxCycles = 3
  maxWallclockMs = 600000   # 10 min
  maxToolCalls = 200
  employeeId = "cassidy"
} | ConvertTo-Json
Invoke-RestMethod -Method POST `
  -Uri "https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run" `
  -Headers @{ "x-scheduled-secret" = $secret; "Content-Type" = "application/json" } `
  -Body $body
```

---

## 2. Teams test

In any Cassidy chat, send any of:

- *"Cassidy, run an autonomous workday."*
- *"Run a CorpGen workday for me."*
- *"Do a 5-cycle autonomous run and tell me what shipped."*

Cassidy should call `cg_run_workday` and reply with a markdown summary of the form:

```
**Workday complete** — 1 cycle • 2 tool calls • stop: cycle_cap

**Reflection**
- Shipped: …
- Stalled: …
- Tomorrow focus: …
```

If the bot replies with prose only (no tool call), increase intent strength: *"Run the cg_run_workday tool now with maxCycles=2."*

---

## 3. What "good" looks like

- HTTP 200 with `cyclesRun ≥ 1`, `toolCallsUsed ≥ 1`, `reflection` non-empty
- `stopReason ∈ { cycle_cap | wallclock_cap | tool_call_cap | shutdown }`
- App log shows `"CorpGen workday starting"` then `"Workday complete"` (no `"CorpGen run failed"`)
- No `TableNotFound` errors thrown to the response

## 4. Tail logs while testing

```powershell
az webapp log tail -g rg-cassidy-ops-agent -n cassidyopsagent-webapp
```

## 5. Full regression matrix

See [TESTING_CORPGEN.md](TESTING_CORPGEN.md) for the 11-scenario test matrix (single workday, multi-day, organisation, comm fallback, artifact judge, etc.). Local baseline: `npm --prefix cassidy test` → **513/513 in 45 suites**.
