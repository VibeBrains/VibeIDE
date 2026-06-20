@echo off

REM BACKUP COPY — same logic as scripts\vibe-dev.bat; paths use REPO_ROOT → ..\scripts\ for code.bat / nls helper.

REM Purpose: upstream merge may overwrite scripts\vibe-dev.bat; restore from bin\ then copy back to scripts\.

REM Daily entry: repo root run-dev.bat → scripts\vibe-dev.bat. See docs/knowledge.md § Запуск dev VibeIDE.

REM

REM VibeIDE — one-shot dev launch (Windows): optional profile wipe (--clear), gulp compile or opt-in transpile, React/NLS, Electron.

REM Run from repo root: bin\vibe-dev.bat or bin\run-dev.bat (wrapper).

REM

REM --clear / -clear /clear — delete dev profile dirs below, then launch ^(flags not passed to Electron^)

REM По умолчанию transpile-client НЕ запускается: он чистит out и заменяет gulp-бандл на разрозненный ESM —

REM в Electron тогда import *.css ломается ^(MIME text/css^) и падает workbench.desktop.main.js.

REM VIBE_USE_TRANSPILE_CLIENT=1 — принудительно запустить transpile-client после инкрементального прохода ^(на свой риск^).

REM VIBE_SKIP_TRANSPILE=1 — устарело, то же что поведение по умолчанию ^(можно оставить для совместимости^).

REM VIBE_SKIP_REACT=1       — skip npm run buildreact when sidebar bundle is missing

REM VIBE_SKIP_NLS=1         — skip vibe-nls-extract + clp cache clear



setlocal EnableExtensions EnableDelayedExpansion

title VibeIDE — vibe-dev ^(bin backup^)



cd /d "%~dp0.."

set "REPO_ROOT=%CD%"



set "CLEAR_PROFILE=0"

set "CODE_FORWARD="

:__vibe_argloop

if "%~1"=="" goto __vibe_argdone

if /i "%~1"=="--clear" (

	set "CLEAR_PROFILE=1"

	shift

	goto __vibe_argloop

)

if /i "%~1"=="-clear" (

	set "CLEAR_PROFILE=1"

	shift

	goto __vibe_argloop

)

if /i "%~1"=="/clear" (

	set "CLEAR_PROFILE=1"

	shift

	goto __vibe_argloop

)

if defined CODE_FORWARD (

	set "CODE_FORWARD=!CODE_FORWARD! "%~1""

) else (

	set CODE_FORWARD="%~1"

)

shift

goto __vibe_argloop

:__vibe_argdone



if "!CLEAR_PROFILE!"=="1" (

	echo [vibe-dev] --clear: wiping dev profile ^(welcome / provider onboarding resets^) ...

	REM Real dev folder is vibeide-dev-dev: main.ts passes "VibeIDE Dev" → userDataPath slug vibeide-dev + "-dev".

	REM Legacy vibeide-dev kept for old broken layouts / manual paths.

	for %%D in ("vibeide-dev-dev" "vibeide-dev") do (

		if exist "%APPDATA%\%%~D" (

			rd /s /q "%APPDATA%\%%~D" 2>nul

			if exist "%APPDATA%\%%~D" echo [vibe-dev] WARNING: %%APPDATA%%\%%~D still exists — close VibeIDE if running

		)

		if exist "%LOCALAPPDATA%\%%~D" (

			rd /s /q "%LOCALAPPDATA%\%%~D" 2>nul

		)

	)

	if exist "%USERPROFILE%\.vibeide-shared" (

		rd /s /q "%USERPROFILE%\.vibeide-shared" 2>nul

	)

	if exist "%USERPROFILE%\.vibeide" (

		rd /s /q "%USERPROFILE%\.vibeide" 2>nul

		if exist "%USERPROFILE%\.vibeide" echo [vibe-dev] WARNING: %%USERPROFILE%%\.vibeide still exists — close handles using it

	)

)



set "NEED_COMPILE=0"

if not exist "out\main.js" set "NEED_COMPILE=1"

if not exist "out\nls.messages.json" set "NEED_COMPILE=1"

if not exist "out\vs\workbench\contrib\vibeide\electron-main\registerVibeideMainChannels.js" set "NEED_COMPILE=1"



if exist "out\vs\workbench\workbench.desktop.main.js" (

	findstr /c:"vibeide/browser/vibeide.contribution" "out\vs\workbench\workbench.desktop.main.js" >nul 2>&1

	if errorlevel 1 set "NEED_COMPILE=1"

) else (

	set "NEED_COMPILE=1"

)



if "%NEED_COMPILE%"=="1" (

	echo [vibe-dev] full build needed ^(missing gulp/NLS outputs or workbench hook^) — npm run compile ...

	call npm run compile

	if errorlevel 1 exit /b 1

) else (

	if "%VIBE_USE_TRANSPILE_CLIENT%"=="1" (

		echo [vibe-dev] VIBE_USE_TRANSPILE_CLIENT=1 — npm run transpile-client ^(may break Electron workbench bundle/CSS^) ...

		call npm run transpile-client

		if errorlevel 1 exit /b 1

	) else (

		echo [vibe-dev] skipping transpile-client ^(keeps gulp bundle; set VIBE_USE_TRANSPILE_CLIENT=1 to force^)

	)

)



findstr /c:"vibeide/browser/vibeide.contribution" "out\vs\workbench\workbench.desktop.main.js" >nul 2>&1

if errorlevel 1 (

	echo [vibe-dev] workbench hook missing — run from repo root: npm run compile

	exit /b 1

)

if not exist "out\vs\workbench\contrib\vibeide\electron-main\registerVibeideMainChannels.js" (

	echo [vibe-dev] main-process bridge missing — run from repo root: npm run compile

	exit /b 1

)



if not "%VIBE_SKIP_REACT%"=="1" (

	if not exist "src\vs\workbench\contrib\vibeide\browser\react\out\sidebar-tsx\index.js" (

		echo [vibe-dev] React sidebar bundle missing — npm run buildreact ...

		call npm run buildreact

		if errorlevel 1 exit /b 1

	)

)



if not "%VIBE_SKIP_NLS%"=="1" (

	echo [vibe-dev] NLS: vibe-nls-extract.ts + clear dev clp cache ^(stale nls.messages in clp blocks RU^) ...

	call npx tsx scripts/vibe-nls-extract.ts

	if errorlevel 1 (

		echo [vibe-dev] WARNING: NLS extraction failed — non-English locales ^(RU etc.^) may show errors

	) else (

		set VSCODE_DEV=1

		call node "!REPO_ROOT!\scripts\vibe-dev-clear-nls-clp.mjs"

		if errorlevel 1 (

			echo [vibe-dev] WARNING: could not clear clp cache

		)

	)

) else (

	echo [vibe-dev] VIBE_SKIP_NLS=1 — skipping NLS extract and clp clear

)



if defined CODE_FORWARD (

	call "!REPO_ROOT!\scripts\code.bat" !CODE_FORWARD!

) else (

	call "!REPO_ROOT!\scripts\code.bat"

)

exit /b %ERRORLEVEL%

