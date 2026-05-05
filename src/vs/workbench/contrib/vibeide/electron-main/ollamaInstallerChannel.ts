/*--------------------------------------------------------------------------------------
 *  Copyright 2025
 *--------------------------------------------------------------------------------------*/

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

type InstallParams = { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco', modelTag?: string };

export class OllamaInstallerChannel implements IServerChannel {

  private readonly _onLog = new Emitter<{ text: string }>();
  private readonly _onDone = new Emitter<{ ok: boolean }>();

  listen(_: unknown, event: string): Event<any> {
    if (event === 'onLog') return this._onLog.event;
    if (event === 'onDone') return this._onDone.event;
    throw new Error(`Event not found: ${event}`);
  }

  async call(_: unknown, command: string, params: any): Promise<any> {
    if (command === 'install') {
      this.install(params as InstallParams);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  }

  private log(line: string) {
    this._onLog.fire({ text: line });
  }

  private done(ok: boolean) {
    this._onDone.fire({ ok });
  }

  private install(params: InstallParams) {
    const p = platform();
    const isMac = p === 'darwin';
    const isWin = p === 'win32';
    const isLinux = !isMac && !isWin;

    if (isMac) {
      // Deterministic macOS flow
      const cmd = '/bin/bash';
      const script = [
        'set -e',
        'echo [VibeIDE] macOS install starting...',
        'if [ -d /Applications/Ollama.app ]; then echo [VibeIDE] Found /Applications/Ollama.app; open -a Ollama; else',
        ' if [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then',
        '   eval "$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)";',
        ' else',
        '   echo [VibeIDE] Bootstrapping Homebrew...; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)";',
        '   eval "$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)";',
        ' fi;',
        ' echo [VibeIDE] Installing Ollama via Homebrew Cask...; brew install --cask ollama || true; open -a Ollama; fi',
        'sleep 2',
        'echo [VibeIDE] Health check...',
        'curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet'
      ].join('\n');
      this.exec(cmd, ['-lc', script]);
      return;
    }

    if (isLinux) {
      const cmd = '/bin/bash';
      const script = [
        'set -e',
        'echo [VibeIDE] Linux install starting...',
        'curl -fsSL https://ollama.com/install.sh | sh',
        '(ollama serve >/dev/null 2>&1 &) || true',
        'sleep 2',
        'echo [VibeIDE] Health check...',
        'curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet'
      ].join('\n');
      this.exec(cmd, ['-lc', script]);
      return;
    }

    // Windows
    const cmd = 'powershell.exe';
    const ps = [
      '$ErrorActionPreference = "Stop";',
      'Write-Host "[VibeIDE] Windows install starting...";',
      'if (Get-Command winget -ErrorAction SilentlyContinue) {',
      '  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements',
      '} elseif (Get-Command choco -ErrorAction SilentlyContinue) {',
      '  choco install ollama -y',
      '} else {',
      '  Write-Error "No package manager found (winget/choco)."',
      '}',
      'Start-Process -FilePath ollama -ArgumentList serve -WindowStyle Hidden',
      'Start-Sleep -Seconds 2',
      'try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:11434/api/tags -TimeoutSec 5; if ($r.StatusCode -eq 200) { Write-Host "[VibeIDE] Ollama running" } } catch { Write-Host "[VibeIDE] Ollama not reachable yet" }'
    ].join('\n');
    this.exec(cmd, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ps]);
  }

  private exec(command: string, args: string[]) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => this.log(d.toString()))
    child.stderr.on('data', d => this.log(d.toString()))
    child.on('close', code => this.done(code === 0))
    child.on('error', err => { this.log(String(err)); this.done(false); })
  }
}


