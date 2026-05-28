# Обрывы и зависания модели (model stalls)

> Журнал наблюдений за случаями, когда LLM-ассистент в чате обрывается, замолкает, не дописывает ответ или генерирует «псевдо-tool-call» без фактического вызова инструмента.
>
> **Цель:** накопить статистику симптомов → выйти на корневую причину (модель, провайдер, рендер, контекст, инструменты).

---

## Workflow

1. Пользователь сообщает об инциденте (триггерные слова — ниже).
2. Ассистент:
   - задаёт уточняющие вопросы (если их мало в исходной жалобе),
   - **перед диагнозом «runaway-loop» обязательно** запрашивает один сигнал из UI чата (см. антипаттерн ниже),
   - добавляет запись в **раздел «Журнал инцидентов»** по шаблону,
   - если набирается ≥3 похожих случая — переносит обобщение в **«Паттерны»**.
3. Раз в N инцидентов (≥10) — ревизия: сверить с гипотезами, обновить митигации.

### Антипаттерн диагностики: повторяющиеся expand/promptDump логи ≠ runaway

В DevTools-логе **нормальный** agentic multi-step выглядит идентично runaway:

```
[VibeIDE/Skill] expand intercept
[VibeIDE/Skill] expand result
[VibeIDE/Skill] final context built
[VibeIDE/promptDump] final prompt summary
[aiSdkAdapter] provider=...
```

Эти 4-5 строк логируются **каждой итерацией tool-loop'а** — 6-20 повторов = норма для тяжёлого запроса. Цифры `Context smart truncation: ~A → ~B` могут совпадать не потому что контекст «залип», а потому что усечение динамически подгоняет prompt к одному потолку — содержимое внутри может быть разным.

**Перед тем как заявить runaway** — обязательно запросить ОДИН сигнал из UI чата:

1. **Спиннер висит, в чате пусто/не растёт** → реальный runaway или stall.
2. **Появляются Read file / Рассуждение / новый текст** → нормальный мульти-степ, ждать.
3. **Тост «Empty response» / «Stream stalled»** → ошибка провайдера, не runaway.

Без этого сигнала **не предлагать новые предохранители** (`MAX_*`, `NO_PROGRESS_*` и т.п.). Существующие защиты (`DEFAULT_MAX_AGENT_LOOP_ITERATIONS`, `MAX_CONSECUTIVE_TOOL_ERRORS`, `AUTO_DOWNGRADE_THRESHOLD`, 120s stream watchdog) уже покрывают реальные случаи. См. инцидент #005 — урок с двумя false-positive диагнозами «runaway».

## Триггерные слова и алиасы

Любое из следующих в сообщении пользователя — повод **сразу** открыть этот файл и зафиксировать инцидент:

- **Прямые:** «модель повисла», «модель оборвалась», «модель остановилась», «модель замолчала», «модель прервалась», «модель зависла», «модель застряла», «модель не дописала», «модель не докончила», «перестала думать», «перестала отвечать», «перестала писать».
- **Про ответ:** «ответ оборвался», «ответ обрезан», «ответ не дописан», «ответ обрублен», «обрыв», «обрыв связи», «отвалилась», «отвалилось», «отвалился ответ».
- **Про инструменты:** «не вызвала тул», «не вызвала инструмент», «псевдо-tool-call», «тул-колл текстом», «нарисовала read_file текстом», «висит на read_file», «висит на вызове».
- **EN-алиасы:** `stall`, `stalled`, `stuck`, `halted`, `cut off`, `truncated`, `hang`, `hanging`, `died`, `dropped`.

> Расширять список по мере появления новых формулировок от пользователя.

## Шаблон записи инцидента

