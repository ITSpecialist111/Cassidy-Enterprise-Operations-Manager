param([int]$MaxCycles = 1, [int]$MaxToolCalls = 30, [int]$MaxWallclockMs = 60000)
$ErrorActionPreference = 'Stop'
$json = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp -o json | ConvertFrom-Json
$ss = ($json | Where-Object { $_.name -eq 'SCHEDULED_SECRET' }).value
if (-not $ss) { throw 'SCHEDULED_SECRET not found' }
"secret-len=$($ss.Length)"
$body = @{ maxCycles = $MaxCycles; maxToolCalls = $MaxToolCalls; maxWallclockMs = $MaxWallclockMs } | ConvertTo-Json
try {
  $r = Invoke-WebRequest -Method POST -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run' -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body $body -TimeoutSec 240
  "STATUS=$($r.StatusCode)"
  $obj = $r.Content | ConvertFrom-Json
  "ok=$($obj.ok)  timestamp=$($obj.timestamp)"
  $obj.result | Select-Object cyclesRun, tasksCompleted, tasksFailed, completionRate, stopReason, toolCallsUsed | Format-List
  "--- Reflection ---"
  $obj.result.reflection
} catch {
  "ERR: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    try {
      $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $sr.ReadToEnd()
    } catch { }
  }
}
