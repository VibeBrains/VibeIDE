# Installs the toolchain for building VibeIDE win32-x64 on this ARM64 VM. Idempotent.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dl = 'C:\dl'; New-Item -ItemType Directory -Force $dl, 'C:\tools' | Out-Null
function Get-File($url, $name) { $p = Join-Path $dl $name; if (-not (Test-Path $p)) { Write-Host "download $name"; Invoke-WebRequest $url -OutFile $p -UseBasicParsing }; $p }

# Git
if (-not (Test-Path 'C:\Program Files\Git\cmd\git.exe')) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
  $a = $rel.assets | Where-Object name -match '^Git-.*-arm64\.exe$' | Select-Object -First 1
  $p = Get-File $a.browser_download_url $a.name
  Start-Process $p -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-' -Wait
  Write-Host 'git installed'
}

# Node 24.18.0 x64 (the build targets x64; runs under emulation)
if (-not (Test-Path 'C:\tools\node-x64\node.exe')) {
  $p = Get-File 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip' 'node-v24.18.0-win-x64.zip'
  Expand-Archive $p 'C:\tools' -Force
  Rename-Item 'C:\tools\node-v24.18.0-win-x64' 'node-x64'
  Write-Host 'node x64 installed'
}

# Python (node-gyp)
if (-not (Test-Path 'C:\Program Files\Python312\python.exe')) {
  $p = Get-File 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' 'python-3.12.10-amd64.exe'
  Start-Process $p -ArgumentList '/quiet','InstallAllUsers=1','PrependPath=1','Include_test=0' -Wait
  Write-Host 'python installed'
}

# PowerShell 7: the release script is UTF-8 without BOM, which Windows PowerShell 5.1 misreads
if (-not (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe')) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest' -UseBasicParsing
  $a = $rel.assets | Where-Object name -match '-win-arm64\.msi$' | Select-Object -First 1
  $p = Get-File $a.browser_download_url $a.name
  Start-Process msiexec.exe -ArgumentList '/i', $p, '/quiet', '/norestart' -Wait
  Write-Host 'pwsh installed'
}

# InnoSetup: not installed — the build takes ISCC.exe from the `innosetup` npm package

# VS 2022 Build Tools: C++ x64 + Spectre libs + Windows SDK (signtool)
if (-not (Test-Path 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC')) {
  $p = Get-File 'https://aka.ms/vs/17/release/vs_BuildTools.exe' 'vs_BuildTools.exe'
  $vsArgs = @('--quiet','--wait','--norestart','--nocache',
    '--add','Microsoft.VisualStudio.Workload.VCTools',
    '--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add','Microsoft.VisualStudio.Component.VC.Tools.ARM64',
    '--add','Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
    '--add','Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre',
    '--add','Microsoft.VisualStudio.Component.Windows11SDK.26100',
    '--includeRecommended')
  $proc = Start-Process $p -ArgumentList $vsArgs -Wait -PassThru
  Write-Host "vs build tools exit $($proc.ExitCode)"
}
Write-Host 'tools done'
