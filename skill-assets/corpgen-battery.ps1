param([string]$Secret, [string]$Base = 'https://cassidyopsagent-webapp.azurewebsites.net')
$ErrorActionPreference = 'Continue'
$tests = @(
  @{label='T1 baseline 1cyc';            body=@{secret=$Secret; async=$true; maxCycles=1; maxToolCalls=30; maxWallclockMs=120000}}
  @{label='T2 wider 3cyc';               body=@{secret=$Secret; async=$true; maxCycles=3; maxToolCalls=60; maxWallclockMs=240000}}
  @{label='T3 deep 5cyc';                body=@{secret=$Secret; async=$true; maxCycles=5; maxToolCalls=100; maxWallclockMs=300000}}
  @{label='T4 toolcall starved 1tc';     body=@{secret=$Secret; async=$true; maxCycles=3; maxToolCalls=1; maxWallclockMs=120000}}
  @{label='T5 wallclock starved 30s';    body=@{secret=$Secret; async=$true; maxCycles=10; maxToolCalls=100; maxWallclockMs=30000}}
  @{label='T6 huge 8cyc';                body=@{secret=$Secret; async=$true; maxCycles=8; maxToolCalls=150; maxWallclockMs=420000}}
)
$jobs = @()
foreach ($t in $tests) {
  $r = Invoke-WebRequest -Uri "$Base/api/corpgen/run" -Method POST -Headers @{'Content-Type'='application/json'; 'x-scheduled-secret'=$Secret} -Body ($t.body | ConvertTo-Json) -SkipHttpErrorCheck -TimeoutSec 30
  $j = $r.Content | ConvertFrom-Json
  Write-Host ("ENQUEUED: {0,-30} jobId={1} status={2}" -f $t.label, $j.jobId, $j.status)
  $jobs += [pscustomobject]@{ Test = $t.label; JobId = $j.jobId; t0 = Get-Date; Status='queued' }
}

Write-Host "`nPolling..."
$start = Get-Date
do {
  Start-Sleep -s 20
  $pending = 0
  foreach ($j in $jobs) {
    if ($j.Status -in @('succeeded','failed')) { continue }
    $r = Invoke-WebRequest -Uri "$Base/api/corpgen/jobs/$($j.JobId)" -Headers @{'x-scheduled-secret'=$Secret} -SkipHttpErrorCheck -TimeoutSec 30
    if ($r.StatusCode -ne 200) { $pending++; continue }
    $jd = $r.Content | ConvertFrom-Json
    $j.Status = $jd.status
    Add-Member -InputObject $j -MemberType NoteProperty -Name 'DurationMs' -Value $jd.durationMs -Force
    if ($jd.summary) {
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Cycles' -Value $jd.summary.cyclesRun -Force
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Pct'    -Value ('{0:P0}' -f [double]$jd.summary.completionRate) -Force
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Tools'  -Value $jd.summary.toolCallsUsed -Force
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Stop'   -Value $jd.summary.stopReason -Force
    }
    if ($jd.result) {
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Done' -Value $jd.result.tasksCompleted -Force
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Skip' -Value $jd.result.tasksSkipped   -Force
      Add-Member -InputObject $j -MemberType NoteProperty -Name 'Fail' -Value $jd.result.tasksFailed    -Force
    }
    if ($jd.status -in @('queued','running')) { $pending++ }
  }
  $elapsed = [int]((Get-Date) - $start).TotalSeconds
  $statuses = ($jobs | ForEach-Object { $_.Status }) -join ' '
  Write-Host ("  t+{0,4}s  pending={1}  [{2}]" -f $elapsed, $pending, $statuses)
} while ($pending -gt 0 -and $elapsed -lt 1500)

Write-Host "`n=== SUMMARY ==="
$jobs | Select-Object Test, Status, @{n='Wall_s';e={[int]($_.DurationMs/1000)}}, Cycles, Done, Skip, Fail, Tools, Pct, Stop | Format-Table -AutoSize | Out-String | Write-Host
$jobs | ConvertTo-Json -Depth 4 | Set-Content "$env:TEMP\corpgen-test-results.json"
Write-Host "Results: $env:TEMP\corpgen-test-results.json"
param([string]$Secret)
$ErrorActionPreference = 'Continue'
$tests = @(
  @{label='T1 baseline 1cyc';         body=@{secret=$Secret; maxCycles=1; maxToolCalls=30; maxWallclockMs=120000}}
  @{label='T2 wider 3cyc';            body=@{secret=$Secret; maxCycles=3; maxToolCalls=60; maxWallclockMs=240000}}
  @{label='T3 deep 5cyc';             body=@{secret=$Secret; maxCycles=5; maxToolCalls=100; maxWallclockMs=300000}}
  @{label='T4 toolcall starved 1tc';  body=@{secret=$Secret; maxCycles=3; maxToolCalls=1; maxWallclockMs=120000}}
  @{label='T5 wallclock starved 30s'; body=@{secret=$Secret; maxCycles=10; maxToolCalls=100; maxWallclockMs=30000}}
)
$results = @()
foreach ($t in $tests) {
  Write-Host "RUNNING: $($t.label)"
  $t0 = Get-Date
  try {
    $r = Invoke-WebRequest -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/run' -Method POST -Headers @{'Content-Type'='application/json'; 'x-scheduled-secret'=$Secret} -Body ($t.body | ConvertTo-Json) -SkipHttpErrorCheck -TimeoutSec 600
    $dt = ((Get-Date) - $t0).TotalSeconds
    $j = $r.Content | ConvertFrom-Json
    $rs = $j.result
    $row = [pscustomobject]@{
      Test = $t.label; HTTP = $r.StatusCode; Wall_s = [int]$dt
      Cycles = $rs.cyclesRun; Done = $rs.tasksCompleted; Skip = $rs.tasksSkipped; Fail = $rs.tasksFailed
      Tools = $rs.toolCallsUsed; Pct = '{0:P0}' -f [double]$rs.completionRate; Stop = $rs.stopReason
    }
  } catch {
    $row = [pscustomobject]@{ Test=$t.label; HTTP='ERR'; Wall_s=[int]((Get-Date)-$t0).TotalSeconds; Stop=$_.Exception.Message.Substring(0,[Math]::Min(80,$_.Exception.Message.Length)) }
  }
  $results += $row
}
Write-Host "`n=== SUMMARY ==="
$results | Format-Table -AutoSize | Out-String | Write-Host
$results | ConvertTo-Json | Set-Content "$env:TEMP\corpgen-test-results.json"
