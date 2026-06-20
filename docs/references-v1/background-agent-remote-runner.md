# VibeIDE Background Agent — Remote Runner (Optional / Phase J.2)

**Status:** Design doc — NOT implemented; requires explicit user opt-in + separate threat model

---

## Overview

The remote runner is an **optional extension** of the local headless runner (`vibe-agent-run.js`).
It runs the same job descriptor (`.vibe/jobs/<id>.json`) on a remote compute environment
(CI runner, dev container, cloud VM) rather than the local machine.

**Critical constraint:** Secrets and API keys are NEVER stored in the job file committed to git.
The remote runner must receive credentials via a separate, out-of-band mechanism.

---

## Architecture (Phase J.2 design)

```
Local IDE  →  .vibe/jobs/<id>.json (no secrets) + .vibe/jobs/<id>.secrets.enc
                                                    (encrypted via safeStorage, gitignored)
           →  trigger remote runner (SSH / GitHub Actions dispatch / custom webhook)
Remote env →  decrypt secrets via user-provided KMS or env vars
           →  run vibe-agent-run.js with --remote flag
           →  write results back to .vibe/jobs/<id>.json + digest
           →  optional: create draft PR via SCM
```

## Switching between local and remote

- Job descriptor field: `"runner": "local"` (default) | `"remote"`
- Remote endpoint configured via `vibeide.backgroundJob.remoteRunnerEndpoint` (never in git)
- UI toggle in IDE: "Switch to remote runner" in job dashboard (Phase 3b)

## Secrets policy (remote)

| Secret type | Storage | Access |
|---|---|---|
| LLM API keys | IDE safeStorage (never in job file) | Injected at runtime via encrypted channel |
| MCP OAuth tokens | `IVibeMCPOAuthService` | Forwarded via secure tunnel |
| Git credentials | OS credential manager | Remote runner uses SSH key or deploy token |

## What we do NOT copy from competitors

- No mandatory cloud subscription (Cursor, GitHub Copilot workspace)
- No implicit repository access without explicit user grant
- No "always-on" cloud VM running 24/7 at user expense without explicit trigger

## Risk disclosure

- Remote runner has broader network access than local — threat model must be extended
- User must review `vibeide.backgroundJob.supervisedOffTools` for remote context
- Branch + PR creation via remote requires explicit `allowGitPush: true` in job descriptor

## Implementation path (Phase J.2 → later)

1. Define remote protocol: job descriptor over HTTPS, result polling or webhook
2. Implement encrypted secrets channel (separate from job file)
3. CI integration: GitHub Actions workflow template in `.github/workflows/vibe-remote-job.yml`
4. UI: remote/local toggle in job dashboard
