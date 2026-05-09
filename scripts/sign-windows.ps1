# sign-windows.ps1 — Windows signtool wrapper for VibeIDE installer/exe.
#
# Roadmap §888 (Distribution readiness gate / Win EV cert).
# Pure helper: src/vs/workbench/contrib/vibeide/common/distributionSigningPolicy.ts
# Runbook: references/v1/distribution-signing-runbook.md
#
# Usage (release flow):
#   .\scripts\sign-windows.ps1 -Path .build\installer\VibeIDE-Setup.exe
#
# Usage (dry-run, no actual sign):
#   .\scripts\sign-windows.ps1 -Path .\foo.exe -DryRun
#
# Required env (set by CI / operator before invocation):
#   $env:VIBE_WIN_CERT_THUMBPRINT  # SHA1 thumbprint of EV cert in Cert:\CurrentUser\My
#   $env:VIBE_WIN_CERT             # set to "1" to enable signing (gate flag)
#   $env:VIBE_WIN_TIMESTAMP_URL    # default http://timestamp.sectigo.com
#
# EV certificates are typically on a hardware token (Sectigo / DigiCert) and
# require user presence on the signing host. CI integration is constrained
# accordingly — see runbook.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$Description = 'VibeIDE',

    [switch]$DryRun,

    [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
    Write-Error "[sign-windows] target not found: $Path"
    exit 1
}

$gate = $env:VIBE_WIN_CERT
$thumbprint = $env:VIBE_WIN_CERT_THUMBPRINT
$timestampUrl = if ($env:VIBE_WIN_TIMESTAMP_URL) { $env:VIBE_WIN_TIMESTAMP_URL } else { 'http://timestamp.sectigo.com' }

if ($gate -ne '1' -or -not $thumbprint) {
    if ($AllowUnsigned) {
        Write-Warning "[sign-windows] VIBE_WIN_CERT != 1 or thumbprint missing — leaving '$Path' unsigned (--AllowUnsigned)."
        Write-Warning "[sign-windows] Build will trigger Windows SmartScreen 'unrecognized publisher' on user machines."
        exit 0
    }
    Write-Error @"
[sign-windows] No signing credentials. Set:
  `$env:VIBE_WIN_CERT = '1'
  `$env:VIBE_WIN_CERT_THUMBPRINT = '<sha1 thumbprint>'

For dev/nightly builds, pass -AllowUnsigned. For release, acquire an EV cert
(Sectigo ~`$300/y) and follow references/v1/distribution-signing-runbook.md.
"@
    exit 2
}

# Locate signtool.exe — prefer Windows SDK install over PATH.
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
    $candidates = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending
    if ($candidates) { $signtool = $candidates[0].FullName }
}
if (-not $signtool) {
    Write-Error '[sign-windows] signtool.exe not found. Install Windows 10/11 SDK.'
    exit 3
}

$signtoolPath = if ($signtool -is [string]) { $signtool } else { $signtool.Source }

$args = @(
    'sign',
    '/sha1', $thumbprint,
    '/t', $timestampUrl,
    '/fd', 'sha256',
    '/td', 'sha256',
    '/d', $Description
)
$args += $Path

if ($DryRun) {
    Write-Host "[sign-windows] DRY RUN — would invoke:"
    Write-Host "  $signtoolPath $($args -join ' ')"
    exit 0
}

Write-Host "[sign-windows] signing $Path with thumbprint $($thumbprint.Substring(0, 8))..."
& $signtoolPath @args
if ($LASTEXITCODE -ne 0) {
    Write-Error "[sign-windows] signtool failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

# Verify the signature attached.
& $signtoolPath verify /pa /v $Path
if ($LASTEXITCODE -ne 0) {
    Write-Error '[sign-windows] post-sign verification failed.'
    exit $LASTEXITCODE
}

Write-Host "[sign-windows] OK — $Path is signed and timestamped."
