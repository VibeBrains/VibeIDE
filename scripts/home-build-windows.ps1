<#
.SYNOPSIS
  home-build-windows.ps1 — build a portable VibeIDE for THIS Windows machine from source.
.DESCRIPTION
  Self-contained bootstrap: installs fnm (via winget) if missing, downloads+activates the
  Node version pinned in .nvmrc, runs `npm ci`, then compiles and packages a runnable app
  folder + a .zip. NO release machinery (no bump, git, signing, publish). Announces its
  intentions and lets you bail out before touching anything.

  NOTE: building native modules on Windows needs the Visual Studio C++ toolchain
  («Desktop development with C++» + Spectre-mitigated libs). See README for the exact
  components — this script does NOT install the VS toolchain (a multi-GB, elevated install).
.PARAMETER Arch
  Target arch: x64 (default) or arm64. Defaults to the host architecture.
.PARAMETER Yes
  Accept the install-and-build plan without the interactive prompt.
#>
[CmdletBinding()]
param(
	[ValidateSet('x64', 'arm64')][string]$Arch,
	[switch]$Yes
)
$ErrorActionPreference = 'Stop'

# --arch / --yes long-form (so the .cmd shim and Unix muscle-memory both work).
foreach ($a in $args) {
	switch -Regex ($a) {
		'^--yes$|^-y$' { $Yes = $true }
		'^--arch$'     { $script:expectArch = $true; continue }
		default        { if ($script:expectArch) { $Arch = $a; $script:expectArch = $false } }
	}
}

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Arch) {
	$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
}
$NodeVer   = (Get-Content "$Root\.nvmrc" -Raw).Trim()
$AppDir    = Join-Path (Split-Path -Parent $Root) "VibeIDE-win32-$Arch"
$ArchiveDir = "$Root\.build\home"
$Archive   = "$ArchiveDir\VibeIDE-win32-$Arch.zip"

function Step($m) { Write-Host "▶ $m" -ForegroundColor Yellow }
function OK($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# ── Intentions gate ───────────────────────────────────────────────────────────
Write-Host ''
Write-Host '╔══════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║  VibeIDE — ДОМАШНЯЯ СБОРКА из исходников                  ║' -ForegroundColor Cyan
Write-Host '╚══════════════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Скрипт выполнит на этой машине следующее:'
Write-Host "  1. Установит fnm (менеджер версий Node) через winget, если его ещё нет."
Write-Host "  2. Скачает и активирует Node $NodeVer (из .nvmrc) через fnm."
Write-Host "  3. Установит зависимости: npm ci (если node_modules отсутствуют)."
Write-Host "  4. Скомпилирует и упакует: Windows $Arch → папка $AppDir + архив $(Split-Path $Archive -Leaf)."
Write-Host ''
Write-Host '  Что НЕ делается: без бампа версии, git-коммитов, подписи и публикации.'
Write-Host '  Требуется заранее: VS Build Tools 2022 (C++ workload + Spectre libs) — см. README.'
Write-Host ''
if (-not $Yes) {
	$reply = Read-Host 'Продолжить? [y/N]'
	if ($reply -notmatch '^(y|yes|да)$') { Write-Host 'Отменено.'; exit 0 }
}

# ── Bootstrap: fnm → Node → dependencies ──────────────────────────────────────
function Ensure-Fnm {
	if (Get-Command fnm -ErrorAction SilentlyContinue) { OK "fnm уже установлен"; return }
	Step 'fnm не найден — устанавливаю через winget...'
	if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
		Die 'winget не найден — установи fnm вручную (https://github.com/Schniz/fnm) и повтори.'
	}
	winget install --id Schniz.fnm -e --accept-package-agreements --accept-source-agreements
	# winget may not refresh PATH in the current session — add the default install dir.
	$fnmDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
	if (Test-Path "$fnmDir\fnm.exe") { $env:Path = "$fnmDir;$env:Path" }
	if (-not (Get-Command fnm -ErrorAction SilentlyContinue)) {
		Die 'fnm установлен, но не виден в PATH — открой новый терминал и повтори.'
	}
	OK 'fnm установлен'
}

function Ensure-Node {
	Step "Устанавливаю/активирую Node $NodeVer через fnm..."
	cmd /c "fnm install $NodeVer" 2>$null
	# Prefix PATH with the version's install dir (per docs/knowledge/build/windows-toolchain.md:
	# `fnm exec --using npm` breaks on Windows, so resolve the dir and prepend it).
	$nodeExe = cmd /c "fnm exec --using=$NodeVer node -e ""process.stdout.write(process.execPath)""" 2>$null
	if (-not $nodeExe) { Die "не удалось активировать Node $NodeVer через fnm." }
	$env:Path = (Split-Path $nodeExe) + ";$env:Path"
	$ver = cmd /c "node -v"
	OK "Node $ver активирован"
}

function Ensure-Deps {
	if (Test-Path "$Root\node_modules\gulp") { OK 'Зависимости на месте — пропускаю npm ci'; return }
	Step 'Устанавливаю зависимости (npm ci)...'
	Push-Location $Root
	try { cmd /c "npm ci"; if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" } }
	finally { Pop-Location }
	if (-not (Test-Path "$Root\node_modules\gulp")) { Die 'npm ci завершился, но node_modules\gulp нет — см. ошибки выше.' }
	OK 'Зависимости установлены'
}

function Gulp($task) {
	cmd /c "node --max-old-space-size=8192 node_modules\gulp\bin\gulp.js $task"
	if ($LASTEXITCODE -ne 0) { throw "gulp $task failed ($LASTEXITCODE)" }
}
function Npm($cmdline) {
	cmd /c "npm $cmdline"
	if ($LASTEXITCODE -ne 0) { throw "npm $cmdline failed ($LASTEXITCODE)" }
}

Ensure-Fnm
Ensure-Node
Push-Location $Root
try {
	Ensure-Deps

	# Pre-package steps gulp doesn't do itself (React tree + .vibe-defaults manifest).
	Step 'Extracting VibeIDE NLS strings...'
	try { Gulp 'extract-vibeide-locale-strings' } catch { Write-Warning 'NLS extraction failed (non-fatal)' }
	Step 'Regenerating embedded artifacts (.vibe-defaults, specs help)...'
	Npm 'run gen:all'
	Step 'Rebuilding React tree (scope-tailwind + tsup)...'
	Npm 'run buildreact'

	Step "Packaging app (gulp vscode-win32-$Arch)..."
	Gulp "vscode-win32-$Arch"
	if (-not (Test-Path $AppDir)) { Die "packaged app dir not found: $AppDir" }
	OK "App built: $AppDir"

	Step 'Building portable .zip...'
	New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
	if (Test-Path $Archive) { Remove-Item $Archive -Force }
	Compress-Archive -Path "$AppDir\*" -DestinationPath $Archive -Force
	OK "Archive: $Archive"
}
finally { Pop-Location }

Write-Host ''
Write-Host '🎉 Готово!' -ForegroundColor Green
Write-Host "  Запуск: $AppDir\VibeIDE.exe"
Write-Host "  Архив:  $Archive"
Write-Host ''
