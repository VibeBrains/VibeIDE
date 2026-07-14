# Режимы чата и политики

← [Knowledge Index](../README.md)

Normal/Plan/Agent, autopilot vs auto-approve, pre-flight, Trust Score, T&C Suite, confidence vs LLM-judge.

---

## [ux] Режим чата Normal / Plan vs Agent: «не понял задачу», только болтовня

**Контекст:** Пользователь в VibeIDE дал конкретную команду на перенос файлов и правку путей; модель ответила размышлениями («Let me explore…») и вопросом «what would you like».

**Суть:** В **Normal** режиме в system prompt явно заложено «Ask for context. Reference with @.», **builtin tools не передаются** — нельзя править файлы и запускать команды. В **Plan** режиме мутации запрещены правилами; для переноса/редактирования нужен **Agent**. Отдельно: если в UI видно **«Context: ~N / 256 tokens»** и частые **«smart truncation»**, это был баг **defaultModelOptions** (4096 input + 4096 reserved) для неизвестных id. Исправлено: безопасный дефолт + **каталог** OpenCode Zen / OpenCode (`remoteCatalogService`): при обновлении каталога в настройках подтягиваются id с `https://opencode.ai/zen/v1/models` и др.; если в JSON появится **context_length** (и аналоги), значения пишутся в **overridesOfModel** через `mergeOverridesForProviderModels`. Пока ответ Zen — только `id`/`created`/`owned_by`, лимит окна задаётся реестром для совпадающих имён (например `gpt-5.1`), общим **defaultModelOptions** или ручным **Model Overrides**. Слабая free-модель усугубляет болтовню.

**Применение:** задачи «перенеси файлы», «замени в проекте» — только **Agent**; при слабом ответе сменить модель; при мизерном контексте в статусе — проверить, что id модели есть в capabilities.

---

## [ux] Autopilot vs «Auto-approve edits» в чате VibeIDE

**Контекст:** В Agent/Plan пользователь ожидает «как в Claude» — без вопросов на удаление; мини-переключатель у Approve «не апрувит всё».

**Суть:** **`delete_file_or_folder`** в **`editRiskScoringService`** всегда **HIGH**; в **`chatThreadService._runToolCall`** HIGH принудительно снимал **`autoApprove`** — удаления всегда ждали кнопку. Глобальный флаг **`globalSettings.chatAgentAutopilot`** (тоггл **Autopilot** в строке композера: режим → модель → **Autopilot** → reasoning) в конце ветки approval ставит **`shouldAutoApprove = true`**, обходя блок HIGH. Отдельно: **`autoApprove[type] === true`** даёт авто-проход только для **не-HIGH** операций (без Autopilot удаления всё равно спрашиваются). По умолчанию **`autoApprove`** пустой / выключен — шаги спрашиваются, пока не включат Autopilot или явные переключатели в настройках. **YOLO Mode** в Settings — про пороги риска для авто-применения, не дублирует Autopilot.

**Применение:** объяснение UX «галочка не работает»; настройка безопасного дефолта и явного «autopilot».

---

## [продукт] Cursor «Plan» vs VibeIDE pre-flight

**Контекст:** сравнение с планированием в Cursor и ожиданиями по VibeIDE.

**Суть:** в Cursor план может **сохраняться** (часто вне чата) и **выполнение продолжается после сброса контекста**. В VibeIDE **`VibePreFlightService`** — это **одобрение объёма до старта** и drift; план **не сериализуется** в `.vibe/` и не resume-ится как отдельный артефакт. Файловые планы под **`.vibe/plans/`** и resume — в `docs/roadmap.md`: блок **«Детализация — Planning & Multi-agent»** + секция **E** (усиления по рискам и UX).

**Применение:** не путать pre-flight approval с Cursor Plan; при проектировании UX планов — опираться на roadmap и `.vibe/plans/`.

---

## [договорённость] Pre-flight plan vs Task decomposition UI — разные элементы

**Контекст:** зафиксировано в docs/v1/transparency/control.md и docs/v1/agent/auto-repair.md.

