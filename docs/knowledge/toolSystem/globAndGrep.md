# glob and grep

Two built-ins that replace shell-based filesystem reconnaissance:

## glob

Workspace file matcher by glob pattern. Backed by VS Code's `IFileService` + ripgrep-driven search service, **not** the shell.

```
<glob>
<pattern>**/*.ts</pattern>
</glob>
```

Returns `{ uris, hasNextPage, totalMatches }`. Pagination uses `MAX_CHILDREN_URIs_PAGE = 500` per page.

When to prefer over `search_pathnames_only`: when you know the exact glob you want. `search_pathnames_only` is fuzzy and best for "I remember part of the name".

## grep

Ripgrep-backed content search.

```
<grep>
<pattern>TODO\(.*?\)</pattern>
<file_type>ts</file_type>
<output_mode>content</output_mode>
<context_before>1</context_before>
<context_after>2</context_after>
<head_limit>50</head_limit>
</grep>
```

| Param              | Notes |
|--------------------|-------|
| `pattern`          | Rust regex syntax (same as `rg`). |
| `glob`             | Filter by glob, e.g. `**/*.ts`. |
| `file_type`        | Convenience: `ts`, `js`, `py`, `rust`, `go`, `java`, `md`, `json`, `yaml`, `css`, `html`. Expands to a glob internally. |
| `search_in_folder` | Restrict to a folder. |
| `output_mode`      | `content` (default), `files_with_matches`, `count`. |
| `context_before` / `context_after` | Surrounding context. VS Code's search has a single `surroundingContext` knob — we collapse to `max(before, after)`. |
| `case_insensitive` | Default false. |
| `multiline`        | Default false. When true, `.` matches `\n` and the pattern can span lines. |
| `head_limit`       | Cap total matches. Default 250. |

Each match's preview is itself capped at 500 chars via `truncateHeadTail` so a huge match line cannot blow the budget.

## Why both, not just one merged tool

The cost shape differs: `glob` is cheap (filename index), `grep` is content-heavy. Keeping them separate lets the prompt say "use glob first, then grep" and surfaces a natural cost expectation.
