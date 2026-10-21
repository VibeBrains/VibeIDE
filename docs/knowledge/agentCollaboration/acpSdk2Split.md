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

## [проверено живьём] Прогон на адаптере 0.94.0 (22.10.2026)

Сид `.vibe-defaults/agents.json` запускает `npx @agentclientprotocol/claude-agent-acp` **без пина версии** (в шапке записи
сказано намеренно). Прогон на стенде: копия профиля, Telegram выключен, рабочая папка с проектным `agents.json` из сида
с `"active": true`, режим «Вручную»; два платных хода по подписке владельца.

**Какую версию тянет `npx` без пина.** `npm view`: `latest` = 0.94.0 (19.10), `preview` = 0.94.1-preview.4. В кэше `npx`
лежала 0.93.0 под тем же спеком; при первом запуске `npm exec` написал «package was not found and will be installed:
@agentclientprotocol/claude-agent-acp@0.94.0» и заменил её в той же папке кэша. То есть непривязанный спек сам догоняет
`latest`, кэш прежней версии его не держит. Поставилось: адаптер 0.94.0, `@agentclientprotocol/sdk` 2.0.0,
`@anthropic-ai/claude-agent-sdk` 0.3.303 (`package.json` пакета в кэше `npx`).

**Что прошло:**
- выбор агента: «Claude Agent» в группе «Внешние агенты» списка моделей, под полем «Ход ведёт внешний агент»,
  в композере появились настройки агента (модель, «Fast mode», уровни) — `session/set_config_option` на 0.94 отдаёт список
- «изучи открытый файл» с выделением: агент назвал строки 6–8 и `farewell(name)` без чтения файла с диска, то есть
  выделение дошло блоком запроса
- MCP-серверы переданы: строка журнала «гостю переданы MCP-серверы vibememory, smoke-fmt, vibe-ide», агент перечислил
  инструменты всех трёх, в том числе `mcp__vibe-ide__vibe_open_file`, `vibe_problems`, `vibe_watch_media`
- правка: вопрос разрешения с diff (`Edit src/greeter.js`, «Разрешить / Разрешать всегда / Отказывать / На сессию»),
  после «Разрешить» файл изменился на диске, редактор показал правку со своими «Принять / Отклонить», панель — «1 файл
  с изменениями»; «Отклонить файл» вернул `farewell` и пустую панель, `git diff` рабочей папки пуст
- начальный запуск медленный: установка ~20 с, затем `sdk-initialize` 32,9 с (`session/create`, журнал
  `[VibeIDE/ACP]`) — около минуты на «Запускаю агента…» при первом ходе треда

**Что стало известно о кадре `usage_update`:** он есть в стабильной схеме v1 SDK 2.0 (`dist/v1/schema/types.gen.d.ts`,
`zod.gen.js`, не только в `unstable`), адаптер 0.94 его отправляет (`acp-agent.js`, два места). Наш разбор — `acpProtocol.ts`,
строка ~511. **Не проверено:** что расход после хода показан в окне: поле дошло бы только в журнал сессии,
а в логах стенда этого кадра нет.

**Не проверялось:** `session/resume` и `session/load` на 0.94, вопрос-карточка `AskUserQuestion`, сжатие сессии.

**Мелочи, замеченные при прогоне:**
- уровень `debug` главного процесса: «claude auth status did not answer within 5 s; the identity is not refreshed» — при
  первом ходе, пока адаптер ещё поднимался; на ход не повлияло
- адаптер отдаёт diff правки блоком: `oldText`/`newText` на шесть строк с отступом в два пробела вместо табуляции файла,
  а карточка вопроса до разрешения показала только изменившуюся строку; расхождение видно лишь в разворачиваемой карточке
  вызова, на файл не влияет

## Что менялось в схеме v1 за октябрь (для справки)

- `v1.25.0` (09.10): стабилизированы уведомления сессии (session notices) и сжатие сессии (compaction)
- `v1.26.0` (16.10): добавлена схема системного промпта клиента, убраны подсказки следующей правки (next-edit)
- Источник: страница релизов github.com/agentclientprotocol/agent-client-protocol/releases (21.10.2026); день и месяц
  без года, год взят по соседним записям
