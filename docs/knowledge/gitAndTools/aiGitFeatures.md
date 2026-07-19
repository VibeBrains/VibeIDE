# AI-фичи вокруг git: что реализовано, что брошено на середине

← [Knowledge Index](../README.md)

> Инвентаризация 2026-07-19: аудит кодовой базы на предмет AI-возможностей вокруг git (повод — beginner-роадмап github.blog, где конфликты и коммиты названы главными барьерами новичка). Зафиксировано, чтобы брошенный замысел не жил только в коде.

---

## [архитектура] Генерация commit-сообщений через свой LLM — реализовано и подключено

**Контекст:** нужно было понять, есть ли у нас AI-коммиты, прежде чем предлагать «фичу из статьи».

**Суть:** полноценный собственный путь (не Copilot):
- `electron-browser/vibeideSCMService.ts` — `GenerateCommitMessageService.generateCommitMessage()`: собирает `git diff --stat` + sampled diffs + ветку + лог → промпт (`gitCommitMessage_systemMessage(_local)` / `gitCommitMessage_userMessage` в `common/prompt/prompts.ts`) → `ILLMMessageService` → парсинг → `repo.input.setValue(...)` в SCM inputbox. Поддержка abort + agent-trailer.
- `electron-main/vibeideSCMMainService.ts` — реальные git-команды через `child_process.exec` (`git diff --numstat/--unified=0/--staged`, `--stat`, `branch --show-current`, `log -n 5`). Типы — `common/vibeideSCMTypes.ts`.
- Кнопка-искра `vibe.generateCommitMessageAction` (+ `LoadingGenerateCommitMessageAction` для отмены) на `MenuId.SCMInputBox`, `group: 'inline'`, `when scmProvider == git`.
- Conventional-формат — `common/conventionalCommitFormat.ts` (`autoDetectScope`/`autoDetectType`; комментарий указывает на будущий tool `generate_commit_message`, UI wire-up помечен «wave-2»).

**Применение:** новую фичу генерации коммитов НЕ делать — есть. **Долг:** `product.json` `defaultChatAgent.generateCommitMessageCommand` всё ещё указывает на `github.copilot.git.generateCommitMessage` (апстримовый Copilot-путь через `scmInput.ts`) — то есть в SCM inputbox параллельно живут ДВЕ кнопки-искры (наша + остаточная апстримовая). Убрать дубль — отдельной задачей (см. roadmap).

---

## [архитектура] AI-разрешение merge-конфликтов — только скелет, Phase 2 брошена

**Контекст:** типичный кандидат в киллер-фичу для нашей аудитории (боится терминала, конфликт = ступор). Проверка показала — замысел начат и заброшен.

**Суть:**
- `common/vibeMergeConflictService.ts` — `IVibeMergeConflictService` с `analyzeConflicts()`, `hasConflicts()`, `countConflicts()`; результат `MergeConflictResolution` (ours/theirs/both/custom + confidence + explanation).
- Реально работает только **Phase 1 (структурный анализ)** — выбор по числу строк блоков. **Phase 2 (LLM-разрешение) — заглушка**: в explanation буквально пишется `"Phase 2: LLM will explain..."`, вызова LLM в файле нет.
- **Потребителей ноль**: `IVibeMergeConflictService` встречается только в самом сервисе и в `vibeide.contribution.ts` (`registerSingleton`). Ни чат, ни UI его не дёргают → AI-разрешение конфликтов фактически отсутствует.
- Встроенное `extensions/merge-conflict` — чистый апстрим VS Code (accept current/incoming/both, codelens, decorator), без LLM.

**Применение:** это **реальная точка роста** — достроить Phase 2 (вызов `ILLMMessageService` по образцу `GenerateCommitMessageService`) + подключить к UI/чату. Перед удалением сервиса (если возникнет соблазн «мёртвый код») — помнить: это записанный замысел, не мусор.

---

## [квирк] Чат ↔ git: выделенных git-инструментов у агента нет

**Контекст:** проверка, умеет ли AI-чат читать git-статус/дифф как инструмент.

**Суть:**
- Tools чата (`common/prompt/tools/`) — файлы/поиск/терминал (`edit_file`, `read_file`, `grep`, `glob`, `run_command`, `run_nl_command`, `automated_code_review`, `generate_tests`, `web_search`…). **Нет** `git_diff`/`git_status`/`git_commit` как выделенного tool — git доступен агенту только как shell-команда через `run_command`/`run_nl_command`.
- `chatThreadService.ts`/`toolsService.ts` — ссылок на `scmService`/`getDiff`/`stagedChanges` нет; детект «codebase/repo» в запросе — про структуру кода, не про git-дифф.
- Отдельно: `common/vibeGitBlameService.ts` (`getBlameForLine()` через `git.getLineBlame`, цель — «человек vs AI код»), `vibeGitWorktreeService` (изоляция агентов по worktree), `common/diffCommitGrouping.ts`.
- Апстримовый мост (не наш): `contrib/scm/browser/scmHistoryChatContext.ts` — прикрепление истории коммитов/мультидиффа как контекста чата.

**Применение:** если понадобится «агент, знающий git-статус/дифф» — это новый tool (`git_status`/`git_diff`), сейчас его нет.

**Связано:** [[gitFlow.md]] · генератор коммитов делит LLM-стек с [[../architecture/llmAndContext.md]].