```markdown
### YYYY-MM-DD HH:MM — <короткий заголовок>

- **Где:** проект / репозиторий / директория (если известна).
- **Что делали:** задача / шаг сценария.
- **Симптом:** что именно сломалось (текстом обрыв / повтор / псевдо-tool-call / пустой ответ / зацикливание).
- **Последние строки ответа модели:** буквальный хвост (1–3 строки), если есть.
- **Окружение:** клиент (Claude Code / Cursor / web), модель (Opus 4.7 / Sonnet 4.6 / …), режим (Normal/Plan/Agent), MAX-режим, провайдер.
- **Контекст:** длина диалога, недавние большие tool-результаты, недавние ошибки.
- **Гипотеза:** одна-две версии причины.
- **Действия пользователя:** что помогло продолжить («продолжи» / новая сессия / смена модели / откат).
- **Связано с инцидентами:** `#NN`, `#MM` (если похоже).
```

---

## Журнал инцидентов

<!-- Добавлять новые записи СВЕРХУ. Нумерация сквозная, инкрементная. -->

### #013 — 2026-05-28 — read_file на несуществующем пути заморозил Extension Host на 9.4 минуты + потеря исходной задачи

- **Где:** проект Promed (огромный репо), Agent, kimi-k2.6 через openCode. Лог `D:\Temp\vscode-app-1779958827503.log`. Жалоба: «kimi потеряла смысл» — на вопрос «какой был первый промпт» модель ответила НЕВЕРНО (назвала read DeathEditWindow.js вместо реальной задачи про getWnd).
- **Симптом:** `toolExec done {tool:'read_file', ms: 565214}` — ОДИН read_file висел **565 секунд (9.4 мин)**; всё это время `[VibeIDE/vibeideModel] InitializeModel error: EntryNotFound (ENOENT)` для `c:\Repo\Promed\jscore\Forms\Admin\DeathEditWindow.js` спамился **сотни раз**, EH `unresponsive`, сработал `VibeEHCrashRecovery` (pause-and-prompt-resume).
- **Корень (подтверждён кодом) — ДВА бага в нашем коде:**
  1. **Неотменяемый fallback-поиск.** read_file (и `search_in_file`, `search_symbols`) при не-найденном пути делал `searchService.fileSearch(query, CancellationToken.None)` — БЕЗ таймаута. Путь `DeathEditWindow.js` модель галлюцинировала (его нет), raw-read упал → fallback искал файл по basename по ВСЕМУ гигантскому репо без отмены → 565с-зависание EH.
  2. **ENOENT не распознавался.** `vibeideModelService.initializeModel` ловил только `FileOperationError`+FILE_NOT_FOUND, а прилетал сырой `FileSystemProviderError` (code `FileNotFound`=«EntryNotFound») → ре-throw → `vibeLog.debug('InitializeModel error')` спам + кэш существования НЕ заполнялся → каждый повтор ре-статил.
- **Фикс (реализован 2026-05-28):**
  1. `fileSearchCapped(query, 10s)` — таймаут-отмена для всех трёх fallback-поисков (read_file/search_in_file/search_symbols). Missing-файл теперь fail-fast («File does not exist») вместо заморозки EH.
  2. `isFileNotFoundError()` распознаёт ENOENT обоих типов → `exists=false` кэшируется → тихо, без спама и без ре-стата.
- **Потеря исходной задачи (отдельно):** на вопрос про первый промпт модель не ответила, т.к. `convertToLLMMessage smart truncation ~153401 → ~10953` срезает старое, включая первую постановку задачи. Это **payload-уровень**, отдельный от thread-trim #012 (мой pin #012 держит задачу в `thread.messages`, но payload-усечение её всё равно может выкинуть). Плюс этот build — ДО моих фиксов (#012 и др. не собраны, «не билди»). → backlog: pin первого user-сообщения и в `convertToLLMMessage`-усечении.
- **Честно:** зонтик — качество kimi/openCode (галлюцинация пути, грайнд), но два бага выше — НАШИ и воспроизводимы на любой модели, давшей несуществующий путь на большом репо.
- **Связано:** #011 (тот же openCode-грайнд, неотменяемый grep — там 15с-cap уже был; здесь fallback-поиски его не имели), #012 (та же потеря задачи, но thread-cap vs payload-truncation).

---

### #012 — 2026-05-28 — «модель всё забыла»: thread-trim вырезал исходную задачу → агент здоровается заново

- **Где:** проект BookCatalog (Yii2/PHP), Agent-режим, deepseek-v4-pro через openCode, Автопилот, ∞ итер. Лог `D:\Temp\vscode-app-1779958827503.log`.
- **Симптом:** после долгой работы модель прочитала конфиги (nginx.conf, deploy-docker.sh, Dockerfile, goals.md, rules.md) и выдала «Добрый день! Я вижу, что вы работаете над BookCatalog… **Контекст сессии пуст — цели не заданы.** С чего начнём?» — будто сессия новая. Контекст при этом всего **~12040/94208 (13%)** — НЕ переполнение.
- **Корень (подтверждён логом+кодом):** не overflow, а **per-thread message cap**. `_addMessageToThread` (`chatThreadService.ts`, `vibeide.chat.maxMessagesPerThread`=500, TRIM_HEADROOM=100) при превышении делал `nextMessages.slice(dropCount)` — выкидывал **101 самое СТАРОЕ** сообщение. За сессию это сработало **5 раз** (10:13, 10:29, 11:01, 11:25, 11:54 в логе) на одном треде → **первое user-сообщение с исходной задачей «уехало»** из треда полностью. Скрин «всё забыла» — 11:57, сразу после trim 11:54:33. convertToLLMMessage суммаризует то, что ОСТАЛОСЬ в треде, а там начала уже нет → модель резонно решает, что задача не задана.
- **Фикс (реализован 2026-05-28):** при обрезке **закрепляем первое `user`-сообщение** (исходную задачу) в голове треда, если оно попадало в выкидываемый диапазон: `[anchor, trimMarker, ...tail]`. Дубликата нет (re-add только когда `firstUserIdx < dropCount`). Память по-прежнему ограничена (одно лишнее сообщение пренебрежимо), OOM-защита cap сохранена.
- **Не путать с:** convertToLLMMessage smart-truncation (она режет PAYLOAD под потолок токенов, суммаризируя; здесь контекст был 13% — payload-truncation ни при чём). Это именно thread-level cap, режущий историю в памяти/на диске.
- **Связано:** #011 (тот же thread d69618b9, те же trim-логи), #005 (cap введён против OOM — не убираем cap, а делаем его умнее: pin задачи).

---

### #011 — 2026-05-28 — kimi-k2.6 через openCode грайндит ~22 мин на поиске, уходит в чужой репозиторий, стопится пустым ходом

- **Где:** проект Promed (workspace `c:\Repo\Promed`), Agent-режим. Задача: «Найди все вызовы `getWnd('swMedSvidPntDeathEditWindow')`, кто передаёт `modeNewSvid`».
- **Симптом:** 44 итерации в первом запросе + ~20 после «продолжи» (~22 мин, **918k токенов**, авто-reset), контекст режется ~120k→~8k виток за витком. Все ходы `textLen: 0` (нарратив не выдаётся, только tool-calls). Финал — `llmTurn done {toolCall: null, textLen: 0, reasoningLen: 107}` после 49.8s → пустой ход без инструмента → agent завершает ход → тихая остановка.
- **Окружение:** модель **kimi-k2.6**, провайдер **openCode**, режим Agent, Автопилот, `maxLoopIterations:0` (∞, выключено пользователем), `allowReadOutsideWorkspace` on-by-default.
- **Корень (слоями, подтверждено кодом+логом):**
  1. **Качество модели (первично):** kimi-k2.6 через openCode — слабая agentic-стратегия поиска: повторяет один и тот же широкий `grep`, не сужает scope, не синтезирует ответ из уже найденного. Семейство #001/#008 (aggregator-проксированные грайндят).
  2. **grep 15s-cancel без actionable-фидбэка:** на огромном репо `grep` стабильно отваливался на ровно ~15000ms (`grepCts.cancel()` в `toolsService.ts`) → `searchService.textSearch` бросал «Canceled» → модель видела голую ошибку и **переотправляла тот же широкий grep**. Нет сигнала «сузь scope». ← **починено в коде**.
  3. **Заход вне workspace:** `ls_dir c:\`, чтение/поиск по `c:\Repo\Promed_2\…` (чужой репо) — `ok:true`, т.к. `vibeide.agent.allowReadOutsideWorkspace` **on-by-default** (осознанно: запрет обходится через run_command). Пользователь матерился «нахуя полез в Promed_2». ← **не баг, а настройка**.
  4. **Нет лимита итераций:** `maxLoopIterations:0` (выключен пользователем) → 44 витка без отсечки. Предохранитель есть, отключён (как и в `AB`-заметке про этот же кейс).
  5. **Пустой финальный ход = тихий стоп:** ход с reasoning, но без text/tool → agent-loop завершает ход без сообщения. Не новость, дизайн цикла.
- **Фикс (реализован 2026-05-28):** `grep` на 15s-таймауте теперь бросает **actionable** сообщение вместо «Canceled»: «cancelled after 15s — scope too large; narrow with search_in_folder / more specific pattern / glob/file_type». Покрывает обе ветки (throw и partial-return). Цель — чтобы модель сузила scope, а не долбила тот же grep.
- **Ответы пользователю (config, не код):** (а) чтобы агент не лез в соседние репо/`c:\` — `vibeide.agent.allowReadOutsideWorkspace: false`; (б) чтобы грайнд отсекался — вернуть `vibeide.agent.maxLoopIterations` > 0 (сейчас ∞); (в) шумные категории логов глушатся новым `vibeide.logging.categoryLevels`.
- **Честно:** первопричина — качество kimi-k2.6 через openCode; наш фикс снижает грайнд (модель получает подсказку сузить поиск), но слабую модель сильной не делает. Проверять на стабильной модели (deepseek/claude) — вывод #004.
- **Связано:** #008 (тот же openCode-грайнд, XML-залипание), #010 (тот же день, рассинхрон инструмент↔параметры), #005 (не плодить предохранители спекулятивно — поэтому правим фидбэк grep, а не вешаем новый счётчик).

---

### #010 — 2026-05-28 — Агент встал в петлю «имя инструмента ↔ форма параметров» (deepseek через openCode Go), выжег весь токен-бюджет

- **Где:** проект BookCatalog (Dockerfile/.dockerignore), Agent-режим.
- **Что делали:** агент исследовал проект; пользователь прислал DevTools-лог («агент опять остановился»).
- **Симптом:** модель шлёт правильные параметры под ЧУЖИМ именем инструмента → `[VibeIDE/Tool] invalid params` → schema-hint → ретрай. Два подтверждённых случая в логе:
  1. `run_command` ← `{uri: "...Dockerfile"}` (форма **read_file**, `command` undefined).
  2. `read_file` ← `{query: ".dockerignore", search_in_folder: "..."}` (форма **search_for_files**, `uri` undefined).
  Параллельно TokenBudget рос 81% → 100% → авто-reset (2 012 769 токенов), затем срез 101 старого сообщения (cap=500). Последняя строка лога — `auto-routing read_file → run_command`, т.е. старый корректор сработал лишь для ОДНОГО направления.
- **Окружение:** модель **deepseek** через провайдера **openCode (Go-сборка)**, режим Agent, Автопилот (session-token-limit 2 000 000).
- **Корень (подтверждён кодом):** ДВА gap'а.
  1. **Shape-корректор односторонний** (`chatThreadService.ts` `_runToolCall`): распознавал только форму `run_command` (`{command,…}`). Формы `read_file` (`{uri}`) и `search_for_files` (`{query, search_in_folder}`) не покрывал → падали в валидацию.
  2. **Circuit breaker слишком узкий** (`sameLoop`): требует N подряд `invalid_params` с ОДНИМ именем + ОДНОЙ сигнатурой ключей. Модель «болталась» между разными формами и перемежала их тяжёлыми reasoning-ходами → `sameLoop` никогда не истинно → бугор молчал → бюджет выжжен.
- **Сверено по валидаторам** (`toolsService.ts`): `read_file`→`uri`, `search_for_files`→`query`+`search_in_folder`, `run_command`→`command`.
- **Фикс (реализован 2026-05-28):**
  1. Shape-корректор сделан **многоформенным и консервативным** — `{command}`→run_command, `{query,search_in_folder}` без uri→search_for_files, `{uri,…}` без command/query/pattern→read_file (только если запрошен был non-uri инструмент). Матчит форму, НЕ имя модели.
  2. Добавлен **thrash-брейкер**: ≥M (default 6, настройка `vibeide.chat.toolInvalidParamsThrashBreakerThreshold`) подряд `invalid_params` любого имени/формы без успешного вызова между ними → trip. M>2, чтобы self-recovery (#006) не обрывался.
  - Детали механики — `docs/knowledge/chat-ux/circuit-breakers.md`.
- **Замечание (честно):** в этом инциденте `invalid_params` перемежались успешными вызовами, поэтому thrash-брейкер (строго «подряд») мог бы и не сработать — РЕАЛЬНОЕ лекарство здесь shape-корректор (убирает падения в корне). Брейкер — backstop для будущих неизвестных форм. Если появится thrash с успехами между ошибками, всё ещё выжигающий бюджет — пересмотреть на ratio-детектор (N из последних M), но не раньше, чем накопятся данные (урок #005: не плодить предохранители спекулятивно).
- **Связано:** #006 (та же aggregator-семья, self-recovery после invalid_params — порог M подобран так, чтобы её не рубить), #008 (другой stall той же deepseek/openCode-связки — XML-залипание после auto-downgrade).

---

### #009 — 2026-05-25 — «Empty response from openCode/minimax-m2.7 (reason: unknown)» — у minimax не выставлен reasoning-roundtrip quirk

- **Где:** VibeIDE 0.13.16, Agent-режим, провайдер openCode, модель minimax-m2.7.
- **Симптом:** тост `VibeIDE: Empty response from openCode/minimax-m2.7 (reason: unknown).` (в консоли — из `aiSdkAdapter`). Пользователь: «мы же это лечили?».
- **Что лечили раньше:** `reason: tool_calls` (drop tool_calls без `index` у агрегаторов) → миграция на AI SDK. Это **другой** finish-reason.
- **Корень (подтверждён кодом):** minimax-m2.x — **interleaved-reasoning** семейство (так и помечено в `modelQuirksTypes.ts:61`): требует reasoning-слот roundtrip на каждом assistant-ходе, иначе openCode/upstream закрывает стрим пустым телом → `reason: unknown` (см. комментарий `aiSdkAdapter.ts:378-384`). Quirks `forceEmptyReasoning`/`mirrorReasoningContent` стояли у **deepseek**, но у **minimax — нет** (только temperature/topK + xml). Их просто забыли добавить.
- **Доп. находка (pre-existing bug):** `matchQuirks` (`modelQuirksTypes.ts:129`) — **first-match-wins**, не merge. Правило `minimax-m2.7` (без provider) стоит в каталоге ВЫШЕ правила `minimax via openCode` → последнее **затенено** и никогда не применяется (то же для kimi via openCode). Поэтому `forceToolCallFormat: xml` для minimax+openCode из quirk не применялся (XML включался только через runtime auto-downgrade).
- **Фикс:** в `resources/model-quirks.json` добавлены `forceEmptyReasoning: true` + `mirrorReasoningContent: true` в правила `minimax-m2.7/m2.5/m2/minimax` (на этих правилах, т.к. именно они матчатся первыми). JSON — единый source of truth для bundled-fallback и CDN. Также переименован обманчивый `isDeepseek` → `forceEmptyReasoningSlot` в `aiSdkAdapter.ts`.
- **Открыто (roadmap):** затенение provider-scoped правил порядком в каталоге — нужен либо reorder (provider-rules выше family-rules), либо most-specific-wins вместо first-match. Делать осознанно (взаимодействует с O.11 reason-specific downgrade). Проверить kimi-k2-thinking — у него `mirrorReasoningContent` есть, а `forceEmptyReasoning` нет (вероятно тот же пробел).
- **Связано:** #001 (та же модель/провайдер — там это и наблюдалось впервые, тогда списали на flakiness), #006 (minimax работал в XML через auto-downgrade).

---

### #008 — 2026-05-25 13:05 — Агент стопится на каждом шаге (текст без tool-call) — застрял в XML после auto-downgrade

- **Где:** VibeIDE Dev, проект BuzzBang/admin. Сценарий — отладка `EmptyError: "no elements in sequence"`, агент ищет `.first()` в cloud-функциях.
- **Что делали:** Agent-режим, deepseek-v4-pro через openCode. Пользователь раз за разом пишет «Продолжи».
- **Симптом:** Модель эмитит **текст без tool-call** («Начинаю с поиска.», «Найду все .first(») и ход завершается → `awaiting_user`. Накануне (скрин #1) — утечка **сырых XML-тегов** `<run_command>…` в чат (fallback на Get-Content после блокировки read вне workspace). Оба симптома = модель в **XML-fallback режиме**.
- **Окружение:** провайдер `openCode`, модель `deepseek-v4-pro`, режим Agent, «Автопилот» виден в нижней панели, `∞ итер`. Контекст ~5237/94208 (6%).
- **Гипотеза (подтверждена кодом):** Корень — **VibeIDE-специфичный auto-downgrade** (`chatThreadService.ts` `AUTO_DOWNGRADE_THRESHOLD = 3`): после 3 подряд tool-ошибок пишется персистентный `_autoDetected`-оверрайд `specialToolFormat: undefined` → модель уходит в XML-fallback. deepseek-v4-pro по умолчанию (через `aggregatorOpenAIFallback`) идёт на **native FC** — но после даунгрейда залипает в XML, где ненадёжно эмитит теги → нарратив без tool-call → стоп. TTL оверрайда — **7 дней** (`AUTO_DOWNGRADE_TTL_MS`), а re-probe (`RE_PROBE_AFTER_SUCCESSES = 20`) завязан на session-scoped `downgradedModelsThisSession` → после рестарта окна re-probe не запускается, залипание держится днями.
- **Сравнение с opencode (root-cause divergence):** opencode CLI **не имеет** такого breaker'а — держит модель на native FC и даёт ей итерироваться до успеха (это прямо признано в нашем же комментарии `chatThreadService.ts:99`: *"opencode CLI has no breaker — model just keeps iterating until it succeeds"*). Их цикл (`packages/opencode/src/session/prompt.ts`) тоже завершается на ходе без tool-call (`finish && finish !== "tool-calls" && !hasToolCalls`), `toolChoice:"required"` ставится только для structured-output — то есть стратегия цикла идентична, расхождение **только** в наличии у нас downgrade-to-XML.
- **Действия пользователя (немедленный unblock):** Settings → Models → Overrides → deepseek-v4-pro (openCode) → сбросить auto-detected `specialToolFormat` (вернуть native FC). После этого «Продолжи» не понадобится.
- **Связано с инцидентами:** #001 (та же модель/провайдер — там empty response на tool-only серии), #004/#007 (та же модель РАНЬШЕ работала на native — подтверждает, что XML-режим и есть регрессия), #005 (тот же auto-downgrade контур).
- **Фикс (реализован 2026-05-25, roadmap O.11–O.12):** (1) auto-downgrade теперь только на `numeric-tool-name` (deepseek-v4-pro в XML больше не попадает); (2) `AUTO_DOWNGRADE_THRESHOLD` 3→6; (3) cross-session recovery — стейл `_autoDetected`-оверрайд **безусловно снимается** раз за сессию (первая версия с probe-on-success не годилась: модель в XML не даёт успеха → залипание самоподдерживалось, что и наблюдалось на 0.13.16), `RE_PROBE_AFTER_SUCCESSES` 20→5; (4) vendor-leak scrub — `<invoke>`/`<tool_calls>` и обрезанные `</inv`/`</tool_c` больше не протекают в чат; (5) watchdog `heapSnapshotOnRapidGrowth` — snapshot по Δ-RSS за тик (для диагностики будущих OOM; <60-с спайк всё ещё требует меньшего `intervalMinutes`). Уже залипшие модели восстанавливаются автоматически при следующем запросе; ручной сброс через Settings → Models → Overrides больше не обязателен.

---

### #007 — 2026-05-19 17:57 — deepseek-v4-pro через openCode полностью выполнил skill `deadborn-process-load`

- **Где:** VibeIDE Dev, проект Promed. Тот же скилл `/skill:deadborn-process-load`. Повторный тест на deepseek-v4-pro после фиксов #002/#003.
- **Что делали:** Отправили `/skill:deadborn-process-load`.
- **Симптом:** **Всё работает корректно.** Модель прочитала `process.md` через `read_file` (без invalid_params), выдала развёрнутый структурированный итог в чате — разделы «EvnDirectionDeadbornData — автозаполнение», «csComboRepeater / csContainerRepeater — борьба с гонками», «Открытый техдолг», «Резюме». Контекст в финале ~27162 / 94208 (29%), `last: 25029 in / 2133 out`.
- **Окружение:** dev-инстанс VibeIDE 2026-05-19, провайдер `openCode`, модель `deepseek-v4-pro`, режим Agent. `supportsSystemMessage: false`, `sysLocation: 'folded-into-user'`, `systemLen: 22029`.
- **Контекст:** Тот же pipeline что в #004, без изменений. **DevTools открыт** — в логе видны 7 идентичных повторов `expand intercept/result/promptDump` (каждый виток tool-loop'а). Это ввело ассистента в заблуждение → ошибочный диагноз runaway → см. #005.
- **Гипотеза:** Подтверждена ещё раз (после #004, #006): pipeline универсально корректен и для deepseek-v4-pro через openCode-aggregator.
- **Действия пользователя:** —
- **Связано с инцидентами:** #004 (тот же positive паттерн), #006 (тот же сегодняшний тест на минимаксе), #005 (мой ошибочный диагноз runaway по этим самым логам).

---

### #006 — 2026-05-19 16:30 — minimax-m2.7 через openCode выполнил skill с self-recovery после двух invalid_params

- **Где:** VibeIDE Dev, проект Promed. Тот же скилл `/skill:deadborn-process-load`. Повторный тест на минимаксе после фиксов #002/#003 и удаления `MAX_FILES_READ_PER_QUERY`.
- **Что делали:** Отправили `/skill:deadborn-process-load`.
- **Симптом:** **Всё работает.** Модель сделала две ошибочные попытки, **сама** скорректировалась и довела задачу до конца:
  1. `read_file` с абсолютным путём `c:\Repo\Promed\.cursor\notes\feature\protocol-deadborn\process.md` → workspace-guard отбил (`Error: File ... ensure path is relative to the workspace root`).
  2. `run_command` с `cat "d:\Projects\Promed\..."` → валидатор run_command отбил (`ToolValidationError: read_file paginates and accepts startLine/endLine`).
  3. **Самокоррекция** — `read_file process.md` с пагинацией (1-100, 101-200, 201-303), три успешных вызова.
  4. Финальный структурированный ответ в чате: «Где остановились», «Актуальная структура формы», «Что в бэке готово», итоговый прогресс.
- **Окружение:** dev-инстанс VibeIDE 2026-05-19, провайдер `openCode`, модель `minimax-m2.7`, режим Agent. `supportsSystemMessage: 'system-role'`, `sysLocation: 'role-system'`, `systemLen: 19796`.
- **Контекст:** Pipeline после фиксов #002 (skill body в user) + #003 (closing contract) + удаления `MAX_FILES_READ_PER_QUERY` 2026-05-19 (без cap'а 3 read_file pagination'а уже не упёрлись бы в лимит даже если бы было больше файлов). Workspace-guard корректно отбил абсолютный путь из тела SKILL.md, run_command validator корректно подсказал использовать read_file.
- **Гипотеза:** Подтверждена: минимакс **сегодня** работает стабильнее, чем в #001 (где empty response). Возможные причины улучшения: (a) более новая версия aggregator/модели; (b) короче запрос (1 файл вместо длинной tool-цепочки из #001); (c) наш pipeline лучше структурирует prompt после #002/#003. Уточнить непросто, но факт: на этом сценарии — работает.
- **Действия пользователя:** —
- **Замечание про сам скилл:** Тело `deadborn-process-load/SKILL.md` содержит **абсолютный путь к чужому workspace** (`c:\Repo\Promed\...`) — модель сначала пробует его буквально. В этом workspace путь не существует, поэтому workspace-guard отбивает. Это **отдельный bug в самом скилле** (привязка к Promed-репо). Pipeline не виноват. Зафиксировать в отдельной записи `docs/knowledge/chat-ux/` если будет повторяться.
- **Связано с инцидентами:** #001 (та же модель — раньше empty response, теперь self-recovery), #003 (тот же скилл — раньше verbatim dump, теперь корректный summary).

---

### #005 — 2026-05-19 06:29 — Реальный «откат рассуждения» (deepseek-v4-pro / openCode) + WerFault 0xc0000142 OOM

- **Где:** VibeIDE Dev, проект Promed. `/skill:deadborn-process-load`. Утренний инцидент.
- **Что делали:** Та же команда `/skill:deadborn-process-load`. Параллельно открыт DevTools, велась активная работа.
- **Симптом:** **Реальный паттерн runaway по описанию пользователя** — модель «начинает делать, потом как бы откат рассуждения, и снова думает по кругу». Tool calls и reasoning блоки появляются в UI чата, потом **визуально откатываются**, потом модель снова думает с начала — несколько циклов. В итоге **система ушла в OOM** (Task Manager: «На устройстве не хватает памяти, 87%»), `WerFault.exe` упал с `0xc0000142` (STATUS_DLL_INIT_FAILED) — не смог инициализировать DLL для дампа, потому что памяти на инициализацию уже не было.
- **Последние строки ответа модели:** не зафиксированы (Renderer ушёл с системой).
- **Окружение:** dev-инстанс VibeIDE 2026-05-19, провайдер `openCode`, модель `deepseek-v4-pro`, режим Agent. `supportsSystemMessage: false`, `sysLocation: 'folded-into-user'`, `systemLen` ≈ 24593. **DevTools открыт** на момент крэша.
- **Контекст:** Из лог-окна 16:39–16:42 (отдельный поздний прогон того же сценария — НЕ утренний, но похожий): 22 итерации за ~3 минуты, два `[VibeIDE/Tool] invalid params` (read_file с `c:\Repo\Promed\...`, run_command с `cat`), идентичный truncation `~66329 → ~17973` повторяется виток за витком. **Важно: позже тот же тест (#007) прошёл успешно — паттерн не воспроизводится стабильно.**
- **Гипотеза (две не-исключающих):**
  1. **Реальный rollback-loop**: deepseek-v4-pro через openCode aggregator при `sysLocation: 'folded-into-user'` (system запихан в user) может на некоторых сборках выдавать tool_call → откатывать его → пробовать снова. Это **на стороне провайдера/аггрегатора**, наш loop этого не различает (для нас каждый виток выглядит как обычная итерация). Если воспроизведётся — нужно искать различие в response stream (delta-блоки с tool_call_id, который потом обнуляется).
  2. **OOM как следствие, а не причина**: открытый DevTools ретейнит `console.warn` с объектами `{provider, model, systemLen, ...}` на каждой итерации. На тяжёлом мульти-степе с большим system prompt (24 KB) это набирает retain быстро. WerFault `0xc0000142` — следствие, а не первичный крэш.
- **Действия пользователя:** Система перезагрузилась после OOM. Повторные тесты этого же сценария (#006 минимакс, #007 deepseek) **прошли успешно** — паттерн «отката» не воспроизвёлся.
- **Mea culpa ассистента:** При расследовании этого инцидента ассистент **дважды** ошибся, объявив runaway по логам с повторяющимися `expand+promptDump` блоками — на самом деле это были нормальные мульти-степы (#006, #007). Чуть не нагородил лишний счётчик `NO_PROGRESS_REPEAT_THRESHOLD` поверх трёх существующих защит — пользователь правильно остановил: «лечить причины, а не последствия». Урок зафиксирован в **Workflow → Антипаттерн диагностики** (выше).
- **Что фактически сделано в этой сессии:**
  - Удалён `MAX_FILES_READ_PER_QUERY = 10` в `chatThreadService.ts` (рубил легитимный read-many-files use-case, в т.ч. read_file с pagination на 4+ страницы). Это не была причина OOM, но архитектурная ошибка.
  - План `console.warn → console.debug` для горячих логов (`expand intercept/result`, `promptDump`, `Tool invalid params`) — в работе, как мера разгрузки DevTools-ретейна.
- **Связано с инцидентами:** #001 (та же aggregator-проблема `openCode` — там empty response), #006 / #007 (повторные тесты прошли успешно).

---

### #004 — 2026-05-18 20:20 — Pipeline валиден: deepseek в чате полностью выполнил skill, ловит и intro, и closing contract

- **Где:** VibeIDE, проект Promed. Тот же скилл `/skill:deadborn-process-load`. Тест **после** фикса #003 (closing contract `"Act silently. Do NOT echo skill body or file contents verbatim. Summarize."`).
- **Что делали:** Сменили провайдера/модель на deepseek (по совету в чате после нестабильности nemotron-3-super-free). Отправили `/skill:deadborn-process-load`.
- **Симптом:** **Всё работает корректно.** Модель сразу процитировала наш intro: `"The user invoked skill:deadborn-process-load. According to the skill body, I need to read the file..."`. Затем самостоятельно прочитала `process.md` через tool и дословно воспроизвела наш closing: `"Let me now summarize... without echoing the file verbatim"`. Финальный ответ — структурированное summary (домен, слои кода, HTTP API, ExtJS форма) в виде таблиц + закрывающее «Процесс-нота загружена. Что нужно сделать?». Ровно то поведение, которого добивались.
- **Окружение:** dev-инстанс VibeIDE 2026-05-18, провайдер deepseek (через что подключён — уточнить у пользователя), модель deepseek-чат.
- **Контекст:** Pipeline унаследован от фикса #002 + #003 (skill body в user message + closing contract). Без изменений.
- **Гипотеза:** Подтверждена: наш пайплайн **универсально корректен** — skill expansion видим для модели, closing contract работает (модель его буквально цитирует в reasoning). Сбои в #001, #002 (исходно), #003 — **на стороне моделей/провайдеров**: бесплатные nemotron-3-super-free / minimax-m2.7 через opencode-zen aggregator нестабильны (empty response, stream stall, неверная интерпретация инструкций). На стабильной модели всё работает с первого запроса.
- **Действия пользователя:** —
- **Связано с инцидентами:** #001 (та же модель minimax — нестабильна), #002 (тот же скилл — раньше не видел body), #003 (тот же скилл — раньше пытался вывалить файл).

**Вывод:** Когда жалуются «skill не работает / модель галлюцинирует / стрим обрывается» — первым делом просить пользователя протестировать на стабильной модели (deepseek / claude / gpt-4-class). Если на стабильной работает, а на бесплатной/aggregator-проксированной нет — это **не наш баг**, а **инфраструктура провайдера**.

---

### #003 — 2026-05-18 19:51 — Stream stall после «verbatim dump» содержимого файла (nemotron-3-super-free / opencode-zen)

- **Где:** VibeIDE, проект Promed. Тот же скилл `/skill:deadborn-process-load`, что в #001/#002. Тест **после** фикса #002 (skill body теперь в user message).
- **Что делали:** Отправили `/skill:deadborn-process-load` — модель распознала skill (✅ #002 фикс работает), прочитала через tools `process.md` (правильным путём после самокоррекции workspace-guard'а с `C:\Repo\Promed` → `d:\Projects\Promed`), затем решила **вывалить содержимое файла дословно** в чат.
- **Симптом:** Начала вывод `Here is the content of process.md as requested:` → `1 # Pathology: протоко...` → собственная плагиаризация placeholder'а `(Note: The file content is truncated in the display above due to interface limits.)` — модель **галлюцинировала про свой UI**, утверждая что её собственный output где-то усечён. После этого обрыв на середине слова `the deadborn proto`. 120 секунд тишины → watchdog: `Stream stalled — no tokens received for 120s. The provider may be unreachable, overloaded, or rejected the request size.`
- **Окружение:** dev-инстанс VibeIDE 2026-05-18, провайдер `opencode-zen`, модель `nemotron-3-super-free`, режим Agent.
- **Контекст:** Реальный usage от провайдера (теперь приходит после AI SDK v6 inputTokens/outputTokens фикса): `last: 9644 in / 314 out`. То есть на вход ушло мало (9.6k tokens), выход короткий до обрыва. **Не overflow, не размер prompt'а.**
- **Гипотеза:** Сочетание двух факторов:
  - Сам **контент SKILL.md** содержит инструкцию «держи факты process.md в активном ответе» — модель неоднозначно прочитала как «output the file content verbatim», вместо «хранить факты для last-mile reasoning».
  - **Aggregator opencode-zen** имеет downstream TPM/output-size rate-limit, либо stream-buffer закрылся после большого output chunk. Watchdog (120s) на нашей стороне корректно отстрелил.
