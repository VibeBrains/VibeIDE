@echo off

REM Backup launcher — mirror of repo root run-dev.bat; delegates to bin\vibe-dev.bat.

REM Why bin/: upstream VS Code sync may overwrite scripts\vibe-dev.bat — copy from bin\ back to scripts\ if needed.

REM Docs: docs/knowledge.md → [vscode] Запуск dev VibeIDE

call "%~dp0vibe-dev.bat" %*

exit /b %ERRORLEVEL%

