# VibeIDE Background Agent — Hybrid Compute (Speculative / § J.3)

**Status:** Speculative — behind feature flag; architecture only; no implementation

---

## What is hybrid compute?

Heavy, non-secret operations (e.g. `npm run compile`, AST indexing, embedding generation)
run in a **one-shot isolated container/VM** while:
- File editing and secret/key access remain **local**
- The container has **no access** to API keys or sensitive workspace files

This mirrors how some CI systems split "build" from "deploy" into separate trust zones.

---

## Candidate operations for remote compute

| Operation | Why remote | Secrets needed? |
|---|---|---|
| `npm run compile` | CPU/memory heavy; ~3-7 min; no secrets | No |
| Full codebase indexing (tree-sitter, embeddings) | Memory intensive | No (public code) |
| `npm run test` (pure unit tests) | Parallelizable | Only if tests need API mocks |
| SBOM generation | No secrets | No |

## Operations that STAY local

| Operation | Why local |
|---|---|
| LLM API calls | Require user API key |
| File writes (agent edits) | Require workspace access |
| Git commit/push | Require git credentials |
| MCP tool calls | May require OAuth tokens |

## Feature flag

```json
"vibeide.backgroundJob.hybridCompute.enabled": false  // default: off
"vibeide.backgroundJob.hybridCompute.endpoint": ""    // container endpoint
"vibeide.backgroundJob.hybridCompute.operations": ["compile", "index"]
```

## Trust model

- Container is one-shot: spawned for the operation, destroyed after
- No persistent storage in container (outputs written back via controlled channel)
- No secrets passed to container — build operations must be self-contained
- User must explicitly approve each operation type for hybrid mode

## Implementation path

1. Define container protocol: input tarball → run command → output tarball
2. Implement local coordinator: `IVibeHybridComputeService` (Phase J.3)
3. Docker/Podman local container OR GitHub Actions reusable workflow
4. Feature flag + user consent dialog before first use
