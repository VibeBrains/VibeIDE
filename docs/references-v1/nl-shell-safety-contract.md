# Natural-language shell parser — safety contract

> Status: normative.
> Source roadmap entry: roadmap §990 (`nlShellParserService.ts` policy + analyzer hookup); line policy — DIGEST-0911 (2026-09-11).

## Why this document exists

The agent can interpret natural-language requests like «удали все .tmp файлы в папке» and translate them to shell commands. Without a deterministic safety gate, the agent could emit `rm -rf` flavoured commands without explicit user confirmation. This document fixes the policy.

## Components

| Component | Role |
|---|---|
| `nlShellParserService` (`common/nlShellParserService.ts`) | Translates an NL request → candidate shell command and runs `analyzeNLShellSafety` on it. |
| `analyzeNLShellSafety` (`common/nlShellSafetyAnalyzer.ts`) | Pure — one parsed `(command, args)` → `'safe' \| 'destructive' \| 'ambiguous'` + reason codes. |
| `analyzeShellLine` (same module) | Pure — a raw terminal line → the first destructive verdict over every command in it, or none. |
| Terminal-tool gate (`toolsService._gateDestructiveCommand`) | Runs `analyzeShellLine` on every command the agent sends to the terminal; destructive → confirm dialog naming the command and the reasons (off switch: `vibeide.agent.confirmDestructiveCommands`). |

## Verdict policy (`analyzeNLShellSafety`)

Assignments (`VAR=1`) and wrappers (`sudo`, `doas`, `env`, `nice`, `timeout`, `stdbuf`, `xargs`, `nohup`, `time`, `command`, `exec`) are peeled off first, with their value options (`sudo -u deploy`), so the command judged is the one that runs. `command -v X` is a lookup, not a run. The program name is compared without directory and `.exe`/`.com`.

**Destructive** — reason codes, the exact strings the dialog shows:

| Code | When |
|---|---|
| `rm-binary`, `dd-binary`, `mkfs-binary`, `shred-binary`, `truncate-binary` | the command itself |
| `powershell-remove-item`, `powershell-format-volume`, `powershell-disk` | `Remove-Item`, `Format-Volume`, `Clear-Disk` / `Remove-Partition` |
| `force-flag`, `rf-flag`, `fr-flag` | `--force` / `-force`, `-rf`, `-fr` in any argument |
| `root-path`, `home-path`, `wildcard-only` | an argument that is exactly `/` or `\`, `~`, `*` |
| `chmod-777`, `chmod-666` | an argument `777` / `666` |
| `git-push-force` | `git push --force`, `git push -f` (or a short-option cluster with `f`) |
| `git-reset-hard`, `git-clean-force` | `git reset --hard`; `git clean -f` / `-fd` / `-fdx` |
| `format-drive` | Windows `format D:` — bare `format` is not judged (`npm run format`) |
| `disk-tool` | `fdisk`, `sfdisk`, `gdisk`, `sgdisk`, `parted`, `wipefs`, `diskpart` asked to write; `diskutil erase*` / `zeroDisk` / `randomDisk` / `secureErase` / `partitionDisk` / `apfs delete*` |

A disk tool that only looks is not destructive: a listing flag (`-l`, `--list`, `-p`, `print`) with nothing else but devices, `-s` and help; `wipefs` without flags only lists signatures.

**Ambiguous:** `git`, `npm`, `docker` with no arguments (`*-command-needs-context`). The terminal-tool gate does not act on it — a line that says exactly `git` is harmless, and a dialog there trains the user to click through.

**Safe:** everything else.

## Line policy (`analyzeShellLine`)

- The line is grouped as the shell groups it: chains split at `;`, `&&`, `||`, `&`, newline; pipeline stages at `|` and `|&`; words with quotes and backslashes. `2>&1` and `&>file` are redirections, not separators. `$( … )`, `<( … )`, `>( … )` and backtick spans stay one word. `#` is **not** a comment — cmd.exe has none, and `echo # & format D:` formats there.
- Every simple command is classified; the first destructive one is the verdict, and the dialog names it.
- Nested lines are classified too, to depth 3: the script of `sh -c "…"` / `pwsh -Command "…"`, the words of `eval`, the inner line of every substitution (`echo $(rm notes.txt)` is destructive).
- **`fetch-piped-to-interpreter`** — code fetched from the network handed to an interpreter:
  - a fetcher (`curl`, `wget`, `fetch`, `aria2c`, `iwr`, `irm`, `Invoke-WebRequest`, `Invoke-RestMethod`) followed in the same pipe chain by a stage that takes its **program** from stdin: `| sh`, `| sh -s -- --yes`, `| python3 -`, `| sudo -E bash`, `| iex`;
  - a fetch inside the program operand of an interpreter or the arguments of `eval` / `source` / `.`: `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(wget …)"`, `bash -c "curl … | sh"`;
  - a download in a PowerShell expression given to `iex`: `iex (iwr …)`, `iex (New-Object Net.WebClient).DownloadString(…)`.
  - An interpreter with a script operand, or with `-m` / `-c` / `-e`, reads the pipe as data and is not flagged: `| python3 -m json.tool`, `| node script.js`.
  - Known gap: `curl -o i.sh … && sh i.sh` — two chains; telling it from an ordinary build step needs knowing what the file is.
- The same reason code and the same test vector live in VibeIDEA (`ShellSafetyAnalyzer.kt`); a change to the rule is made in both.

## Wiring policy (NL parser)

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
- It does **not** resolve aliases, env-vars, or shell-functions — `rm -rf` aliased as `r` will pass as safe. Defence-in-depth: the parser SHOULD canonicalise before passing to the analyzer.
- It does **not** know about the user's filesystem — it cannot tell that `~/.vibe/secrets/api-key.txt` exists. Path-specific rules (`vibeide.safety.permissions.json`) live in `IVibePerFilePermissionsService`, evaluated separately.
- It does **not** auto-redact / rewrite — only classifies.

## Why no auto-rewrite

If the analyzer rewrites destructive commands ("dropping --force from git push") the user loses the ability to verify what actually ran. The contract is: **classify, then surface**. The user remains the final authority on whether to bypass.
