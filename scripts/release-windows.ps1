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

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step([string]$msg) { Write-Host "▶ $msg" -ForegroundColor Yellow }
function OK([string]$msg)   { Write-Host "✓ $msg" -ForegroundColor Green  }

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

# ── npm / node helpers (Windows: must use .cmd wrappers) ─────────────────────
function Npm([string]$cmd) {
    cmd /c "npm $cmd"
    if ($LASTEXITCODE -ne 0) { throw "npm $cmd failed (exit $LASTEXITCODE)" }
}
function Gulp([string]$task) {
    cmd /c "node --max-old-space-size=8192 node_modules\gulp\bin\gulp.js $task"
    if ($LASTEXITCODE -ne 0) { throw "gulp $task failed (exit $LASTEXITCODE)" }
}

# ── 1. Compile TypeScript ─────────────────────────────────────────────────────
if (-not $SkipCompile) {
    Step "Compiling TypeScript (npm run compile-build)..."
    Npm "run compile-build"
    OK "TypeScript compiled"
} else {
    Write-Host "⏭ Skipping compile (-SkipCompile)" -ForegroundColor DarkGray
}

# ── 2. Build Windows x64 app ──────────────────────────────────────────────────
Step "Building Windows x64 app..."
Gulp "vscode-win32-x64"
OK "App built"

Step "Copying inno updater tools..."
Gulp "vscode-win32-x64-inno-updater"
OK "Inno updater tools copied"

Step "Building Windows x64 installer (.exe)..."
Gulp "vscode-win32-x64-system-setup"
OK "Installer built"

Step "Building Windows x64 portable archive (.zip)..."
$archiveDir = "$Root\.build\win32-x64\archive"
$zipName    = "VibeIDE-$newVibe-win32-x64.zip"
$zipPath    = "$archiveDir\$zipName"
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
$appSourceDir = "$Root\..\VibeIDE-win32-x64"
Compress-Archive -Path "$appSourceDir\*" -DestinationPath $zipPath -Force
OK "Portable archive built: $zipName"

# ── 3. Collect artifacts ──────────────────────────────────────────────────────
Step "Collecting artifacts..."
$setupDir  = "$Root\.build\win32-x64\system-setup"

$exeFiles = Get-ChildItem "$setupDir\VSCodeSetup*.exe" -ErrorAction SilentlyContinue
$zipFiles  = Get-ChildItem "$archiveDir\VibeIDE-*.zip" -ErrorAction SilentlyContinue

if (-not $exeFiles) { Write-Error "No .exe found in $setupDir"; exit 1 }
if (-not $zipFiles)  { Write-Error "No .zip found in $archiveDir"; exit 1 }

$artifacts = @($exeFiles.FullName) + @($zipFiles.FullName)
Write-Host "  Found:" -ForegroundColor DarkGray
$artifacts | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# ── 3a. Code-sign installer (roadmap §888) ─────────────────────────────────────
# Sign only when VIBE_WIN_CERT=1 and thumbprint configured. Otherwise we leave
# the build unsigned with a clear warning — see references/v1/distribution-signing-runbook.md.
Step "Code-sign Windows installer..."
$signerScript = "$Root\scripts\sign-windows.ps1"
if (Test-Path $signerScript) {
    foreach ($exe in $exeFiles) {
        & $signerScript -Path $exe.FullName -AllowUnsigned -Description "VibeIDE Installer $Version"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[release-windows] sign-windows.ps1 returned $LASTEXITCODE for $($exe.Name)"
            exit $LASTEXITCODE
        }
    }
    OK "Installer signing step complete (signed if cert available, warning emitted otherwise)."
} else {
    Write-Warning "[release-windows] scripts\sign-windows.ps1 missing — installer left unsigned."
}

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
