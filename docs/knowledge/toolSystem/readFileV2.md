# read_file v2

The `read_file` built-in returns line-numbered, paginated, line-capped file contents — directly usable as the source for a subsequent `edit_file` call.

## Parameters

| Param               | Default | Notes |
|---------------------|---------|-------|
| `uri`               | —       | Required. Must resolve inside the workspace. |
| `start_line`        | `1`     | 1-based. |
| `end_line`          | `start_line + line_limit - 1` | 1-based, inclusive. |
| `line_limit`        | `2000`  | Capped at `READ_FILE_MAX_LINE_LIMIT = 10_000`. |
| `with_line_numbers` | `true`  | When true, each line is prefixed with `<line_num>\t`. |
| `page_number`       | `1`     | Byte-window paginator on top of line slicing (`MAX_FILE_CHARS_PAGE = 500_000` per page). |

## Result

```ts
{
  fileContents: string,
  totalFileLen: number,
  totalNumLines: number,
  hasNextPage: boolean,
  linesReturned: number,
  startLineReturned: number,
  endLineReturned: number,
  truncatedByLineLimit: boolean,
}
```

When `truncatedByLineLimit` is true, the formatter tells the model how to continue: `call read_file with start_line=<endLineReturned + 1>`.

## Why line numbers in the output

The downstream `edit_file` tool needs to match exact text. When the model sees `42\texport function foo()`, it knows that line 42 is exactly that string and can produce a SEARCH/REPLACE block confidently. Without numbers the model often hallucinates line numbers from context.

## Interaction with edit safety

Every successful `read_file` marks the URI in `_filesReadInSession`. `edit_file` refuses to run on a pre-existing file that hasn't been marked — this catches the common failure mode of editing blind based on guessed content. `create_file_or_folder` and `rewrite_file` implicitly mark the file as read (their content is known by definition).

## Large-file warning

Files over 200 KB log a console warning on the first read pass — a hint that the file probably belongs in `.vibe/ignore` or should be queried by region instead of read whole.

## What we did NOT change

- The `MAX_FILE_CHARS_PAGE = 500_000` byte cap stays as a hard ceiling on top of the line cap.
- The fallback "find by basename" path (when the model gives a path that doesn't resolve cleanly) is preserved.
- The prompt-injection sanitizer (`vibePromptGuardService.sanitizeFileContent`) still runs before content reaches the model.
