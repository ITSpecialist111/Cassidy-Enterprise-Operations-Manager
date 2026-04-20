param(
  [ValidateSet('multi-day','organization')]
  [string]$Kind = 'multi-day',
  [int]$Days = 5,
  [int]$MaxCycles = 2,
  [int]$MaxToolCalls = 30,
  [int]$MaxWallclockMs = 60000,
  [int]$PollIntervalSec = 10,
  [int]$MaxWaitSec = 1800
)
$ErrorActionPreference = 'Stop'
$baseUrl = 'https://cassidyopsagent-webapp.azurewebsites.net'
$json = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp -o json | ConvertFrom-Json
$ss = ($json | Where-Object { $_.name -eq 'SCHEDULED_SECRET' }).value
if (-not $ss) { throw 'SCHEDULED_SECRET not found' }
"secret-len=$($ss.Length)  kind=$Kind  days=$Days"

if ($Kind -eq 'multi-day') {
  $body = @{
    async = $true
    days = $Days
    maxCycles = $MaxCycles
    maxToolCalls = $MaxToolCalls
    maxWallclockMs = $MaxWallclockMs
  } | ConvertTo-Json
  $uri = "$baseUrl/api/corpgen/multi-day"
} else {
  $members = @(
    @{ employeeId='cassidy-ops'; displayName='Cassidy'; role='Operations Manager'; department='Operations' },
    @{ employeeId='morgan-fin'; displayName='Morgan'; role='Finance Agent'; department='Finance' },
    @{ employeeId='harper-hr'; displayName='Harper'; role='HR Agent'; department='People' }
  )
  $body = @{
    async = $true
    days = $Days
    members = $members
    maxCycles = $MaxCycles
    maxToolCalls = $MaxToolCalls
    maxWallclockMs = $MaxWallclockMs
    concurrent = $true
  } | ConvertTo-Json -Depth 6
  $uri = "$baseUrl/api/corpgen/organization"
}

$start = Invoke-RestMethod -Method POST -Uri $uri `
  -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body $body -TimeoutSec 60
"jobId=$($start.jobId)  status=$($start.status)"

$jobUri = "$baseUrl$($start.statusUrl)"
$t0 = Get-Date
while ($true) {
  $j = Invoke-RestMethod -Method GET -Uri $jobUri `
    -Headers @{ 'x-scheduled-secret' = $ss } -TimeoutSec 30
  $elapsed = [int]((Get-Date) - $t0).TotalSeconds
  $progress = if ($j.progress) { "$($j.progress.current)/$($j.progress.total) $($j.progress.note)" } else { '-' }
  "[+${elapsed}s] status=$($j.status)  progress=$progress"
  if ($j.status -eq 'succeeded' -or $j.status -eq 'failed') { break }
  if ($elapsed -ge $MaxWaitSec) { "TIMED OUT after ${elapsed}s"; break }
  Start-Sleep $PollIntervalSec
}

if ($j.status -eq 'succeeded') {
  ""
  "=== summary ==="
  $j.summary | Format-List
  if ($Kind -eq 'multi-day' -and $j.result) {
    "=== per-day ==="
    $j.result | ForEach-Object { "  $($_.date) -- $([math]::Round($_.completionRate * 100,0))% completion, $($_.cyclesRun)c/$($_.toolCallsUsed)t, stop=$($_.stopReason)" }
  } elseif ($Kind -eq 'organization' -and $j.result) {
    "=== per-employee ==="
    $j.result | ForEach-Object {
      $e = $_
      $avg = if ($e.results.Count) { ($e.results | Measure-Object -Property completionRate -Average).Average * 100 } else { 0 }
      "  $($e.employeeId) -- $($e.results.Count)d, avg $([math]::Round($avg,0))% completion"
    }
  }
} elseif ($j.status -eq 'failed') {
  "ERROR: $($j.error)"
}
