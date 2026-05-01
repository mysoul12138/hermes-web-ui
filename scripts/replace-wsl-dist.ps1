[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-Hermes",
    [string]$PackageDir = "/home/xl/.npm-global/lib/node_modules/hermes-web-ui",
    [string]$SourceDist = "/mnt/e/BaiduNetdiskDownload/auto/HermesWebUi_fork_main_latest/dist",
    [switch]$DeleteOlderBackups
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    $fullPath = [System.IO.Path]::GetFullPath($WindowsPath)
    $normalized = $fullPath.Replace('\', '/')
    if ($normalized -match '^([A-Za-z]):/(.*)$') {
        $drive = $matches[1].ToLower()
        $rest = $matches[2]
        return "/mnt/$drive/$rest"
    }

    throw "Cannot convert to WSL path: $WindowsPath"
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "wsl.exe not found"
}

if ($DeleteOlderBackups) {
    $cleanupFlag = "1"
}
else {
    $cleanupFlag = "0"
}

$tempFileName = "replace-hermes-dist-" + $PID + ".sh"
$tempScript = Join-Path -Path $env:TEMP -ChildPath $tempFileName
$wslTempScript = ConvertToWslPath -WindowsPath $tempScript

$bashLines = @(
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "pkg='$PackageDir'",
    "src='$SourceDist'",
    "cleanup_old='$cleanupFlag'",
    "",
    "if [ ! -d ""`$src"" ]; then",
    "  echo ""source dist not found: `$src"" >&2",
    "  exit 1",
    "fi",
    "",
    "if [ ! -d ""`$pkg"" ]; then",
    "  echo ""package dir not found: `$pkg"" >&2",
    "  exit 1",
    "fi",
    "",
    "if [ ! -d ""`$pkg/dist"" ]; then",
    "  echo ""target dist not found: `$pkg/dist"" >&2",
    "  exit 1",
    "fi",
    "",
    "ts=`$(date +%Y%m%d-%H%M%S)",
    "new_dist=""`$pkg/dist.new-`$ts""",
    "backup_dist=""`$pkg/dist.backup-`$ts""",
    "",
    "cp -a ""`$src"" ""`$new_dist""",
    "mv ""`$pkg/dist"" ""`$backup_dist""",
    "mv ""`$new_dist"" ""`$pkg/dist""",
    "",
    "if [ ""`$cleanup_old"" = ""1"" ]; then",
    "  find ""`$pkg"" -mindepth 1 -maxdepth 1 -type d -name ""dist.backup-*"" ! -path ""`$backup_dist"" -exec rm -rf {} +",
    "fi",
    "",
    "echo ""dist replaced""",
    "echo ""new dist: `$pkg/dist""",
    "echo ""backup: `$backup_dist""",
    "sha256sum ""`$src/server/index.js"" ""`$pkg/dist/server/index.js"""
)

$bashContent = ($bashLines -join "`n") + "`n"
[System.IO.File]::WriteAllText($tempScript, $bashContent, [System.Text.Encoding]::ASCII)

Write-Host "Replacing WSL dist..."
Write-Host "Distro: $Distro"
Write-Host "Source: $SourceDist"
Write-Host "Target: $PackageDir/dist"

try {
    & wsl.exe -d $Distro -- bash $wslTempScript
}
finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. Restart the service when ready."