**Суть:** Pre-flight plan = статический план ДО старта (модальный диалог). Task decomposition UI = live прогресс ВО ВРЕМЯ выполнения (постоянный progress sidebar). Это два разных UI-элемента.

**Применение:** при проектировании agent UX в Фазе 2.

---

## [договорённость] Trust Score — не настройка в меню, постоянный виджет

**Контекст:** явно зафиксировано в idea.md и docs/v1/agent/trust-score.md.

**Суть:** Trust Score (Manual/Supervised/Auto) — постоянный виджет в статус-баре, меняется одним кликом или keyboard shortcut. Полностью keyboard-accessible. Keyboard-first — не опция, а стандарт VibeIDE.

**Применение:** при проектировании любого UI — проверять keyboard accessibility.

---

## [договорённость] Transparency & Control Suite — единый релиз

**Контекст:** явно зафиксировано в idea.md и перенесено в документацию.

**Суть:** все фичи прозрачности и контроля (Debug my prompt, Context window visualizer, Diff preview, Agent pre-flight plan и др.) выходят **единым релизом в Фазе 2** с единым landing page. По отдельности каждая выглядит как мелкая утилита — вместе они дифференциатор.

**Применение:** не разбивать T&C Suite на отдельные релизы.

---

## [договорённость] Diff confidence score и LLM-as-judge — независимые индикаторы

**Контекст:** риск #69 из idea.md.

**Суть:** confidence score — эвристический бейдж (ключевые слова: auth, password, delete → 🔴). LLM-as-judge — отдельный advisory бейдж. Judge НЕ может повысить confidence score до 🟢. 🔴 confidence блокирует Auto режим независимо от judge. В UI два отдельных независимых индикатора.

**Применение:** при реализации diff review UI в Фазе 2.

---

## [правило] Дрифт инструментов персистентного плана: классы + автопилот + чип резюма (2026-07-06)

**Контекст:** план-гард сравнивал вызванный тул со `step.tools` по имени (exact/substring) и паузил план на КАЖДОМ шаге, где планировщик написал синоним (`edit_file` в плане против `rewrite_file` в исполнении, `run_terminal_command` против `run_command`) — даже под автопилотом; пользователь листал вверх к карточке и жал «Возобновить» на каждом шаге (репорт с дог-фудинга 2026-07-06).

**Суть (три слоя фикса):**
- **Классовая эквивалентность** — pure `common/planToolDrift.ts` (+тесты): класс тула из `approvalTypeOfBuiltinToolName` (edits/terminal; read — всё остальное builtin), для свободных имён планировщика — эвристика по подстрокам (порядок важен: terminal-глаголы раньше edits). Классовый матч — ТОЛЬКО для builtin-тулов; MCP по-прежнему только по явному имени (их side effects внешние).
- **Режимы паузы** — `vibeide.plans.toolDriftPause`: `always` / `manual-only` (дефолт: под автопилотом продолжать с инфо-уведомлением и записью в activity-log) / `never`. Гейт в `_pauseRunningPlanStepForToolDrift` (покрывает оба call-site гарда).
- **Чип у инпута** — `CommandBarInChat` (SidebarChat.tsx): при paused-шаге в текущем треде — «⏸ План на паузе — возобновить» (`resumeAgentExecution`, без скролла) + «↑» к карточке (`virtuoso.scrollToIndex` по индексу PlanMessage; индексы chatItems выровнены с messages — сообщения пушатся первыми по одному).
- **Профилактика у источника:** промпт генерации плана (`planPrompt` в chatThreadService) теперь перечисляет канонические имена тулов и явно запрещает выдуманные (`write_file`, `run_terminal_command`) — та же болезнь имён, что была в whitelist'ах ролей (см. plansAndAgents.md, Phase 3b).

**Применение:** любые новые сравнения «планируемый тул ↔ фактический» вести через `toolMatchesPlanHints`/`resolveToolClass`, а не по именам; при добавлении тулов сверять имена с `builtinToolDefs`.
