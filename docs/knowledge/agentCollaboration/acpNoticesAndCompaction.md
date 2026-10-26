# ACP v1.25: session notices и session compaction — что в схеме, что делает адаптер Claude и что у нас

← [Knowledge Index](../README.md)

---

## [факт] Что стабилизировано в схеме и как это включается

**Контекст:** разбор сводки 22.10.2026 ([DIGEST-1026](../../roadmap.md)). Сводка называет это «поправкой к прошлой»:
схема менялась. Проверено 26.10.2026 по релизам репозитория `agentclientprotocol/agent-client-protocol`,
описаниям PR #2336 и #2334 и коду адаптера `@agentclientprotocol/claude-agent-acp@0.95.0` (`npm pack`, `dist/`).
Перед реализацией схема сверена повторно и точно: тег `schema-v1.26.0` (коммит `e2d83349bc`), файл `schema/v1/schema.json`.

- Schema **v1.25.0** (09.10.2026): стабилизированы session notices (#2336) и session compaction (#2334).
  В v1.26.0 (16.10.2026) их нет: там client system prompt (unstable), удаление next-edit suggestions, уточнение про форкнутую сессию
- Обе возможности включает клиент в `initialize`: `clientCapabilities.session.notices` и `clientCapabilities.session.compaction`
  (объекты, не булевы). Без них агент **обязан** их не слать: у адаптера `clientSupportsNotices` и `clientSupportsCompactionUpdates`
  проверяют именно «объект, не массив»
- Notices — живые события вне истории диалога, показ и снятие остаются за клиентом.
  Кадр `session/update` с `sessionUpdate: "notice"` и полями `severity` (открытое перечисление `info`/`warning`/`error` + зарезервированные
  строки), обязательные `severity` и `title`, необязательный `description` (null равен отсутствию) — по схеме
- Compaction — кадры `sessionUpdate: "compaction_update"` (обязательные `compactionId`, `status`: `in_progress`/`completed`/`failed`/`cancelled` + др.;
  `summary` — список контент-блоков с patch-семантикой: отсутствие = «не менять», null/[] = очистить, значение = заменить; `error` — строка)
  и `sessionUpdate: "compaction_summary_chunk"` (`compactionId` + один контент-блок: первый увиденный id создаёт сущность, чанки дописываются).
  Живая доставка и воспроизведение при `session/load` идут по той же capability

## [проверено по коду] Что делает адаптер Claude, если клиент capability не объявил

Адаптер ничего не теряет, а переводит кадры в старую форму (`dist/session-notices.js`, `dist/context-compaction.js`,
`dist/acp-agent.js:2812`):

| Событие | С capability | Без неё |
|---|---|---|
| Уведомление (остановлена задача, смена режима и т.п.) | кадр `notice` | сообщение агента `agent_message_chunk` с жирной меткой: `**Заголовок:** описание` |
| Сжатие контекста | кадры `compaction_update` | синтетический вызов инструмента «Compact conversation», вид `think`, `in_progress` → итог |

До 26.10 у нас уведомления шли как текст ответа агента, а сжатие — как строка инструмента.

## [решение владельца] Вариант А — notice строкой, compaction строкой «Контекст сжат»

**Контекст:** выбор способа показа перед реализацией DIGEST-1026 №1 (26.10.2026).

**Суть:** notice — отдельная строка в треде с тяжестью info/warning/error (не реплика и не пометка редактора: существующий assistant
`notice` не тронут); compaction — строка «Контекст сжат» с раскрываемой сводкой, раскрытие кликом и с клавиатуры (настоящая кнопка
с `aria-expanded`).

**Применение:** роли сообщений `acp_notice`/`acp_compaction` в `chatThreadServiceTypes.ts`, компоненты `AcpNoticeLine`/`AcpCompactionLine`
в `AcpChat.tsx`; подписи: «Сведение/Предупреждение/Ошибка»; «Сжатие контекста…» (in_progress) → «Контекст сжат» (completed),
«Не удалось сжать контекст» (failed), «Сжатие контекста отменено» (cancelled), нейтральное «Сжатие контекста» для неизвестных стадий.

## [реализовано] DIGEST-1026 №1 — сквозной путь notice/compaction (26.10.2026, next)

**Суть:** capability объявлена только вместе с полной обработкой (разбор → события → журнал → mirror → UI → экспорт):
- `acpProtocol.ts`: разбор `notice`/`compaction_update`/`compaction_summary_chunk`, типы `AcpNoticeSeverity` (неизвестная тяжесть — `other`,
  не info), `AcpCompactionStatus` (`unknown` не терминален), `isCompactionSettled`; `initialize` объявляет `notices: {}` и `compaction: {}`
- `vibeAcpMainService.ts`: события `notice`/`compaction`/`compactionChunk` наружу; кадры `session/load`-replay гасятся вместе со всеми
  прочими — воспроизведённая сущность идёт под НОВЫМ id (uuid сообщения со сводкой), слить невозможно, пересылка дала бы дубль строки
- `acpSessionLog.ts`: записи `acpNotice`/`acpCompaction`; схождение по `compactionId` на месте (повторные терминальные кадры SDK —
  без дублей; завершающий кадр без сводки не стирает накопленные чанки); `settleTurn` гасит оборванное сжатие в `cancelled`
- audit: `acp_notice` (текст гостя через редектор и потолок 200) и `acp_compaction` (одна запись на терминальную границу, сводка не кладётся)
- `acpThreadMirror.ts` + `chatThreadServiceTypes.ts`: узкие роли `acp_notice`/`acp_compaction`; `acpChatRunner._settleLeftovers` гасит
  «вечное» in_progress сжатие, оставленное перезапуском IDE; telegram-мост читает новые виды записей
- экспорт `chatThreadToMarkdown.ts` сохраняет обе роли; сериализация треда — generic JSON, новые роли переживают её без правок
- токен `vibe-error` (`--vibeide-danger`) в `vibeide.css` + `tailwind.config.js`

**Применение:** 82 focused unit-теста (acpProtocol/acpSessionLog/acpThreadMirror/acpAudit/chatThreadToMarkdown) зелёные,
common-набор vibeide 4609 зелёный, `compile-check-ts-native` 0 ошибок, `buildreact` успех, `git diff --check` чист.
Код лежит незакоммиченным в worktree `/Volumes/Storage/Caches/vibeide/digest-1026-next` (коммит/push — за бригадиром).

## [смоук] Живой Claude 0.95.0 — два хода по подписке (26.10.2026)

**Контекст:** стенд `/Volumes/Storage/Caches/vibeide/digest-1026-smoke/` (worktree, launch skill, memory guard включён,
lock `stand.lock` через `shlock`; агент закреплён `@0.95.0` только в smoke-workspace). Ровно 2 реальных prompt-хода, лимит не превышен.

**Суть (факты, без маскировки):**
- PASS: ход 1 (чтение notes.txt) — сессия ACP создана, карточка «Read notes.txt», русский ответ; ход 2 (`/compact`) — строка
  «Контекст сжат» со сводкой вместо legacy tool-card (capability объявлена и обработана); раскрытие кликом и Enter с фокусом;
  reload окна → дублей нет (persistence)
- НЕ подтверждено: live notice — за эти два хода штатный триггер не пришёл. Офлайн-проба адаптера (initialize/session/new/config,
  0 ходов): смена режима `auto`/`bypassPermissions`/`plan` и включение fast-mode на уровне config notice не дают — по коду адаптера
  Auto-fallback заметен только для моделей без Auto, fast-off — только при отказе SDK mid-query. Это **не полный PASS по notice**:
  разбор/показ severity подтверждены unit-тестами, живой кадр не зафиксирован
- Ограничение: переход compaction in_progress→completed не пойман (не логируется, финал — completed виден в DOM и персистентном треде)
- Артефакты: `shots/01–09` (выбор агента, ход 1, compaction-строка, сводка кликом/клавиатурой, после reload), `logs/` (launch.json,
  code-log-acp-excerpt.log, adapter-probe.log, smoke-summary.log)

**Применение:** повторная проверка live notice требует триггера уровня query (кандидат: фоновая задача → «Task stopped by user»)
и отдельного разрешения владельца на ход — без него не делать.

## [зафиксировано] Побочные факты стенда (26.10.2026)

- `npm ci` на origin/next заблокирован рассинхроном манифестов: `Missing: cpu-features@ from lock file` (`cpu-features` есть
  в package.json, нет в lock) — предсуществующее состояние ветки, не правка. Ставилось `npm install` без изменения манифестов,
  оба package-lock восстановлены из git после установки
- `react-typecheck`: 3 ошибки `Cannot find name 'process'` в `vibeCustomCommandsService.ts` — файл этой работой не тронут,
  ошибки предсуществующие, владельцу не приписывать
- Авторизованный source-профиль для launch skill: `~/.vscode-oss-dev` пуст (только extensions); использован
  `~/Library/Application Support/Code` (globalStorage/state.vscdb на месте). Аутентификация Claude — через `claude` CLI 2.1.286,
  ключница ОС (проверено косвенно: `session/new` адаптера проходит, `apiType=native`)

## [не проверено] Что остаётся неизвестным

- Другие гости (Cursor, Kimi Code CLI, OpenHands) эти capability вообще читают или нет: в реестре у агентов версии схемы не указаны
- `session/load`-replay: адаптер материализует сущность compaction терминально под новым id — мы её гасим; поведение при resume —
  без изменений (кадров нет)
