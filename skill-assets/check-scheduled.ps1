$ErrorActionPreference = 'Stop'
$json = az webapp config appsettings list -g rg-cassidy-ops-agent -n cassidyopsagent-webapp -o json | ConvertFrom-Json
$ss = ($json | Where-Object { $_.name -eq 'SCHEDULED_SECRET' }).value
"len=$($ss.Length)"
try {
  $r = Invoke-WebRequest -Method POST -Uri 'https://cassidyopsagent-webapp.azurewebsites.net/api/scheduled' -Headers @{ 'x-scheduled-secret' = $ss } -ContentType 'application/json' -Body '{}' -TimeoutSec 60
  "scheduled STATUS=$($r.StatusCode)"
  $r.Content
} catch {
  "scheduled ERR: $($_.Exception.Message)"
}
