@echo off
setlocal
echo [VibeIDE] Installing Ollama (Windows)...
powershell -ExecutionPolicy Bypass -File "%~dp0install-ollama.ps1"
endlocal

