# Tool System — hardening notes

← [Knowledge Index](../README.md)

---

## [архитектура] Карта слоя тулов и зачем он закалён

**Контекст:** обзор домена `toolSystem/`. Слой встроенных тулов — это поверхность, которую LLM видит как `read_file`, `run_command`, `glob`, `grep` и т.д.

**Суть:** код слоя живёт в пяти местах:

- `src/vs/workbench/contrib/vibeide/common/toolsServiceTypes.ts` — typed params/results for every built-in tool.
- `src/vs/workbench/contrib/vibeide/common/prompt/prompts.ts` — descriptions shown to the LLM.
- `src/vs/workbench/contrib/vibeide/browser/toolsService.ts` — validators (`validateParams`), implementations (`callTool`), and result→string formatters (`stringOfResult`).
- `src/vs/workbench/contrib/vibeide/browser/terminalToolService.ts` — shell/terminal invocation, timeouts, output truncation.
- `src/vs/workbench/contrib/vibeide/common/toolHardening.ts` — shared utilities: `detectShellMisuse`, `truncateHeadTail`, `ToolValidationError`, `countLines`.

**Зачем закаляли:** other agent frontends (Cursor's minimax, generic LLM-shells) routinely hang on long file reads because they only expose one knob — `run_command` — and the model defaults to `Get-Content` / `cat` / `findstr`. Shell stdout has no pagination and no timeout, so the IDE host blocks on the IPC channel until the model is killed.

**Применение:** VibeIDE avoids this by exposing dedicated, paginated tools and **actively bouncing** shell forms that duplicate them. Добавляя новый тул — держать инвариант: у любого тула, читающего потенциально большой объём, обязаны быть пагинация и предел; shell-форма, дублирующая штатный тул, отбивается (`detectShellMisuse`).

**Связано:** остальные записи домена перечислены в [индексе базы знаний](../README.md) (раздел `toolSystem/`) — отдельного списка здесь намеренно нет, чтобы не плодить второй индекс.
