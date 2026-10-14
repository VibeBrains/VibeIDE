# Охват PromptGuard: что проходит через охранник, а что идёт в модель как есть

← [Knowledge Index](../README.md)

---

## [охват] Охранник от инъекций стоит на файлах, но не на выводе инструментов

**Контекст:** разбор дайджестов 12–14.10.2026 принёс тему «как агенту безопасно читать недоверенные источники».
Источник (Towards Data Science) не открылся — 403; охват проверен по коду 14.10.2026, а не по статье.

**Суть:**
- `VibePromptGuardService.sanitizeFileContent` ([common/vibePromptGuardService.ts](../../../src/vs/workbench/contrib/vibeide/common/vibePromptGuardService.ts))
  ищет шаблоны инъекций, невидимые символы и управляющие символы направления текста
- Вызывается на: чтении файла (`toolsService.ts`), правилах проекта (`vibeProjectRulesService.ts`), пересказе истории и
  найденных фрагментах индекса (`convertToLLMMessageService.ts`), slash-командах, UI агента (`vibeAgentRenderedUIService.ts`)
- **Не вызывается** на результатах `web_search`, `browse_url` и вызовов MCP: текст страницы или ответа сервера уходит
  в модель как есть. В системном промпте (`common/prompt/prompts.ts`) нет и строки, что вывод инструментов — данные
- Соседний предохранитель `exfiltrationSequence` ([exfiltrationSequence.md](exfiltrationSequence.md)) ловит пару
  «прочитал секрет → пошёл в сеть» уже после факта; он не заменяет проверку входа

**Как проверять охват заново:** `grep -rn "sanitizeFileContent" src/vs/workbench/contrib/vibeide --include='*.ts'` без
тестов — список мест вызова и есть охват. Пункт в `docs/roadmap.md` (`DIGEST-1014`) ждёт работы.
