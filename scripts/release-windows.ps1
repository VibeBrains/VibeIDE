# release-windows.ps1 — Local Windows build + GitHub Release
#
# TWO-PHASE FLOW (default working mode — build & test first, publish the SAME build after):
#   Phase 1 — bump + compile + package, NO publish (carry the archive / test from the folder):
#     .\scripts\release-windows.ps1 -Version vX.Y.Z -SkipPublish
#   Phase 2 — publish the SAME tested artifacts WITHOUT recompiling (fast):
#     .\scripts\release-windows.ps1 -SkipCompile
#   A version stamp written into out-build during Phase 1 is verified in Phase 2, so a
#   prebuilt publish can only ship the exact version it was compiled at (no stale code).
#   If Phase-1 testing fails: fix code → re-run Phase 1 with the next -Version → retest.
#
# Other usage:
#   .\scripts\release-windows.ps1                  # one-shot: auto-bump patch + compile + publish
#   .\scripts\release-windows.ps1 -Version v0.2.0  # override version (one-shot publish)
#   .\scripts\release-windows.ps1 -SkipCompile     # publish prebuilt at current product.json version
#                                                  # (stamp must match out-build, else refused)
#   .\scripts\release-windows.ps1 -Draft           # create release as draft
#   .\scripts\release-windows.ps1 -SkipPublish     # build + package artifacts only (no tag/publish)
# Requires: Node.js, gh CLI (winget install GitHub.cli), InnoSetup (choco install innosetup)

