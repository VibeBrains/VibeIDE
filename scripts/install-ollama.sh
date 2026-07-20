#!/usr/bin/env bash
set -e

echo "[VibeIDE] Checking for Ollama..."
if command -v ollama >/dev/null 2>&1; then
  echo "[VibeIDE] Ollama already installed: $(ollama --version 2>/dev/null || true)"
else
  unameOut="$(uname -s)"
  case "${unameOut}" in
      Darwin*)
        if command -v brew >/dev/null 2>&1; then
          echo "[VibeIDE] Installing Ollama via Homebrew..."
          brew install ollama
        else
          echo "[VibeIDE] Installing Ollama via official script..."
          curl -fsSL https://ollama.com/install.sh | sh
        fi
        ;;
      Linux*)
        echo "[VibeIDE] Installing Ollama via official script..."
        curl -fsSL https://ollama.com/install.sh | sh
        ;;
      *)
        echo "[VibeIDE] Unsupported OS for this script. Use Windows PowerShell script or install manually."
        exit 1
        ;;
  esac
fi

echo "[VibeIDE] Ensuring Ollama service is running..."
(ollama serve >/dev/null 2>&1 &) || true
sleep 2

echo "[VibeIDE] Health check..."
if command -v curl >/dev/null 2>&1; then
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null; then
    echo "[VibeIDE] Ollama is running."
  else
    echo "[VibeIDE] Ollama API not reachable yet. It may take a few seconds to start."
  fi
else
  echo "[VibeIDE] curl not found; skipping API check."
fi

echo "[VibeIDE] Optionally pull a starter model (e.g., llama3.1)..."
echo "Run: ollama pull llama3.1"

