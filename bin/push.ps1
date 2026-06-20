# bin/push.ps1 — Stage all modified/new tracked files, commit and push.
# Usage:
#   .\bin\push.ps1 "commit message"
#   .\bin\push.ps1  (opens prompt if message omitted)

param([string]$Message = "")

$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

# Remove stale git locks
foreach ($lock in @(".git/index.lock", ".git/HEAD.lock")) {
    if (Test-Path $lock) { Remove-Item $lock -Force; Write-Host "Removed $lock" }
}

# Commit message
if (-not $Message) {
    $Message = Read-Host "Commit message"
}
if (-not $Message) { Write-Error "Commit message required"; exit 1 }

git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host "Nothing to commit."; exit 0 }

git commit -m $Message
git push