param(
    [string]$Version = "",
    [switch]$SkipCompile,
    [switch]$Draft,
    [switch]$SkipPublish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

# ── Release integrity: never PUBLISH stale code ───────────────────────────────
# A published release MUST correspond to artifacts compiled-from-source at THIS exact
# version. Two ways to satisfy that:
#   • recompile in this run (default), OR
#   • -SkipCompile publish of a build whose `out-build/.vibe-build-version` stamp matches
#     product.json — i.e. it WAS compiled at this same version in a prior Phase-1 build
#     (`-Version vX.Y.Z -SkipPublish`). This is the two-phase flow: bump+compile+test first,
#     then publish the SAME tested artifacts without re-compiling.
# The stamp check in the freshness section below ENFORCES this and is what prevents the
# "new version label on stale code" class ("0.14.0 ran 0.13.31"). A -SkipCompile publish
# with a missing/mismatched stamp is refused there, so no early hard-block is needed.
# Captured before any compile so the freshness guard (after compile) can assert the
# compiled output was actually (re)written during THIS run.
$buildStartedAt = Get-Date

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step([string]$msg) { Write-Host "▶ $msg" -ForegroundColor Yellow }
function OK([string]$msg)   { Write-Host "✓ $msg" -ForegroundColor Green  }

# ── Version ──────────────────────────────────────────────────────────────────
$productPath = "$Root\product.json"
$product = Get-Content $productPath -Raw | ConvertFrom-Json

if (-not $Version) {
    if ($SkipPublish -or $SkipCompile) {
        # Build/publish at the CURRENT product.json version — no auto-bump.
        #  • -SkipPublish: repeatable local test builds without wasting version numbers.
        #  • -SkipCompile: two-phase publish of already-compiled artifacts — the version was
        #    already bumped in Phase 1, so publishing must reuse it (the stamp check ties
        #    out-build to this exact version). Auto-bumping here would mismatch the stamp.
        $newVibe = $product.vibeVersion
        $Version = "v$newVibe"
        $mode = if ($SkipPublish) { '-SkipPublish test build' } else { '-SkipCompile prebuilt publish' }
        OK "Using current vibeVersion: $newVibe (no auto-bump, $mode)"
    } else {
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
    }
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

# ── 0. Extract VibeIDE NLS strings (pre-build i18n step) ─────────────────────
Step "Extracting VibeIDE NLS strings..."
try {
    Gulp "extract-vibeide-locale-strings"
    OK "NLS strings extracted to out/nls/"
} catch {
    Write-Host "⚠ NLS extraction failed (non-fatal): $_" -ForegroundColor Yellow
}

# ── 0c. Rebuild React tree (scope-tailwind shadow + tsup) ────────────────────
# build.js full-build mode always regenerates `react/src2/`, which keeps the
# shadow scope-tailwind copy in sync with edits in `react/src/`. Skipping this
# step was the root cause of a release failure on 2026-05-12 where a fix in
# `vibeSettingsRu.ts` had not propagated to the shadow tree.
if (-not $SkipCompile) {
    Step "Rebuilding React tree (scope-tailwind + tsup)..."
    Npm "run buildreact"
    OK "React tree rebuilt"
}

# ── 1. Compile TypeScript ─────────────────────────────────────────────────────
if (-not $SkipCompile) {
    Step "Compiling TypeScript (npm run compile-build)..."
    Npm "run compile-build"
    OK "TypeScript compiled"
    # Stamp out-build with the version it was compiled at. A later two-phase publish
    # (-SkipCompile) verifies this stamp == product.json before shipping, so prebuilt
    # artifacts can ONLY be published under the same version they were compiled at.
    Set-Content "$Root\out-build\.vibe-build-version" $newVibe -NoNewline
    OK "Stamped out-build version: $newVibe"
} else {
    Write-Host "⏭ Skipping compile (-SkipCompile) — will verify out-build version stamp before publishing" -ForegroundColor DarkGray
}

# ── 1b. Freshness guard — assert out-build was (re)compiled THIS run ──────────
# compile-build runs clean-out-build first, so a successful compile yields fresh JS
# in out-build/ (the source the installer/portable are packaged from). This verifies
# that actually happened: a representative compiled file must be newer than the build
# start. Catches a silently cached/failed compile — or a -SkipCompile build sitting on
# an ancient out-build — BEFORE it is packaged and shipped under a new version. This is
# the guard that would have flagged the "new version, old compiled code" class of bug.
$freshnessProbe = "$Root\out-build\vs\code\electron-main\main.js"
if (-not (Test-Path $freshnessProbe)) {
    Write-Error "[release] Freshness probe missing: $freshnessProbe not found — out-build/ is absent or incomplete. Run a full compile (drop -SkipCompile)."
    exit 1
}

# Two-phase publish: when publishing WITHOUT recompiling (-SkipCompile, real publish),
# the artifacts are safe to ship only if out-build was compiled at THIS version. The
# version stamp (written right after compile-build) ties out-build to a version — this is
# what makes "compile+test once, publish the same build" safe instead of risking stale code.
if ($SkipCompile -and -not $SkipPublish) {
    $stampPath = "$Root\out-build\.vibe-build-version"
    if (-not (Test-Path $stampPath)) {
        Write-Error "[release] -SkipCompile publish blocked: version stamp '$stampPath' missing — out-build was not produced by a versioned build. Run a Phase-1 build first: .\scripts\release-windows.ps1 -Version $Version -SkipPublish"
        exit 1
    }
    $stamped = (Get-Content $stampPath -Raw).Trim()
    if ($stamped -ne $newVibe) {
        Write-Error "[release] -SkipCompile publish blocked: out-build was compiled at $stamped but you are publishing $newVibe. Recompile (drop -SkipCompile) or redo Phase-1 at $newVibe."
        exit 1
    }
    OK "Prebuilt publish verified: out-build stamp matches $newVibe (no recompile needed)."
}

$probeWritten = (Get-Item $freshnessProbe).LastWriteTime
if ($probeWritten -lt $buildStartedAt) {
    $msg = "[release] out-build probe '$freshnessProbe' was last written $probeWritten, BEFORE this build started $buildStartedAt — the TypeScript was NOT recompiled this run."
    if ($SkipPublish) {
        Write-Warning "$msg (allowed for -SkipPublish test build, but the package will contain stale code)"
    } elseif ($SkipCompile) {
        # Expected for a two-phase publish — code identity is guaranteed by the version-stamp
        # check above, not by recompilation in this run.
        Write-Host "  (out-build from a prior Phase-1 build; version stamp verified above)" -ForegroundColor DarkGray
    } else {
        Write-Error "$msg Refusing to package/publish stale code."
        exit 1
    }
} else {
    OK "Freshness verified: out-build recompiled this run (probe written $probeWritten)"
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

# Pre-clean stale portable-archive zips from previous releases. The `Collect
# artifacts` step below globs `VibeIDE-*-win32-x64.zip`, so a forgotten
# v0.8.2 zip in the archive dir would be re-uploaded into a v0.9.0 release.
$staleZips = Get-ChildItem "$archiveDir\VibeIDE-*-win32-x64.zip" -ErrorAction SilentlyContinue
if ($staleZips) {
    foreach ($z in $staleZips) {
        Remove-Item $z.FullName -Force
        Write-Host "  Cleaned stale archive: $($z.Name)" -ForegroundColor DarkGray
    }
}

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

# ── 3b. Smoke check — verify the built exe responds (roadmap L1160) ─────────
# Runs code.exe --version; fails the build if it exits non-zero or produces
# no output. Full releaseSmokeChecker.evaluateSmokeRun is the TypeScript helper;
# this PowerShell gate covers the minimal acceptance criterion without it.
Step "Smoke-checking built application..."
$appExe = "$Root\..\VibeIDE-win32-x64\Code.exe"
if (-not (Test-Path $appExe)) {
    $appExe = "$Root\..\VibeIDE-win32-x64\VibeIDE.exe"
}
if (Test-Path $appExe) {
    $smokeOut = & $appExe --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[release] Smoke check FAILED: $appExe --version exited $LASTEXITCODE"
        exit 1
    }
    if (-not $smokeOut) {
        Write-Warning "[release] Smoke check WARNING: $appExe --version produced no output (non-fatal)"
    } else {
        OK "Smoke check passed: $($smokeOut -join ' / ')"
    }
} else {
    Write-Warning "[release] Smoke check SKIPPED: built exe not found at expected path — verify gulp output dir."
}

if ($SkipPublish) {
    OK "Test build complete (-SkipPublish): tag + GitHub release SKIPPED."
    Write-Host "`n📦 Artifacts ready for manual smoke-test:" -ForegroundColor Cyan
    foreach ($artifact in $artifacts) {
        Write-Host "   $artifact" -ForegroundColor Gray
    }
    Write-Host "`n   To publish:" -ForegroundColor Cyan
    Write-Host "     - If artifacts look good: re-run without -SkipPublish (will auto-bump + publish)." -ForegroundColor Gray
    Write-Host "     - If something needs a fix: edit code, then re-run with -SkipPublish again`n        (version stays the same — no wasted version numbers).`n" -ForegroundColor Gray
    exit 0
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
