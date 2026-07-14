# Background commands

`run_command` supports two long-running modes that did not exist before:

1. **`timeout_ms`** — override the per-command inactivity / wall-clock cap. Useful for builds and test suites that legitimately take minutes.
2. **`run_in_background: true`** — detach the command, return a `background_id` immediately. The companion tools `read_background_output` and `kill_background_command` let the model poll and stop the work.

## When to use which

| Scenario                                | Use                                                     |
|-----------------------------------------|---------------------------------------------------------|
| Build / test suite (finishes eventually)| `run_command` + `timeout_ms: 600000`                    |
| Dev server (never exits)                | `run_command` + `run_in_background: true`               |
| Watcher / log tail (you'll poll later)  | `run_command` + `run_in_background: true`               |
| Quick check (`git status`)              | `run_command` defaults                                  |

## Lifecycle

```
LLM → run_command { command: "npm run dev", run_in_background: true }
   ← { backgroundId: "uuid", result: "Command started in background…" }

LLM → read_background_output { background_id: "uuid" }
   ← { output: "<last N lines>", isRunning: true }

LLM → kill_background_command { background_id: "uuid" }
   ← { killed: true, backgroundId: "uuid" }
```

Output is truncated head+tail to ~80 KB via `truncateHeadTail()` so a log avalanche cannot drown the context window.

## Bounds

`timeout_ms` is clamped to `[1000, 600000]` (1s – 10min) — same range Claude Code uses for its Bash tool. Beyond that we want explicit background mode.

## Why we did not implement push notifications

Push-on-completion (the model gets a system message when a background command exits) requires changes to `chatThreadService` and the LLM message ordering. The polling model (`read_background_output`) is enough for 95% of cases and ships in a single PR.

Follow-up issue: add a `onCommandFinished` event on `ITerminalToolService` and forward it to the active thread as a tool-result-like message.
