$ErrorActionPreference = 'Stop'
Write-Host "[VibeIDE] Checking for Ollama..."
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  Write-Host "[VibeIDE] Ollama already installed."
} else {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "[VibeIDE] Installing Ollama via winget..."
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "[VibeIDE] Installing Ollama via Chocolatey..."
    choco install ollama -y
  } else {
    Write-Error "winget or choco is required to install Ollama automatically. Install one of them or install Ollama manually from https://ollama.com/download"
  }
}

Write-Host "[VibeIDE] Starting Ollama service..."
Start-Process -FilePath ollama -ArgumentList 'serve' -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  if ($resp.StatusCode -eq 200) { Write-Host "[VibeIDE] Ollama is running." }
} catch {
  Write-Warning "[VibeIDE] Ollama API not reachable yet. It may take a few seconds to start."
}

Write-Host "[VibeIDE] Optional: pull a starter model (e.g., llama3.1) with: ollama pull llama3.1"

