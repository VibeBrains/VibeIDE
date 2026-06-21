# winget-release.ps1 — Publish/update VibeIDE in microsoft/winget-pkgs
#
# Each VibeIDE release is a NEW versioned entry in winget-pkgs (winget keeps every
# version and upgrades users itself — nothing is overwritten). This renders the
# manifest templates (build/winget/*.template) for a version, pins InstallerSha256
# to the PUBLISHED installer, validates, and opens a PR to microsoft/winget-pkgs.
#
# SEPARATE from release-windows.ps1 on purpose: the winget PR is asynchronous and
# out of our control (Microsoft CI + moderation), and it can only run AFTER the
# GitHub Release is live (this script downloads the published .exe to hash it). So
# it is a post-publish step ("Phase 2b"), not part of the release critical path.
#
# Usage (run AFTER Phase 2 publish):
#   .\scripts\winget-release.ps1                 # current product.json version
#   .\scripts\winget-release.ps1 -Version v1.3.2 # explicit version
#   .\scripts\winget-release.ps1 -DryRun         # render + validate only, NO PR
#
# Requires: wingetcreate (winget install Microsoft.WingetCreate), winget, gh (authed).

param(
    [string]$Version = "",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

function Step([string]$m) { Write-Host "▶ $m" -ForegroundColor Yellow }
function OK([string]$m)   { Write-Host "✓ $m" -ForegroundColor Green  }

# ── Identity derived from product.json (single source of truth) ───────────────
$product = Get-Content "$Root\product.json" -Raw | ConvertFrom-Json
if (-not $Version) { $Version = "v$($product.vibeVersion)" }
if ($Version -notmatch '^v(\d+\.\d+\.\d+)$') {
    Write-Error "Version must be vX.Y.Z (got: $Version)"; exit 1
}
$ver     = $Matches[1]
$pkgId   = $product.win32AppUserModelId                # VibeBrains.VibeIDE
$exeName = "$($product.nameShort)Setup.exe"            # VibeIDESetup.exe
$repo    = "VibeBrains/VibeIDE"
$url     = "https://github.com/$repo/releases/download/$Version/$exeName"

# Inno's uninstall key = AppId + "_is1". product.json escapes the leading brace as
# "{{" for Inno; undo it to get the real ProductCode winget matches for upgrades.
$appId       = $product.win32x64AppId -replace '^\{\{', '{'
$productCode = "$appId" + "_is1"

# ── Tooling ───────────────────────────────────────────────────────────────────
if (-not (Get-Command wingetcreate -ErrorAction SilentlyContinue)) {
    Write-Error "wingetcreate not found. Install: winget install Microsoft.WingetCreate"; exit 1
}

# ── 1. Verify the published asset exists (winget pins a STABLE versioned URL) ──
Step "Verifying published asset: $url"
$assetName = gh release view $Version --repo $repo --json assets --jq ".assets[]?.name | select(. == `"$exeName`")" 2>$null
if (-not $assetName) {
    Write-Error "Asset '$exeName' not found on release $Version — run Phase 2 publish first."; exit 1
}
OK "Asset present on release $Version"

# ── 2. SHA256 of the published file (must match the exact bytes users download) ─
Step "Downloading installer to compute SHA256..."
$tmp = Join-Path $env:TEMP $exeName
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
$sha = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToUpperInvariant()
OK "SHA256: $sha"

# ── 3. Render templates → .build/winget/manifests/.../<ver>/ ──────────────────
Step "Rendering manifests for $ver..."
$tplDir = "$Root\build\winget"
$outDir = "$Root\.build\winget\manifests\v\VibeBrains\VibeIDE\$ver"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$map = @{
    "VibeBrains.VibeIDE.yaml"              = "VibeBrains.VibeIDE.yaml.template"
    "VibeBrains.VibeIDE.installer.yaml"    = "VibeBrains.VibeIDE.installer.yaml.template"
    "VibeBrains.VibeIDE.locale.en-US.yaml" = "VibeBrains.VibeIDE.locale.en-US.yaml.template"
}
foreach ($out in $map.Keys) {
    $content = Get-Content "$tplDir\$($map[$out])" -Raw
    $content = $content.Replace('__VERSION__', $ver).
                        Replace('__URL__', $url).
                        Replace('__SHA256__', $sha).
                        Replace('__PRODUCTCODE__', $productCode)
    Set-Content "$outDir\$out" $content -NoNewline -Encoding UTF8
}
OK "Manifests written: $outDir"

# ── 4. Validate locally before opening a PR ───────────────────────────────────
Step "winget validate..."
winget validate --manifest $outDir
if ($LASTEXITCODE -ne 0) { Write-Error "winget validate failed — fix manifests before submitting."; exit 1 }
OK "Manifests valid"

if ($DryRun) {
    OK "Dry run — PR NOT submitted. Review manifests in: $outDir"
    exit 0
}

# ── 5. Submit PR to microsoft/winget-pkgs ─────────────────────────────────────
# wingetcreate forks winget-pkgs under the authed account, pushes a branch and opens
# the PR. The gh token must carry repo/public_repo + workflow scope.
$token = (gh auth token).Trim()
if (-not $token) { Write-Error "No GitHub token (run: gh auth login)"; exit 1 }
Step "Submitting PR to microsoft/winget-pkgs (version $ver)..."
wingetcreate submit $outDir --token $token
if ($LASTEXITCODE -ne 0) { Write-Error "wingetcreate submit failed (exit $LASTEXITCODE)"; exit 1 }
OK "winget PR submitted for $ver. Track: https://github.com/microsoft/winget-pkgs/pulls"
