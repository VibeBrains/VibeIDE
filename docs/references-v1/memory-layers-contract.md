# Memory layers contract — three independent stores

> Status: normative.
> Source roadmap entry: roadmap §992 (`memoriesService.ts` vs `vibeMemoryDecayService.ts` vs `sessionMemoryPerThread`).

## Why this document exists

Three memory-shaped services co-exist with overlapping concepts. Without a routing contract a single «remember this» request from the agent could land in 0 or 3 of them. This document fixes the layering.

## Three layers

| Layer            | Service                                      | Lifetime          | Persistence                       | Scope              |
|------------------|----------------------------------------------|-------------------|-----------------------------------|--------------------|
| **Long-term**    | `IVibeMemoryService` (`memoriesService.ts`)  | Persistent        | `.vibe/context.md` (workspace)    | Workspace-wide     |
| **Decay**        | `IVibeMemoryDecayService` (`vibeMemoryDecayService.ts`) | Adaptive | Same `.vibe/context.md` re-rank   | Workspace-wide     |
| **Short-term**   | `IVibeSessionMemoryService` (`vibeSessionMemoryService.ts`, **landed this session**) | 7-day TTL or thread-close | `IStorageService` (workspace scope) | Per chat thread |

## Routing decisions (`memoryLayerRouter.routeMemoryWrite`)

Pure helper. Given a write request, chooses one of three:

1. **Explicit kind** (`'long-term'` / `'short-term'`) → respect verbatim.
2. **Workspace-relevant** (mentions repo concepts, project decisions, infra notes) → **long-term**.
3. **Thread-local** (one-off conclusions, "I just decided X for this conversation") → **short-term**.
4. **Tie**: prefer short-term (cheaper to lose). Long-term is the durable layer; never write speculative content there.

`auditMemoryLayers` invariants:
- A given key MUST live in at most one layer (no cross-layer duplicates).
- Long-term entries MUST have a workspace anchor (`.vibe/context.md` line offset or section).
- Short-term entries MUST have a `threadId`. No threadId → reject.

## Decay layer (mid-tier)

`IVibeMemoryDecayService` does NOT add new memories — it re-ranks existing long-term ones over time:

- Memories untouched for 30 days move to the bottom of `.vibe/context.md`.
- Memories explicitly touched by the agent (recall hit) refresh `lastAccessedAt`.
- The decay service is read-only on the long-term layer's content; it only edits ordering metadata.

## What each layer does NOT do

| Layer       | NOT responsibilities                                                                            |
|-------------|------------------------------------------------------------------------------------------------|
| Long-term   | Never holds per-thread state. Never holds secret-shaped content (use `secretDetectionService`). |
| Decay       | Never deletes memories. Never adds. Only reorders.                                              |
| Short-term  | Never persisted to disk in `.vibe/`. Never visible to other workspaces. Never sync'd to cloud.  |

## When agent says «запомни X»

Routing path:

```
Agent intent: "запомни X"
       │
       ▼
memoryLayerRouter.routeMemoryWrite({hint: X, threadId, workspaceContext})
       │
       ├─ 'long-term'  → IVibeMemoryService.append(X)  → .vibe/context.md
       │
       └─ 'short-term' → IVibeSessionMemoryService.append({threadId, kind, content: X})
                                  │
                                  ▼
                         IStorageService (WORKSPACE scope)
```

Decay layer never gets a direct write — it operates on the long-term layer asynchronously.

## Cross-layer recall

When agent issues `recall("X")`:

1. Check **short-term first** for the current `threadId` (highest signal: just-mentioned context).
2. Check **long-term** if no short-term hit.
3. Decay layer only enters the picture for ranking long-term recall results.

This ordering means «what we just decided» beats «what we noted six months ago» — matches user intuition.

## What's still backlog

- `routeMemoryWrite` runtime hookup in `memoriesService` / `vibeMemoryDecayService` / `sessionMemoryPerThread` is not yet wired — services currently expose APIs independently. The router lives in `common/memoryLayerRouter.ts` (commit `44e094e2`) and is unit-tested.
- UI panel showing layer breakdown (which memories live where) — backlog.
- Migration tool for existing pre-router memories that may live in wrong layer — backlog.
