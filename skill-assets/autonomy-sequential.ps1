param([string]$Secret, [string]$Base = 'https://cassidyopsagent-webapp.azurewebsites.net')
$phases = 'init','cycle','reflect','monthly'
$results = @()
foreach ($p in $phases) {
  Write-Host "[seq] phase=$p force=true async..."
  $r = Invoke-WebRequest -Uri "$Base/api/corpgen/run" -Method POST `
    -Headers @{'Content-Type'='application/json'; 'x-scheduled-secret'=$Secret} `
    -Body (@{phase=$p; force=$true; async=$true} | ConvertTo-Json) -SkipHttpErrorCheck -TimeoutSec 30
  $j = $r.Content | ConvertFrom-Json
  $id = $j.jobId
  Write-Host "  enqueued $id"
  $start = Get-Date
  $jd = $null
  do {
    Start-Sleep -s 15
    $resp = Invoke-WebRequest "$Base/api/corpgen/jobs/$id" -Headers @{'x-scheduled-secret'=$Secret} -SkipHttpErrorCheck -TimeoutSec 30
    if ($resp.StatusCode -ne 200) { continue }
    $jd = $resp.Content | ConvertFrom-Json
    $el = [int]((Get-Date) - $start).TotalSeconds
    Write-Host "  t+${el}s status=$($jd.status)"
  } while ($jd.status -in @('queued','running') -and $el -lt 240)
  $results += [pscustomobject]@{
    Phase = $p
    Status = $jd.status
    Wall_s = if ($jd.durationMs) { [int]($jd.durationMs/1000) } else { 'n/a' }
    Stop = if ($jd.summary) { $jd.summary.stopReason } else { '-' }
    Done = if ($jd.result) { $jd.result.tasksCompleted } else { '-' }
    Tools = if ($jd.summary) { $jd.summary.toolCallsUsed } else { '-' }
  }
}
Write-Host ""
Write-Host "=== SEQUENTIAL PHASE RESULTS ==="
$results | Format-Table -AutoSize | Out-String | Write-Host
