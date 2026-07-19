# Разбор внешних сервисов → паритет с VibeIDE (рабочий лог)

← [Knowledge Index](../README.md)

> **Зачем.** Владелец присылает ссылки на сервисы, мы разбираем «что взять». Частый итог — «у нас это уже есть, просто нигде не сопоставлено с известным пользователю названием». Человек, знающий сервис X, проходит мимо нашей фичи, потому что не узнаёт её. Поэтому каждый разбор фиксируем здесь (внутренний лог: паритет + лицензия + что реально ново), а **пользовательскую проекцию** — в [`references/v1/vibeide-vs-alternatives.md`](../../../references/v1/vibeide-vs-alternatives.md) (её показывает `vibeAlternativesComparisonContribution`, встроенный фолбэк `COMPARISON_CONTENT` держать в синхроне).

---

## [правило] Как разбираем присланную ссылку на сервис

**Контекст:** повторяющийся запрос владельца — оценить сервис по рамке «что взять Клоду (мой процесс) / что взять Вайбу (продукт)».

**Суть — алгоритм:**
1. Fetch + описание: что делает, механизмы, **лицензия** (copyleft-заражение = дисквалификатор заимствования кода; см. PCLink/AGPL ниже).
2. Проверить фактом (grep по `src/vs/workbench/contrib/vibeide/`), что из механизмов **уже есть** — не верить памяти.
3. Разнести: (а) уже есть → маппинг «их название → наш сервис»; (б) реально ново и нужно → roadmap-пункт; (в) не наша ниша → назвать почему.
4. **Зафиксировать здесь** (лог) + при наличии пользовательской ценности — строкой в `vibeide-vs-alternatives.md`.

**Применение:** не плодить roadmap/knowledge-записи там, где полный паритет — дублировали бы описание своих же фич. Ценность разбора паритетного сервиса — именно в **пользовательской проекции** («знаешь X? у нас это Y»), а не в новом плане.

---

## [архитектура] Managed-agent платформы: Multica, Paperclip — паритет с Vibe Agents

**Контекст:** разбор 2026-07-19 (Multica `github.com/multica-ai/multica`, Paperclip `paperclip.ing`). Обе — оркестрация команд AI-агентов «как компанией/командой». Проверено грепом по нашему коду.

**Суть — их фича → наш эквивалент:**

| Механизм (Multica / Paperclip) | Наш эквивалент | Файл |
|---|---|---|
| Squads (лидер роутит работу) / оргчарт-роли | subagents + оркестратор + vision-роутинг ролей + personas | `vibeSubagentRunnerService`, `vibePersonasPaletteContribution` |
| Reusable Skills в реестре + семантический поиск (pgvector) | Agent Skills + Community Skills marketplace + локальные эмбеддинги | `vibeSkillsLibraryService`, `vibeSemanticSearchService`, `repoIndexerService` |
| Autopilots (расписание → авто-issue: стендапы, аудиты) | background agent + nightly-roadmap skill | roadmap «Agent Skills», `roadmap-autopilot/SKILL.md` |
| Тикеты + append-only аудит tool-calls | persisted plans + JSONL-журнал плана + audit log | `.vibe/plans/*.plan.md`, dashboard |
| Бюджет + авто-пауза | токен-бюджет посессионный + Dead Man's Switch + статус-бар стоимости | `vibeTokenBudgetService`, `VibeDeadMansSwitchService` |
| Governance (пауза/терминация/override, одобрение) | plan-кнопки, lease, `.vibe/constraints.json` | — |
| Goal alignment (цели/миссия) | `session_goals`, `<project_rules>` | `convertToLLMMessageService` |
| Agent-agnostic адаптеры | мульти-провайдер BYOK (Claude/OpenAI/Gemini/…) через AI SDK | — |

**Что реально РАЗНОЕ (не наше по дизайну):** Multica **не имеет своего агента** — дирижирует внешними CLI (Claude Code, Cursor Agent, Codex…) через локальный демон с авто-детектом PATH. У нас агент **встроен в IDE** — противоположное позиционирование, не заимствуем.

**Что реально НОВО (единственный кандидат):** Paperclip — **денежный** per-agent бюджет ($/месяц) с авто-паузой. У нас бюджет **токенный/посессионный**. Ценность — только под сценарий фоновых агентов, жгущих деньги без присмотра; для локальной IDE под вопросом. Зафиксировано ремаркой к `vibeTokenBudgetService` в roadmap. Лицензии обе пермиссивные (Multica permissive, Paperclip MIT) → код изучаем.

**Применение:** в roadmap Multica уже была строкой-конкурентом; ничего сверх ремарки Paperclip не заводить. Пользовательская проекция — секция «Managed-agent платформы» в `vibeide-vs-alternatives.md`.

---

## [правило] PCLink (remote-control) — AGPL дисквалифицирует заимствование кода

**Контекст:** разбор 2026-07-19 (`github.com/BYTEDz/PCLink`) — удалённое управление ПК с телефона (FastAPI + Android, QR-пейринг, скринкаст, терминал).

**Суть:** категория «remote desktop», не наша (мы IDE, не пульт для всей ОС). Единственный полезный вектор — **модель доверия телефон-канала** (QR-пейринг + ручное одобрение устройства + session-токены), и он смыкается с уже записанным пунктом roadmap «Батч-менеджер правок (правки с телефона)». **Лицензия AGPL-3.0** — заражает весь проект; брать можно **только паттерн, не код** (MIT-форк VS Code несовместим с AGPL).

**Применение:** при любой мысли «взять кусок из PCLink» — стоп, только идея/паттерн. Ремарка добавлена к пункту «Батч-менеджер правок» в roadmap.

**Связано:** [[../architecture/plansAndAgents.md]] · [[../gitAndTools/aiGitFeatures.md]].