- **Действия пользователя:** Тред бросили на ошибке.
- **Связано с инцидентами:** #002 (тот же скилл, тот же провайдер, но другой симптом после фикса #002).

**Митигация (план, не реализовано):** В `convertToLLMMessageService.ts` при склейке `explicitSkillsUserPrefix` добавлять закрывающую системную инструкцию `"Act on the procedure silently. Do NOT echo the skill body or referenced file contents back to the user verbatim. Summarize only what's needed for the next step."` Это универсальное лекарство от dump-style ответов для всех скиллов, не только этого. См. план «опция B» в чате.

---

### #002 — 2026-05-18 20:00 — Модель игнорирует skill body внутри `<workspace_guidelines>` (nemotron / opencode-zen)

- **Где:** VibeIDE, проект Promed. Тест skill `/skill:deadborn-process-load` (тот же скилл, что в #001).
- **Что делали:** A/B-эксперимент после #001 — сменили провайдера и модель на nemotron через opencode-zen, отправили ту же команду `/skill:deadborn-process-load`.
- **Симптом:** Модель в reasoning явно проговаривает: `"The user is saying /skill:deadborn-process-load. ... The system has a skill system? Possibly they want to load a skill called 'deadborn-process-load'. However, there is no tool to load skills."` Финальный ответ: `"I'm not sure what you mean by 'deadborn-process-load'. Could you please clarify..."`. То есть skill body **в prompt был** (`skillBodyPresent: true` подтверждено dump'ом из #001 на минимаксе на том же пайплайне), но модель его **не использовала**.
- **Окружение:** dev-инстанс VibeIDE 2026-05-18, провайдер `opencode-zen`, модель `nemotron` (NVIDIA), режим Agent.
- **Контекст:** Тот же `convertToLLMMessageService.prepareLLMChatMessages` пайплайн. Skill body встраивается в system prompt через `<workspace_guidelines source=".vibe/rules.md, AGENTS.md">` тег с заголовком `## Explicitly invoked Agent Skills (full SKILL.md content)`. Позиция skill body — ~5000 chars от начала system, всего system ≈ 22k chars.
- **Гипотеза (теперь с двумя точками данных):** Модели игнорируют skill body, размещённый глубоко в system prompt под тегом «workspace guidelines». Они воспринимают этот блок как «постоянные правила проекта» (которым следуют пассивно), а не как «инструкция для текущего user-запроса». Когда юзер пишет `/skill:NAME`, модель смотрит **в user message**, видит slash-команду, ищет соответствующий tool (нет такого), и отвечает «не знаю что это» — даже если body буквально лежит в system prompt'е выше. Это работает одинаково на minimax-m2.7 (#001) и nemotron (#002) → паттерн **на нашей стороне**, не в провайдере.
- **Действия пользователя:** Переключение на nemotron — не помогло (та же проблема). Тред бросили.
- **Связано с инцидентами:** #001 (там же `skillBodyPresent: true`, но модель не отреагировала на content).

**Следующий шаг:** Перенести `explicitSkillsContext` из system prompt → в синтетическое user message (или prepend в последнее user-сообщение, содержащее `/skill:NAME`). Anthropic best-practice + Cursor/Kilo паттерн: динамический контекст в user, статические правила в system. Делается отдельной PR-задачей.

---

### #001 — 2026-05-18 19:30 — Empty response на длинной tool-only цепочке (minimax-m2.7 / openCode)

- **Где:** VibeIDE, проект Promed (медицинская система). Тест skill `/skill:deadborn-process-load`.
- **Что делали:** Юзер написал `/skill:deadborn-process-load`, модель ушла в agentic-loop — последовательно прочитала `SKILL.md`, `process.md`, делала grep/glob по проекту, читала несколько файлов. После ~12 tool calls стрим завершился пустым ответом.
- **Симптом:** Тоаст `VibeIDE: Empty response from openCode/minimax-m2.7 (reason: stop).` — провайдер закрыл стрим без единого токена с `finishReason: stop`.
- **Последние строки ответа модели:** последние два assistant'а получили `len=15` и `len=98` (короткие текстовые фрагменты), следующий шаг — empty.
- **Окружение:** dev-инстанс VibeIDE из главной ветки 2026-05-18, провайдер `openCode` (aggregator), модель `minimax-m2.7`, режим Agent.
- **Контекст:** Полный диагностический dump `[VibeIDE/promptDump]` подтверждает: `systemLen=21 669`, `skillBodyPresent=true` (skill body на позиции 5082 внутри system), `messagesCount=28` (1 system + 1 user + 13 assistant + 13 tool). Из 13 assistant'ов **12 имеют `len=0`** — модель эмитила исключительно tool calls без текста между шагами. Tool results: 854, 2264, 1221, 120×4, 3822, 6624, 6095, 120, 7557 chars. Суммарный prompt ≈ 14k токенов (length/4), далеко не предел контекста minimax. **Размер prompt'а — не причина**.
- **Гипотеза (не подтверждена, нужно ≥3 инцидента для паттерна):** minimax-m2.7 через openCode aggregator **может** терять track после длинной цепочки tool-only assistant turns (8-12+ pure tool_calls без текста между ними). `stop` приходит не как «модель закончила», а как «aggregator/upstream закрыл соединение пустым». Кандидаты причин: TPM/RPM throttle внутри aggregator, upstream-side ratelimit, нестабильность форвардера minimax↔openCode на длинных streams. Это **первая запись** на эту тему — экстраполяции на «известный паттерн» нет, нужно набирать статистику. См. репозиторий `opencode` (skill `opencode-repo`) — там у них minimax+openCode-aggregator работают стабильнее; стоит сверить их message-format при tool-only сериях.
- **Действия пользователя:** Тред бросили на этом ответе; ретрая не было (юзер отправил `/skill:` команду повторно — но это уже новый запрос).
- **Связано с инцидентами:** —

**Уточнения для будущих инцидентов:**
- Проверить: воспроизводится ли при принудительном `text: " "` placeholder между tool calls (т.е. ломая «tool-only» серию)?
- Проверить: воспроизводится ли на той же модели через прямой endpoint, минуя openCode aggregator?
- Проверить: совпадает ли точка обрыва (~10-15 tool calls) у других моделей через openCode (qwen, deepseek-thinking)?

---

## Паттерны (обобщение ≥3 похожих)

<!-- Заполняется когда наберётся статистика. Формат:
### Паттерн: <название>
- **Симптомы:** ...
- **Условия проявления:** ...
- **Гипотеза о причине:** ...
- **Известные митигации:** ...
- **Связанные инциденты:** #..., #...
-->

_Пока пусто — нужно ≥3 инцидента в одну корзину._

---

## Известные гипотезы (черновые, без подтверждения)

1. **Псевдо-tool-call.** Модель сгенерировала текст вида `<read_file><uri>...</uri></read_file>`, но фактического `tool_use`-блока не было → клиент завершил ход. Возможные причины: рендер UI экранирует тег и он попадает в текст; модель спутала свой формат с XML-разметкой; пост-процессинг провайдера вырезал tool_use.
2. **Длинный контекст / обрыв стрима.** Сеть/провайдер режут SSE-стрим на длинных ответах → клиент видит «нормальное» завершение без явной ошибки.
3. **Контекст-окно vs reasoning.** Модель «зашла» в рассуждение, не успела закрыть его и упёрлась в лимит вывода → выглядит как обрыв.
4. **Tool-loop fatigue.** После N последовательных tool-результатов модель «решает», что закончила, и стопится без финального текста.
5. **Кросс-проект баг рендера.** Скриншот может показывать не реальный обрыв, а артефакт UI чата, где XML-подобный текст не парсится как tool_use.

> Гипотезы — рабочие. Подтверждать данными из журнала, не догадками.

---

## Митигации (по мере накопления)

- **Stop-хук с auto-continue.** Детектор «оборванного» хвоста + блокировка стопа с инструкцией «продолжи». Защита от петли — счётчик. См. отдельную задачу (черновик).
- **Сокращение контекста.** Перед длинной операцией — сжатие истории / новый чат.
- **Смена модели.** Переключение на другой профиль (Sonnet ↔ Opus) при повторяющихся обрывах в одном сценарии.
- **Изоляция tool-цепочек.** Дробить длинные цепочки tool-вызовов на короткие, с промежуточным «summarise + continue».

> Дополнять по мере того, как что-то реально срабатывает.
