param(
  [int]$Days = 3,
  [int]$MaxCycles = 2,
  [int]$MaxToolCalls = 40,
  [int]$MaxWallclockMs = 90000,
  [string]$EmployeeId = 'cassidy'
)
$ErrorActionPreference = 'Stop'
$json = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp -o json | ConvertFrom-Json
$ss = ($json | Where-Object { $_.name -eq 'SCHEDULED_SECRET' }).value
if (-not $ss) { throw 'SCHEDULED_SECRET not found' }
"secret-len=$($ss.Length)  days=$Days"
$body = @{
  days = $Days
  employeeId = $EmployeeId
  maxCycles = $MaxCycles
  maxToolCalls = $MaxToolCalls
  maxWallclockMs = $MaxWallclockMs
} | ConvertTo-Json
try {
  $r = Invoke-WebRequest -Method POST `
    -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/multi-day' `
    -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' `
    -Body $body -TimeoutSec ([math]::Max(600, $Days * $MaxWallclockMs / 1000 + 60))
  "STATUS=$($r.StatusCode)"
  $obj = $r.Content | ConvertFrom-Json
  "ok=$($obj.ok)  days=$($obj.days)  avgCompletion=$([math]::Round($obj.avgCompletionRate * 100, 1))%  totalToolCalls=$($obj.totalToolCalls)"
  ""
  $obj.summary
} catch {
  "ERR: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    try {
      $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $sr.ReadToEnd()
    } catch { }
  }
}
