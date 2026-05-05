@echo off
REM VibeIDE dev launch from repo root (see scripts\vibe-dev.bat).
REM   run-dev.bat              — обычный запуск (профиль не чистим).
REM   run-dev.bat --clear      — снести профиль dev: %%APPDATA%%\vibeide-dev-dev ^(+ legacy vibeide-dev^),
REM                              %%LOCALAPPDATA%%\vibeide-dev-dev, %%USERPROFILE%%\.vibeide-shared, %%USERPROFILE%%\.vibeide, затем запуск.
REM   Остальные аргументы пробрасываются в Electron как раньше.
call "%~dp0scripts\vibe-dev.bat" %*
exit /b %ERRORLEVEL%
