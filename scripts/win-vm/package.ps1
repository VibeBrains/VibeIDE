# Packages already compiled out-build into win32-x64 artifacts (no recompile, no publish)
$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Python312;C:\Program Files\Python312\Scripts;" + $env:Path
$env:npm_config_arch = 'x64'
$env:VSCODE_ARCH = 'x64'
# Child node processes of the build (the core bundle) do not inherit gulp's heap flag,
# and on a 10 GB machine node's default limit is about 2 GB — the bundle dies of it
$env:NODE_OPTIONS = '--max-old-space-size=8192'
Set-Location C:\b\VibeIDE
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\scripts\release-windows.ps1 -SkipCompile -SkipPublish
if ($LASTEXITCODE -ne 0) { throw "release-windows failed ($LASTEXITCODE)" }
Write-Host 'PACKAGE OK'
