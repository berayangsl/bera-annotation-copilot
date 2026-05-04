$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDir = "C:\Users\sheng\Documents\obsidian\.obsidian\plugins\bera-annotation-copilot"

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$files = @("manifest.json", "main.js", "styles.css")
foreach ($file in $files) {
    $source = Join-Path $projectRoot $file
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing build artifact: $source"
    }

    Copy-Item -LiteralPath $source -Destination (Join-Path $targetDir $file) -Force
}

Write-Host "Installed development plugin to $targetDir"
