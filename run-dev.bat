@echo off
setlocal enabledelayedexpansion
REM VibeIDE dev launch from repo root (see scripts\vibe-dev.bat).
REM   run-dev.bat              - обычный запуск (профиль не чистим).
REM   run-dev.bat --compile    - сначала `npm run compile`, затем запуск (full compile; если
REM                              компиляция упала - запуск НЕ происходит). Флаг в Electron не уходит.
REM   run-dev.bat --clear      - снести профиль dev: %%APPDATA%%\vibeide-dev-dev (+ legacy vibeide-dev),
REM                              %%LOCALAPPDATA%%\vibeide-dev-dev, %%USERPROFILE%%\.vibeide-shared, %%USERPROFILE%%\.vibeide.
REM   Флаги комбинируются: `run-dev.bat --compile --clear`.
REM   Остальные аргументы пробрасываются в Electron как раньше.
REM   Загрузка Electron: по умолчанию npmmirror, если не заданы VIBE_ELECTRON_MIRROR/ELECTRON_MIRROR
REM   (отключить fallback: set VIBE_NO_ELECTRON_MIRROR_FALLBACK=1 перед вызовом).

REM Strip --compile out of the args (the rest are forwarded to vibe-dev.bat / Electron verbatim).
set "DO_COMPILE="
set "FWD_ARGS="
:parse_args
if "%~1"=="" goto after_args
if /i "%~1"=="--compile" (
	set "DO_COMPILE=1"
) else (
	set "FWD_ARGS=!FWD_ARGS! %1"
)
shift
goto parse_args
:after_args

REM Ensure Node/npm/npx are callable for BOTH steps: --compile (npm) and the launch itself
REM (scripts\vibe-dev.bat shells out to npx/node and resolves the Electron path via node).
call :ensure_npm

if not defined DO_COMPILE goto launch
echo [run-dev] --compile: running `npm run compile`...
call npm run compile
if !errorlevel! neq 0 (
	echo [run-dev] Compile failed ^(exit !errorlevel!^) -- aborting launch.
	exit /b 1
)

:launch
call "%~dp0scripts\vibe-dev.bat" !FWD_ARGS!
exit /b !errorlevel!

REM ---- pin the project's Node (.nvmrc) ahead of any system Node ----------------
REM The build MUST run under the version pinned in .nvmrc (24.18.0 since VibeIDE 1.15.1, when the
REM base moved to VS Code 1.133): it matches the Electron runtime and the build toolchain, and
REM build/npm/preinstall.ts refuses to install under a different major. A standalone system Node at
REM C:\Program Files\nodejs otherwise shadows fnm on PATH and silently breaks the build. Therefore
REM ALWAYS resolve the fnm install dir for the pinned version and prepend it; do NOT early-out just
REM because some npm is already on PATH. `fnm exec ... npm` can't spawn a .cmd, so we locate the dir.
:ensure_npm
set "NODE_VER=24.18.0"
if exist "%~dp0.nvmrc" for /f "usebackq tokens=* delims=" %%v in ("%~dp0.nvmrc") do set "NODE_VER=%%v"
REM Search KNOWN fnm roots for the installed version's bin dir. FNM_DIR may be unset OR point
REM somewhere the versions don't actually live (observed), so we check all candidates, not just it.
set "NODE_DIR="
call :try_root "%FNM_DIR%"
if not defined NODE_DIR call :try_root "%APPDATA%\fnm"
if not defined NODE_DIR call :try_root "%LOCALAPPDATA%\fnm"
if not defined NODE_DIR call :try_root "%USERPROFILE%\.fnm"
if defined NODE_DIR goto :ensure_npm_have
REM Last resort: ask fnm to run node and report its own dir (also honors a non-default FNM_DIR).
for /f "usebackq delims=" %%i in (`fnm exec --using "%NODE_VER%" node -e "process.stdout.write(require('path').dirname(process.execPath))" 2^>nul`) do set "NODE_DIR=%%i"
if not defined NODE_DIR goto :ensure_npm_fail
:ensure_npm_have
set "PATH=%NODE_DIR%;%PATH%"
echo [run-dev] pinned project Node %NODE_VER% from "%NODE_DIR%".
goto :eof
:ensure_npm_fail
echo [run-dev] WARNING: pinned Node %NODE_VER% not found via fnm ^(checked FNM_DIR, %%APPDATA%%\fnm, %%LOCALAPPDATA%%\fnm, %%USERPROFILE%%\.fnm, `fnm exec`^); falling back to Node on PATH. Run `fnm install %NODE_VER%` if the build misbehaves.
goto :eof

REM try_root <fnm-root>: if <root>\node-versions\v<ver>\installation\npm.cmd exists, set NODE_DIR to it.
:try_root
if "%~1"=="" goto :eof
if exist "%~1\node-versions\v%NODE_VER%\installation\npm.cmd" set "NODE_DIR=%~1\node-versions\v%NODE_VER%\installation"
goto :eof
