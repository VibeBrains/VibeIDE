# release-windows.ps1 — Local Windows build + GitHub Release
# Usage:
#   .\scripts\release-windows.ps1                  # uses version from product.json
#   .\scripts\release-windows.ps1 -Version v0.2.0  # override version
#   .\scripts\release-windows.ps1 -SkipCompile      # skip npm run compile-build (if already compiled)
#   .\scripts\release-windows.ps1 -Draft            # create release as draft
# Requires: Node.js, gh CLI (winget install GitHub.cli), InnoSetup (choco install innosetup)

param(
    [string]$Version = "",
    [switch]$SkipCompile,
    [switch]$Draft
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

# ── Version ──────────────────────────────────────────────────────────────────
$productPath = "$Root\product.json"
$product = Get-Content $productPath -Raw | ConvertFrom-Json

if (-not $Version) {
    # Auto-bump patch (maintenance) in product.json
    $parts = $product.vibeVersion -split '\.'
    $parts[2] = [string]([int]$parts[2] + 1)
    $newVibe = $parts -join '.'
    $Version = "v$newVibe"

    # Write back to product.json (preserve formatting)
    $raw = Get-Content $productPath -Raw
    $raw = $raw -replace '"vibeVersion"\s*:\s*"[^"]*"', """vibeVersion"": ""$newVibe"""
    Set-Content $productPath $raw -NoNewline
    OK "Bumped vibeVersion: $($product.vibeVersion) → $newVibe (product.json updated)"

    git add $productPath
    git commit -m "chore: bump version to $newVibe"
    git push
} else {
    # Explicit version provided — sync product.json to match
    if ($Version -notmatch '^v(\d+\.\d+\.\d+)$') {
        Write-Error "Version must be in format vX.Y.Z (got: $Version)"
        exit 1
    }
    $newVibe = $Matches[1]
    if ($product.vibeVersion -ne $newVibe) {
        $raw = Get-Content $productPath -Raw
        $raw = $raw -replace '"vibeVersion"\s*:\s*"[^"]*"', """vibeVersion"": ""$newVibe"""
        Set-Content $productPath $raw -NoNewline
        OK "Set vibeVersion: $($product.vibeVersion) → $newVibe (product.json updated)"
        git add $productPath
        git commit -m "chore: bump version to $newVibe"
        git push
    }
}

Write-Host "`n🚀 Building VibeIDE $Version for Windows x64`n" -ForegroundColor Cyan

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step([string]$msg) {
    Write-Host "▶ $msg" -ForegroundColor Yellow
}
function OK([string]$msg) {
    Write-Host "✓ $msg" -ForegroundColor Green
}

# ── 1. Compile TypeScript ─────────────────────────────────────────────────────
if (-not $SkipCompile) {
    Step "Compiling TypeScript (npm run compile-build)..."
    & npm run compile-build
    if ($LASTEXITCODE -ne 0) { Write-Error "compile-build failed"; exit 1 }
    OK "TypeScript compiled"
} else {
    Write-Host "⏭ Skipping compile (-SkipCompile)" -ForegroundColor DarkGray
}

# ── 2. Build Windows x64 app ──────────────────────────────────────────────────
$gulp = "node_modules\gulp\bin\gulp.js"
$node = "node --max-old-space-size=8192"

Step "Building Windows x64 app..."
& node --max-old-space-size=8192 $gulp vscode-win32-x64
if ($LASTEXITCODE -ne 0) { Write-Error "vscode-win32-x64 failed"; exit 1 }
OK "App built"

Step "Building Windows x64 installer (.exe)..."
& node --max-old-space-size=8192 $gulp vscode-win32-x64-setup
if ($LASTEXITCODE -ne 0) { Write-Error "vscode-win32-x64-setup failed"; exit 1 }
OK "Installer built"

Step "Building Windows x64 portable archive (.zip)..."
& node --max-old-space-size=8192 $gulp vscode-win32-x64-archive
if ($LASTEXITCODE -ne 0) { Write-Error "vscode-win32-x64-archive failed"; exit 1 }
OK "Portable archive built"

# ── 3. Collect artifacts ──────────────────────────────────────────────────────
Step "Collecting artifacts..."
$setupDir  = ".build\win32-x64\system-setup"
$archiveDir = ".build\win32-x64\archive"

$exeFiles = Get-ChildItem "$setupDir\VibeIDESetup-*.exe" -ErrorAction SilentlyContinue
$zipFiles  = Get-ChildItem "$archiveDir\VibeIDE-*.zip"   -ErrorAction SilentlyContinue

if (-not $exeFiles) { Write-Error "No .exe found in $setupDir"; exit 1 }
if (-not $zipFiles)  { Write-Error "No .zip found in $archiveDir"; exit 1 }

$artifacts = @($exeFiles.FullName) + @($zipFiles.FullName)
Write-Host "  Found:" -ForegroundColor DarkGray
$artifacts | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# ── 4. Git tag ────────────────────────────────────────────────────────────────
Step "Creating git tag $Version..."
$tagExists = git tag -l $Version
if ($tagExists) {
    Write-Host "  Tag $Version already exists, skipping" -ForegroundColor DarkGray
} else {
    git tag $Version
    git push origin $Version
    OK "Tag $Version pushed"
}

# ── 5. GitHub Release ─────────────────────────────────────────────────────────
Step "Creating GitHub Release $Version..."

$releaseArgs = @(
    "release", "create", $Version,
    "--title", "VibeIDE $Version",
    "--generate-notes"
)
if ($Draft) { $releaseArgs += "--draft" }
$releaseArgs += $artifacts

& gh @releaseArgs
if ($LASTEXITCODE -ne 0) { Write-Error "gh release create failed"; exit 1 }

OK "Release $Version published!"
Write-Host "`n🎉 Done! https://github.com/VibeIDETeam/VibeIDE/releases/tag/$Version`n" -ForegroundColor Cyan
