param([string]$Secret, [string]$Base = 'https://cassidyopsagent-webapp.azurewebsites.net')
$ErrorActionPreference = 'Continue'

function Post-Run($body) {
  $r = Invoke-WebRequest -Uri "$Base/api/corpgen/run" -Method POST `
    -Headers @{'Content-Type'='application/json'; 'x-scheduled-secret'=$Secret} `
    -Body ($body | ConvertTo-Json) -SkipHttpErrorCheck -TimeoutSec 30
  return ($r.Content | ConvertFrom-Json)
}
function Get-Job($jobId) {
  $r = Invoke-WebRequest -Uri "$Base/api/corpgen/jobs/$jobId" `
    -Headers @{'x-scheduled-secret'=$Secret} -SkipHttpErrorCheck -TimeoutSec 30
  if ($r.StatusCode -ne 200) { return $null }
  return ($r.Content | ConvertFrom-Json)
}

Write-Host "=== AUTONOMY BATTERY ==="
Write-Host "Base: $Base"
Write-Host ""

# A1: Gating — non-manual phase outside work hours should skip.
# (We're in BST; if you happen to run during 08-16 UTC this just runs normally.)
Write-Host "[A1] phase=cycle force=false → expect work-hours gating (skipped:* OR completed if in window)"
$j = Post-Run @{phase='cycle'; force=$false; async=$true}
Write-Host "     enqueued: $($j.jobId)"
$a1Id = $j.jobId

# A2: phase=init forced (Day Init briefing path)
Write-Host "[A2] phase=init force=true async → Day-Init style cycle"
$j = Post-Run @{phase='init'; force=$true; async=$true}
$a2Id = $j.jobId
Write-Host "     enqueued: $a2Id"

# A3: phase=cycle forced (through-day cycle)
Write-Host "[A3] phase=cycle force=true async → execution cycle"
$j = Post-Run @{phase='cycle'; force=$true; async=$true}
$a3Id = $j.jobId
Write-Host "     enqueued: $a3Id"

# A4: phase=reflect forced (Day End reflection)
Write-Host "[A4] phase=reflect force=true async → Day-End reflection"
$j = Post-Run @{phase='reflect'; force=$true; async=$true}
$a4Id = $j.jobId
Write-Host "     enqueued: $a4Id"

# A5: phase=monthly forced
Write-Host "[A5] phase=monthly force=true async → monthly objective regen"
$j = Post-Run @{phase='monthly'; force=$true; async=$true}
$a5Id = $j.jobId
Write-Host "     enqueued: $a5Id"

$jobs = @(
  [pscustomobject]@{Test='A1 cycle gated';   Id=$a1Id}
  [pscustomobject]@{Test='A2 init forced';   Id=$a2Id}
  [pscustomobject]@{Test='A3 cycle forced';  Id=$a3Id}
  [pscustomobject]@{Test='A4 reflect';       Id=$a4Id}
  [pscustomobject]@{Test='A5 monthly';       Id=$a5Id}
)

Write-Host ""
Write-Host "Polling..."
$start = Get-Date
do {
  Start-Sleep -s 20
  $pending = 0
  foreach ($j in $jobs) {
    if ($j.PSObject.Properties['Status'] -and $j.Status -in @('succeeded','failed')) { continue }
    $jd = Get-Job $j.Id
    if (-not $jd) { $pending++; continue }
    Add-Member -InputObject $j -NotePropertyName 'Status'      -NotePropertyValue $jd.status -Force
    Add-Member -InputObject $j -NotePropertyName 'DurationMs'  -NotePropertyValue $jd.durationMs -Force
    if ($jd.summary) {
      Add-Member -InputObject $j -NotePropertyName 'Cycles' -NotePropertyValue $jd.summary.cyclesRun -Force
      Add-Member -InputObject $j -NotePropertyName 'Tools'  -NotePropertyValue $jd.summary.toolCallsUsed -Force
      Add-Member -InputObject $j -NotePropertyName 'Stop'   -NotePropertyValue $jd.summary.stopReason -Force
    }
    if ($jd.result) {
      Add-Member -InputObject $j -NotePropertyName 'Done' -NotePropertyValue $jd.result.tasksCompleted -Force
      Add-Member -InputObject $j -NotePropertyName 'Skip' -NotePropertyValue $jd.result.tasksSkipped   -Force
      Add-Member -InputObject $j -NotePropertyName 'Fail' -NotePropertyValue $jd.result.tasksFailed    -Force
    }
    if ($jd.status -in @('queued','running')) { $pending++ }
  }
  $elapsed = [int]((Get-Date) - $start).TotalSeconds
  $statuses = ($jobs | ForEach-Object { $_.Status }) -join ' '
  Write-Host ("  t+{0,4}s  pending={1}  [{2}]" -f $elapsed, $pending, $statuses)
} while ($pending -gt 0 -and $elapsed -lt 600)

Write-Host ""
Write-Host "=== SUMMARY ==="
$jobs | Select-Object Test, Status, @{n='Wall_s';e={[int]($_.DurationMs/1000)}}, Cycles, Done, Skip, Fail, Tools, Stop |
  Format-Table -AutoSize | Out-String | Write-Host

Write-Host "=== UTC NOW ==="
[DateTime]::UtcNow.ToString('u') | Write-Host

Write-Host ""
Write-Host "=== A6: scheduler health (jobs created in last 20 min from in-process scheduler) ==="
$cutoff = (Get-Date).ToUniversalTime().AddMinutes(-20)
$all = (Invoke-WebRequest -Uri "$Base/api/corpgen/jobs" -Headers @{'x-scheduled-secret'=$Secret} -TimeoutSec 30).Content | ConvertFrom-Json
$recent = $all.jobs | Where-Object { [DateTime]$_.createdAt -gt $cutoff }
Write-Host ("  jobs in last 20min: {0}" -f $recent.Count)
$recent | Select-Object id, kind, status, createdAt -First 10 | Format-Table -AutoSize | Out-String | Write-Host

$jobs | ConvertTo-Json -Depth 4 | Set-Content "$env:TEMP\autonomy-results.json"
Write-Host "Results: $env:TEMP\autonomy-results.json"
