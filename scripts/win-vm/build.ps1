# Builds VibeIDE win32-x64 artifacts for a published tag: .\build.ps1 -Tag v1.24.0
# The toolchain runs native (ARM64 node, esbuild, tsgo); only the target is x64.
# Running the tools as x64 under emulation hangs: an esbuild service fails to exit under parallel load
# and keeps the output pipes of sibling builds open, so gulp waits forever
param([Parameter(Mandatory)][string]$Tag)
$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Python312;C:\Program Files\Python312\Scripts;" + $env:Path
$env:npm_config_arch = 'x64'
$env:VSCODE_ARCH = 'x64'
# Child node processes of the build (the core bundle) do not inherit gulp's heap flag,
# and on a 10 GB machine node's default limit is about 2 GB — the bundle dies of it
$env:NODE_OPTIONS = '--max-old-space-size=8192'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:npm_config_cache = 'C:\b\npm-cache'
$repo = 'C:\b\VibeIDE'
Write-Host "node $(node -v) host $(node -p process.arch) target $env:npm_config_arch"
if ((node -p process.arch) -ne 'arm64') { throw 'expected the native arm64 node first in PATH' }
git config --global core.longpaths true
if (-not (Test-Path $repo)) {
  git clone --branch $Tag --recurse-submodules https://github.com/VibeBrains/VibeIDE.git $repo
} else {
  git -C $repo fetch --tags origin
  git -C $repo checkout --force $Tag
  git -C $repo submodule update --init --recursive
}
Set-Location $repo
Write-Host "at $(git rev-parse --short HEAD) $(git describe --tags)"
# `npm ci` refuses: the lock lists ssh2's optional cpu-features without an entry of its own
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
# Prebuilt platform packages follow the host cpu, not the target — align what ships
node C:\crossDeps.mts .
if ($LASTEXITCODE -ne 0) { throw "crossDeps failed ($LASTEXITCODE)" }
git --no-pager diff --stat package-lock.json
git checkout -- package-lock.json
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\scripts\release-windows.ps1 -SkipPublish
if ($LASTEXITCODE -ne 0) { throw "release-windows failed ($LASTEXITCODE)" }
Write-Host 'BUILD OK'
