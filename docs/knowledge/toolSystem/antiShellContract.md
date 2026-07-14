# Anti-shell contract

`run_command` and `run_persistent_command` reject shell forms that duplicate dedicated built-in tools. The check lives in `detectShellMisuse()` (`src/vs/workbench/contrib/vibeide/common/toolHardening.ts`) and runs in `validateParams.run_command` / `validateParams.run_persistent_command` / `callTool.run_nl_command` (after the natural-language parser produces a shell command).

## Class of bug this closes

When the model has only one tool for "do something on the filesystem" (a generic shell), it gravitates toward `Get-Content` / `cat` / `findstr` because they sound right. On large files this:

1. Streams all bytes through a single stdout pipe.
2. Has no inactivity timeout — the IDE host blocks on the IPC channel.
3. Produces output that exceeds the LLM context window before the call returns.

End user perception: "the chat froze". The root cause is the absent tool ladder, not the model.

## What gets bounced

| Shell head                            | Suggested tool         |
|---------------------------------------|------------------------|
| `Get-Content`, `gc`, `type`, `cat`, `bat`, `nl`, `more`, `less` | `read_file` |
| `head`, `tail` (no `\|` pipe)         | `read_file`            |
| `ls -R`, `ls -la`, `dir /s`, `dir /b`, `tree` | `ls_dir` / `get_dir_tree` |
| `find … -name`, `where`, `fd`         | `glob`                 |
| `grep`, `egrep`, `fgrep`, `rg`, `ag`, `ack`, `findstr`, `Select-String`, `sls` | `grep` |
| `sed -i`, `awk -i`, `perl -i`         | `edit_file`            |

The detector is conservative: it strips PowerShell `&` call-operator prefixes and POSIX env-var prefixes (`DEBUG=1 cmd`) before matching, but only looks at the head of the command. `git log | head -20` stays allowed (head is in a pipeline, common shell hygiene).

## Error surface

A bounced call throws `ToolValidationError` with:

- `code: 'shell_misuse'`
- `suggestedTool: '<built-in tool name>'`
- `hint: '<one-sentence explanation>'`

The LLM gets a clear instruction to switch tools, not a stack trace.

## When to extend the list

Add a new entry when telemetry shows the model repeatedly trying a shell form to do something a built-in already does. Don't extend it for forms that *don't* have a built-in equivalent — that just blocks legitimate work.
