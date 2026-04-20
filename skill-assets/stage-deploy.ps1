# Stage + zip Cassidy source for Oryx deploy
$ErrorActionPreference = 'Stop'
$src = "C:\Users\graham\Documents\GitHub\Cassidy Autonomous\cassidy"
Push-Location $src
try {
    Write-Host "Building locally (npm run build)..."
    npm run build *>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tsc build failed" }
    if (-not (Test-Path "dist\index.js")) { throw "dist/index.js missing after build" }
} finally { Pop-Location }

$staging = Join-Path $env:TEMP 'cassidy-deploy2'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

# Include dist/ — OneDeploy zip-deploy skips Oryx build, so the compiled
# JS must be present in the zip. Exclude node_modules (Oryx still installs).
robocopy $src $staging /E `
    /XD node_modules publish coverage .vitest .git .vscode .nyc_output `
    /XF app.zip *.log .env `
    /NFL /NDL /NJH /NJS /NC /NS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

$leftover = Get-ChildItem -Path $staging -Directory -Recurse -Filter node_modules -ErrorAction SilentlyContinue
if ($leftover) {
    Write-Host "Removing leftover node_modules: $($leftover.Count)"
    $leftover | Remove-Item -Recurse -Force
}

$bytes = (Get-ChildItem -Path $staging -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("Staging size MB: {0}" -f [math]::Round($bytes/1MB,2))
if (-not (Test-Path (Join-Path $staging 'dist\index.js'))) { throw "dist/index.js missing in staging" }

$zip = Join-Path $env:TEMP 'cassidy-deploy.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force -CompressionLevel Optimal

Write-Host "Zip: $zip"
Write-Host ("Zip size MB: {0}" -f [math]::Round((Get-Item $zip).Length/1MB,2))
Get-ChildItem $staging | Select-Object -ExpandProperty Name
