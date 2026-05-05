#!/usr/bin/env bash
set -euo pipefail

echo "[VibeIDE] Linux: installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

echo "[VibeIDE] Starting Ollama service..."
(ollama serve >/dev/null 2>&1 &) || true
sleep 2

echo "[VibeIDE] Health check..."
if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "[VibeIDE] Ollama is running."
else
  echo "[VibeIDE] Ollama API not reachable yet."
fi

echo "[VibeIDE] Done."

