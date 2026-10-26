# ACP v1.25: session notices и session compaction — что в схеме, что делает адаптер Claude и что у нас

← [Knowledge Index](../README.md)

---

## [факт] Что стабилизировано в схеме и как это включается

**Контекст:** разбор сводки 22.10.2026 ([DIGEST-1026](../../roadmap.md)). Сводка называет это «поправкой к прошлой»:
схема менялась. Проверено 26.10.2026 по релизам репозитория `agentclientprotocol/agent-client-protocol`,
описаниям PR #2336 и #2334 и коду адаптера `@agentclientprotocol/claude-agent-acp@0.95.0` (`npm pack`, `dist/`).

- Schema **v1.25.0** (09.10.2026): стабилизированы session notices (#2336) и session compaction (#2334).
  В v1.26.0 (16.10.2026) их нет: там client system prompt (unstable), удаление next-edit suggestions, уточнение про форкнутую сессию
- Обе возможности включает клиент в `initialize`: `clientCapabilities.session.notices` и `clientCapabilities.session.compaction`
  (объекты, не булевы). Без них агент **обязан** их не слать: у адаптера `clientSupportsNotices` и `clientSupportsCompactionUpdates`
  проверяют именно «объект, не массив»
- Notices — живые события вне истории диалога, показ и снятие остаются за клиентом.
  Кадр `session/update` с `sessionUpdate: "notice"` и полями `severity` (открытое перечисление), `title`, `description` (необязательно)
- Compaction — кадр `sessionUpdate: "compaction_update"` с полями `compactionId`, `status` (обязательное; `in_progress`,
  затем `completed`, `failed` или `cancelled`), `summary` (список блоков текста), `error`. Живая доставка и воспроизведение
  при `session/load` идут по той же capability. Поля сняты с кода адаптера, а не со схемы: страницу схемы с полным перечнем
  не открывал — **перед реализацией сверить со схемой v1.26.0**

## [проверено по коду] Что делает адаптер Claude, если клиент capability не объявил

Адаптер ничего не теряет, а переводит кадры в старую форму (`dist/session-notices.js`, `dist/context-compaction.js`,
`dist/acp-agent.js:2812`):

| Событие | С capability | Без неё (наш случай) |
|---|---|---|
| Уведомление (остановлена задача, смена режима и т.п.) | кадр `notice` | сообщение агента `agent_message_chunk` с жирной меткой: `**Заголовок:** описание` |
| Сжатие контекста | кадры `compaction_update` | синтетический вызов инструмента «Compact conversation», вид `think`, `in_progress` → итог |

То есть у нас сегодня уведомления идут как текст ответа агента, а сжатие — как строка инструмента. Ничего не ломается.

## [проверено по коду] Что у нашего клиента

- `common/acp/acpProtocol.ts:171` — `initializeParams` объявляет `session: { configOptions: { boolean: {} } }`, `notices` и `compaction` нет
- `parseSessionUpdate` (`acpProtocol.ts:473`) знает `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `config_option_update`,
  `available_commands_update`, `usage_update`; всё прочее возвращает `undefined` и молча отбрасывается — незнакомый кадр ничего не роняет
- Объявлять capability до того, как кадры разобраны и показаны, нельзя: агент перестанет присылать текстовую замену, а кадры мы отбросим
  — уведомление пропадёт совсем. Порядок строгий: разбор → показ → только потом capability
- Решение «ACP v2 до стабилизации не мигрировать» ([acpSdk2Split.md](acpSdk2Split.md)) этого не меняет: обе возможности — стабильная v1

## [не проверено] Что остаётся неизвестным

- Шлёт ли `session/load` при воспроизведении те же кадры, и как их показывать повторно, чтобы не плодить дубли в треде
- Как выглядит `summary` сжатия на живом адаптере 0.95.0 и нужен ли он в UI (строка «Контекст сжат» достаточна?)
- Другие гости (Cursor, Kimi Code CLI, OpenHands) эти capability вообще читают или нет: в реестре у агентов версии схемы не указаны
