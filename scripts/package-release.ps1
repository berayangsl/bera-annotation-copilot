$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $repoRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$pluginId = [string]$manifest.id
$version = [string]$manifest.version
$distRoot = Join-Path $repoRoot "dist"
$packageDir = Join-Path $distRoot $pluginId
$bratAssetsDir = Join-Path $distRoot "brat-release-assets"
$zipPath = Join-Path $distRoot "$pluginId-$version.zip"

if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
}

if (Test-Path -LiteralPath $bratAssetsDir) {
    Remove-Item -LiteralPath $bratAssetsDir -Recurse -Force
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
New-Item -ItemType Directory -Path $bratAssetsDir -Force | Out-Null

$requiredFiles = @("manifest.json", "main.js", "styles.css")
foreach ($file in $requiredFiles) {
    $source = Join-Path $repoRoot $file
    if (!(Test-Path -LiteralPath $source)) {
        throw "Missing release file: $source"
    }

    Copy-Item -LiteralPath $source -Destination (Join-Path $packageDir $file) -Force
    Copy-Item -LiteralPath $source -Destination (Join-Path $bratAssetsDir $file) -Force
}

$installGuide = Join-Path $repoRoot "FRIEND_INSTALL.md"
if (Test-Path -LiteralPath $installGuide) {
    Copy-Item -LiteralPath $installGuide -Destination (Join-Path $packageDir "INSTALL.md") -Force
}

Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -Force

Write-Output "Release package created:"
Write-Output $zipPath
Write-Output "BRAT/GitHub release assets prepared:"
Write-Output $bratAssetsDir
