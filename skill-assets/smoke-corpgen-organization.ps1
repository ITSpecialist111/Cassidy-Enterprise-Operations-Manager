param(
  [int]$Days = 1,
  [int]$MaxCycles = 1,
  [int]$MaxToolCalls = 20,
  [int]$MaxWallclockMs = 60000
)
$ErrorActionPreference = 'Stop'
$json = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp -o json | ConvertFrom-Json
$ss = ($json | Where-Object { $_.name -eq 'SCHEDULED_SECRET' }).value
if (-not $ss) { throw 'SCHEDULED_SECRET not found' }
"secret-len=$($ss.Length)  days=$Days"
$members = @(
  @{
    employeeId   = 'cassidy-ops'
    displayName  = 'Cassidy'
    role         = 'Operations Manager'
    department   = 'Operations'
    responsibilities = @('Coordinate cross-functional tasks','Run morning briefings','Triage Mail/Teams')
  },
  @{
    employeeId   = 'morgan-fin'
    displayName  = 'Morgan'
    role         = 'Finance Agent'
    department   = 'Finance'
    responsibilities = @('Review expense reports','Run weekly P&L digest','Flag budget anomalies')
  },
  @{
    employeeId   = 'harper-hr'
    displayName  = 'Harper'
    role         = 'HR Agent'
    department   = 'People'
    responsibilities = @('Triage HR mailbox','Schedule onboarding','Maintain policy documents')
  }
)
$body = @{
  days = $Days
  concurrent = $true
  members = $members
  maxCycles = $MaxCycles
  maxToolCalls = $MaxToolCalls
  maxWallclockMs = $MaxWallclockMs
} | ConvertTo-Json -Depth 6
try {
  $r = Invoke-WebRequest -Method POST `
    -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/corpgen/organization' `
    -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' `
    -Body $body -TimeoutSec ([math]::Max(600, $Days * $MaxWallclockMs / 1000 + 60))
  "STATUS=$($r.StatusCode)"
  $obj = $r.Content | ConvertFrom-Json
  "ok=$($obj.ok)  members=$($obj.members)"
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
