param([switch]$PortableOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$nativeRoot = Join-Path $projectRoot 'src-tauri\target\release'
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

# Drop the fixed-name copy and the local launcher from the old layout so the
# release folder only holds versioned artifacts with an explicit role.
foreach ($legacy in @(
    'CYAPI-Toolbox.exe',
    "CYAPI-Toolbox_${version}.exe",
    "CYAPI-Toolbox_${version}-local.cmd"
)) {
    $path = Join-Path $releaseRoot $legacy
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

$portable = Join-Path $releaseRoot "CYAPI-Toolbox_${version}_portable.exe"
Copy-Item -LiteralPath (Join-Path $nativeRoot 'cyapi-toolbox.exe') -Destination $portable -Force

if (-not $PortableOnly) {
    $setup = Join-Path $nativeRoot "bundle\nsis\CYAPI Toolbox_${version}_x64-setup.exe"
    Copy-Item -LiteralPath $setup -Destination (Join-Path $releaseRoot "CYAPI-Toolbox_${version}_x64-setup.exe") -Force
}

Write-Host "Build artifacts: $releaseRoot"
