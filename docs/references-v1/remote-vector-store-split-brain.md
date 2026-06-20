# Vector store / embeddings and Remote — split-brain note

**Problem:** Workspace roots can execute on different physical machines or filesystem namespaces (Local, **Remote SSH**, **Dev Container**, **WSL**). The built-in vector store and embedding caches are tied to **where the extension host / Node process writes data**, not necessarily the developer’s mental model of “the repo”.

## Rules of thumb

1. **One index per resolver:** Treat embeddings / `BuiltInVectorStore` paths as valid **only** for the URI authority that created them (local disk vs remote vs container). Do not assume copying `.vibe/` between environments preserves a usable index.
2. **Remote / container:** Cache and sqlite (if used) usually live **next to the remote server** home or extension host storage — not on the laptop unless using local workspace.
3. **WSL vs Windows:** Opening the same folder once as `\\wsl$\...` and once as a native Windows clone produces **two** workspaces → two stores unless URIs are normalized.
4. **Privacy mode:** Cloud embeddings disabled — local model paths still follow the same split-brain rule (model files may be missing on remote).

## Operational guidance

- After switching connection type (e.g. local → Dev Container), expect **re-index**; warn users in UI if semantic search returns empty after migration (future enhancement).
- For debugging “search finds nothing”: note **host**, **workspace URI**, and whether `.vibe/` was synced from another machine via git or VSCodeSyncFiles.

## Relation to roadmap

Implements documentation slice for **§ F — Remote SSH / Dev Container / WSL** (vector store location). Product warnings remain backlog.
