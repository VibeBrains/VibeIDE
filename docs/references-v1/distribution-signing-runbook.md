# Distribution signing runbook

> Status: operator runbook.
> Source: roadmap §888 (Distribution readiness gate).
> Pure policy: `src/vs/workbench/contrib/vibeide/common/distributionSigningPolicy.ts`.
> Scripts: `scripts/sign-windows.ps1`, `scripts/notarize-macos.sh`.

## Overview

VibeIDE's release pipeline is wired to sign on **all four platforms** but
fails-loud and skips signing when credentials are missing. This document
lists the credentials needed, where to acquire them, and the env vars the
release scripts read.

The Distribution readiness gate (§888) requires **all four** to be ready:
- Windows EV cert ($300/y).
- macOS Apple Developer ($99/y) — covers x64 + arm64 (Universal Binary).
- ARM Linux build matrix entry.
- Linux GPG key (optional, only for repo-style .deb/.rpm signing).

Until all four are in place, releases ship unsigned with explicit warnings.

## Windows: EV code signing

### Acquire

1. Vendor: **Sectigo** (~$300/y, hardware-token delivery in 5-10 days) or
   **DigiCert** (~$500/y, USB token, faster delivery).
2. Choose **Extended Validation (EV)** — required for SmartScreen reputation.
   Standard / OV certs trigger SmartScreen "unrecognized publisher" until
   they accumulate downloads. EV is reputation-bypass on day one.
3. The cert ships on a USB hardware token (FIPS 140-2 device). Plug it into
   the signing host before `release-windows.ps1` runs — the cert can't be
   exported.

### Configure

```powershell
# In a PowerShell session on the signing host:
$env:VIBE_WIN_CERT = '1'

# Find the thumbprint:
Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -Match 'VibeIDE'
$env:VIBE_WIN_CERT_THUMBPRINT = '<sha1 thumbprint from the cert above>'

# Default timestamp server is Sectigo's; override if DigiCert:
$env:VIBE_WIN_TIMESTAMP_URL = 'http://timestamp.digicert.com'
```

### Test

```powershell
.\scripts\sign-windows.ps1 -Path .\test-payload.exe -DryRun
# Then real:
.\scripts\sign-windows.ps1 -Path .\test-payload.exe
```

The script invokes `signtool sign /sha1 <thumb> /t <timestamp> /fd sha256
/td sha256 /d "VibeIDE"` and verifies the result. Hardware-token user
presence is required (PIN prompt on signing host).

### CI integration constraint

EV tokens require user presence — they cannot be automated on hosted CI
without expensive cloud HSM tokens (DigiCert KeyLocker, $1.5k+/y). Two
practical paths:
- **Self-hosted runner** with the token plugged in (cheapest).
- **DigiCert KeyLocker / Azure Key Vault** with cloud-HSM token.

For now, releases sign on the maintainer's workstation.

## macOS: Notarization

### Acquire

1. Apple Developer account: **https://developer.apple.com/programs/** ($99/y).
2. Once enrolled, generate an **app-specific password**:
   - https://appleid.apple.com/account/manage → Sign-In and Security →
     App-Specific Passwords → Generate.
3. Find your Team ID: developer.apple.com → Membership → Team ID
   (10-char alphanumeric).

### Configure

```bash
export APPLE_ID='dev@example.com'
export APPLE_TEAM_ID='ABC1234567'
export APPLE_APP_PASSWORD='abcd-efgh-ijkl-mnop'  # app-specific
export VIBE_MAC_NOTARIZE=1
```

### Test

```bash
./scripts/notarize-macos.sh --dry-run path/to/VibeIDE.dmg
./scripts/notarize-macos.sh path/to/VibeIDE.dmg
```

The script calls `xcrun notarytool submit ... --wait` and then
`xcrun stapler staple` to embed the ticket in the .dmg/.app. `xcrun
stapler validate` is the post-step that confirms the ticket is attached.

### Universal Binary

`darwin-universal` requires `lipo` to combine the x64 and arm64 builds.
That step is part of `scripts/build-macos-universal.sh` (skeleton — TODO
once the macOS build host is provisioned). Both per-arch builds must be
notarized before merging; the merged universal binary is then re-signed
and re-notarized.

## Linux: ARM + GPG (optional)

ARM Linux build matrix entry is a CI / cross-compile concern, not a signing
one. Add `linux-arm64` to the runner matrix in `release-linux.sh` (TODO).

GPG signing is only required for distro repository (.deb / .rpm) integration:

```bash
export VIBE_LINUX_GPG_KEY='0123456789ABCDEF'  # long key ID
```

Tarballs and AppImages do not require code-signing on Linux.

## Readiness gate verification

Run `node scripts/check-distribution-readiness.mjs` (TODO — convenience
wrapper around `evaluateReadinessGate`) before tagging a release. The gate
returns `ready` only when all four platforms can be signed.

In the meantime, the release scripts emit per-step warnings:

```
[sign-windows] WARNING: VIBE_WIN_CERT != 1 — leaving 'VSCodeSetup-x64.exe' unsigned (--AllowUnsigned).
[sign-windows] WARNING: Build will trigger Windows SmartScreen 'unrecognized publisher'.
```

Operator decides whether to ship the unsigned build (e.g. for nightly /
internal testing) or block the release until cert is in place.

## Cost summary (year-one)

| Item | Cost | Recurring? |
|---|---:|---|
| Sectigo EV cert + USB token | $300 | yearly |
| Apple Developer account | $99 | yearly |
| ARM Linux runner (cloud or self-hosted) | $0-$50/mo | monthly |
| DigiCert KeyLocker (optional, for CI signing) | $1500+ | yearly |
| **Minimum gate cost** | **~$400/y** | |

The minimum gate ($400/y) covers a workstation-signed Windows + macOS
release with self-hosted ARM Linux. CI-signed Windows ($1500+/y) is a
later optimization.
