# Natural-language shell parser — safety contract

> Status: normative.
> Source roadmap entry: roadmap §990 (`nlShellParserService.ts` policy + analyzer hookup).

## Why this document exists

The agent can interpret natural-language requests like «удали все .tmp файлы в папке» and translate them to shell commands. Without a deterministic safety gate, the agent could emit `rm -rf` flavoured commands without explicit user confirmation. This document fixes the policy.

## Three components

| Component                                | Role                                                                                          |
|------------------------------------------|-----------------------------------------------------------------------------------------------|
| `nlShellParserService` (NOT YET BUILT)   | Translates NL request → candidate shell command. Multi-shot; chooses safest interpretation.   |
| `nlShellSafetyAnalyzer.analyzeNLShellSafety` (`common/nlShellSafetyAnalyzer.ts`, **landed**) | Pure helper — given a command string, returns `'safe' \| 'destructive' \| 'ambiguous'` + reasons. |
| Chat-mode wiring (NOT YET BUILT)         | Pipes parser output through analyzer; blocks `destructive` without explicit user confirm.     |

## Verdict policy (`analyzeNLShellSafety`)

Pure. Returns `{verdict: 'safe' | 'destructive' | 'ambiguous', reasons: ReasonCode[]}` where reasons are deterministic codes from this set (covered in helper unit tests):

**Destructive (reasons that ALWAYS block without confirm):**
- `rm-recursive` — `rm -rf` / `rm -fr` / `rm -Rf`
- `rm-root` — `rm` targeting `/`, `/*`, `~`, `$HOME`
- `dd-write` — `dd` with `of=` outside `/dev/null`
- `mkfs` — any `mkfs.*` invocation
- `shred` — `shred -*`
- `truncate-zero` — `truncate -s 0` against existing files
- `chmod-777` — `chmod 777` / `chmod -R 777`
- `git-force-push` — `git push --force` / `git push -f`
- `git-reset-hard` — `git reset --hard`
- `git-clean-fd` — `git clean -fd` / `-fdx`
- `powershell-remove` — `Remove-Item -Recurse -Force` / `rm -recurse -force`
- `format-volume` — `Format-Volume`

**Ambiguous (require user clarification, not auto-block):**
- `unknown-tool` — first token not in known-tool registry
- `pipeline-multi-stage` — chains of `&&` / `||` / `|` longer than 2 stages
- `redirect-overwrite` — `>` to existing file (vs `>>` append)

**Safe:**
- All other commands matching known-safe shell patterns (echo, ls, cat, grep, find without -delete, npm/pnpm/yarn run, git status/log/diff/branch -a, etc.).

## Wiring policy (when parser lands)

```
NL request → nlShellParserService.parse() → candidate command
                                                  │
                                                  ▼
                          nlShellSafetyAnalyzer.analyzeNLShellSafety(command)
                                                  │
                ┌─────────────────────────────────┼──────────────────────────────────┐
                ▼                                 ▼                                  ▼
            verdict: 'safe'                verdict: 'destructive'           verdict: 'ambiguous'
                │                                 │                                  │
                ▼                                 ▼                                  ▼
        execute via                       BLOCK + show explicit                 surface to user
        terminalToolService               confirm dialog with                   with parsed reasons,
                                          analyzer reasons                      ask "did you mean X?"
```

**Critical invariant:** `analyzeNLShellSafety` runs **after** the parser produced its candidate but **before** any execution path. If the user confirms a destructive command, the audit log records `command_destructive_confirmed` action with the analyzer reasons.

## What the analyzer does NOT do

- It does **not** invoke a shell or sandbox.
- It does **not** resolve aliases, env-vars, or shell-functions — `rm -rf` aliased as `r` will pass `analyseAsSafe`. Defence-in-depth: the parser SHOULD canonicalise before passing to the analyzer.
- It does **not** know about the user's filesystem — it cannot tell that `~/.vibe/secrets/api-key.txt` exists. Path-specific rules (`vibeide.safety.permissions.json`) live in `IVibePerFilePermissionsService`, evaluated separately.
- It does **not** auto-redact / rewrite — only classifies.

## Why no auto-rewrite

If the analyzer rewrites destructive commands ("dropping --force from git push") the user loses the ability to verify what actually ran. The contract is: **classify, then surface**. The user remains the final authority on whether to bypass.
