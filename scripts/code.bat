@echo off
setlocal

title VibeIDE Dev

pushd %~dp0\..

:: Get electron, compile, built-in extensions
if "%VSCODE_SKIP_PRELAUNCH%"=="" (
	node build/lib/preLaunch.ts
)

:: Executable name follows product.json nameShort (e.g. VibeIDE.exe, Code - OSS.exe)
for /f "delims=" %%E in ('node "%~dp0vibe-product-win-exe-name.mjs"') do set "VI_WIN_EXE=%%E"
set "CODE_EXE=.build\electron\%VI_WIN_EXE%"
if not exist "%CODE_EXE%" (
	echo [VibeIDE] Electron executable not found:
	echo          %CD%\%CODE_EXE%
	echo          Run from repo root: npm run electron
	popd
	exit /b 1
)

:: Manage built-in extensions
if "%~1"=="--builtin" goto builtin

:: Configuration
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

set DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"
for %%A in (%*) do (
	if "%%~A"=="--extensionTestsPath" (
		set DISABLE_TEST_EXTENSION=""
	)
)

:: Launch (quoted path — nameShort may contain spaces)
"%CODE_EXE%" . %DISABLE_TEST_EXTENSION% %*
goto end

:builtin
"%CODE_EXE%" build/builtin

:end

popd

endlocal
