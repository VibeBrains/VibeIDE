# ACP SDK 2.0: смена API библиотеки, а не протокола — что это значит для гостей по ACP

← [Knowledge Index](../README.md)

---

## [факт] SDK 2.0.0 не включает ACP v2: по умолчанию остаётся v1, а часть v1 уехала в `unstable`

**Контекст:** разбор дайджестов 15–21.10.2026 ([DIGEST-1021](../../roadmap.md)). Сводка 19.10 пишет: «ACP v2 — адаптер
`claude-agent-acp` 0.86 уже ходит по v2». Проверено 21.10.2026 по `npm view` и руководству миграции SDK.

**Что вышло (npm, `@agentclientprotocol/sdk`):**
- `1.9.0` — 16.10.2026, `2.0.0` — 19.10.2026 (`npm view @agentclientprotocol/sdk time`)
- `@agentclientprotocol/claude-agent-acp@0.94.0` (19.10) зависит от `@agentclientprotocol/sdk@2.0.0`; `0.92.0` (16.10)
  — «updated the ACP SDK to 1.9.0», `0.89.0` — «bumped … to 1.8.0» (CHANGELOG адаптера)
- Схема: `v1.26.0` (16.10, «Latest»), `v2.0.0-alpha.9` (16.10, пререлиз). Сама v2 всё ещё черновик: «various pieces can,
  and will, change before stabilization» (agentclientprotocol.com/announcements/acp-v2-draft, 20.07.2026)

**Что значит «2.0.0» (README пакета, `MIGRATION_STABLE_UNSTABLE.md`):**

| Вход пакета | Что даёт |
|---|---|
| `@agentclientprotocol/sdk` | стабильная v1, **по умолчанию** |
| `…/unstable` | стабильная v1 плюс нестабильные возможности |
| `…/experimental/v2` | стабильные возможности черновика v2 |
| `…/experimental/v2/unstable` | весь черновик v2 |

- Руководство: «This is an SDK API boundary, not a new wire protocol version», «Protocol wire method names are unchanged»,
  «the default import still speaks ACP v1». Меняется API библиотеки: убраны `AgentSideConnection`,
  `ClientSideConnection`, интерфейсы `Agent` и `Client`, `createLegacyAgent` — серверы переходят на «app builders»
- Из стабильной части в `unstable` перенесены (список в руководстве дан примерами): форк сессии и настройка
  провайдера, MCP-over-ACP, `systemPrompt` в запросах жизненного цикла сессии, `usage` в ответе на промпт, подагенты и их
  обновления сессии, `plan_removed` и план с ID. Стабильный разбор «может срезать эти поля», а встроенные обработчики не
  содержат нестабильных методов: незнакомый запрос получает Method Not Found

**Следствие для гостя:** адаптер, собранный на стабильном входе SDK 2.0, не ответит на нестабильный метод, который
клиент объявил или вызвал, и молча уберёт нестабильные поля. Адаптер на `…/unstable` ведёт себя как прежде.
Какой вход взял `claude-agent-acp` 0.94, не выяснял.

## [проверено по коду] Что использует наш клиент

`common/acp/acpProtocol.ts` вызывает: `session/new`, `session/load`, `session/resume`, `session/prompt`,
`session/cancel`, `session/set_config_option`, `session/close`; принимает `session/request_permission` и
`session/update` (в том числе `usage_update`, строка ~511). Форка сессии, `systemPrompt`, подагентов, MCP-over-ACP и
`usage` в ответе на промпт в этом списке нет — по составу вызовов перенос в `unstable` нас не задевает.
Версия в `initialize` — `ACP_PROTOCOL_VERSION = 1`; решение «v2 не мигрировать до стабилизации» остаётся
([roadmap, раздел про ACP v2](../../roadmap.md)).

## [не проверено] Живой прогон на адаптере 0.94

Сид `.vibe-defaults/agents.json` запускает `npx @agentclientprotocol/claude-agent-acp` **без пина версии**
(в шапке записи сказано намеренно): все, кто впервые выбрал Claude Agent после 19.10, получат 0.94.
Смоук с этой версией не гонялся: `initialize`, `session/new`, ход с вызовом инструмента, вопрос разрешения,
`session/resume`, кадр `usage_update`. Кадр `usage_update` по схеме на стабильность не сверял.
Пункт в roadmap: «Живой смоук Claude Agent по ACP на адаптере ≥0.94».

## Что менялось в схеме v1 за октябрь (для справки)

- `v1.25.0` (09.10): стабилизированы уведомления сессии (session notices) и сжатие сессии (compaction)
- `v1.26.0` (16.10): добавлена схема системного промпта клиента, убраны подсказки следующей правки (next-edit)
- Источник: страница релизов github.com/agentclientprotocol/agent-client-protocol/releases (21.10.2026); день и месяц
  без года, год взят по соседним записям
