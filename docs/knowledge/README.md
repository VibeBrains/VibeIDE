# Knowledge Base — VibeIDE

> Инсайты которые дорого стоят при повторном выяснении.

База знаний разложена по доменам. Каждый файл — связанная тематическая группа из 4–12 записей формата **Контекст / Суть / Применение**.

---

## Базовые принципы

1. **Документация проекта** живёт в `docs/v1/` (33 файла по модулям) + `docs/roadmap.md` (чеклист с фазами) + `docs/idea.md` (исходный документ идеи). См. [architecture/doc-structure.md](architecture/doc-structure.md).
2. **Roadmap.md** — единственный источник истины по тому, «что уже сделано». Любая новая сессия начинается с его чтения.
3. **Кодовая база** — форк CortexIDE → форк VS Code. Префикс модуля и команд — `vibeide.*`. См. AGENTS.md в корне репо.
4. **Локализация UI**: ВСЕ пользовательские тексты — на русском, сразу в исходнике; исключения (ByteString, идентификаторы, бренды) — в [i18n/russian-first.md](i18n/russian-first.md).
5. **CSS React-чата** проходит через `scope-tailwind` — это источник большей части визуальных багов. См. [ui/scope-tailwind.md](ui/scope-tailwind.md).

---

## Индекс по разделам

### [architecture/](architecture/) — архитектурные решения

| Файл | О чём |
|---|---|
| [chat-pane.md](architecture/chat-pane.md) | Две поверхности чата, `VibeChatEditorPane`, multi-chat tabs, lockdown, session restore |
| [plans-and-agents.md](architecture/plans-and-agents.md) | Persisted plans, lease, JSONL journal, dashboard, subagents, background agent, stall watchdog, project rules, agent skills |
| [llm-and-context.md](architecture/llm-and-context.md) | LLM-провайдеры, remote catalog, OpenCode Zen vs Go vs OpenRouter, context filter, `@diagram` |
| [ai-sdk-migration-wip.md](architecture/ai-sdk-migration-wip.md) | **НЕЗАВЕРШЕНО.** Миграция провайдеров с нативных SDK на Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`). 14 провайдеров мигрировано, рантайм-тест не пройден, anthropic/gemini/local ещё не тронуты. |
| [api-protocol-routing.md](architecture/api-protocol-routing.md) | `API_PROTOCOL_VALUES` const-as-source-of-truth, three-tier SDK routing (user override → models.dev → fallback), `ModelOverrides.apiProtocol` field, adapter quirks (anthropic-beta headers, Google functionDeclarations), checklist на добавление нового SDK |
| [tool-calling.md](architecture/tool-calling.md) | Каналы доставки тулов модели (AI SDK / Anthropic / Gemini / OpenAI native / XML fallback), `specialToolFormat`, правило одного канала, MCP-префикс `<server>_<tool>`, `experimental_repairToolCall`, alias-таблица, `modelFamily` infra |
| [orphan-services.md](architecture/orphan-services.md) | L.1 «orphan» сервисы — persona, gitAutoStash, riskScoring, nlShell, perfGuardrails, memories, telemetry |
| [project-commands.md](architecture/project-commands.md) | Project Commands runtime (`.vibe/commands.json`): service-as-singleton + contribution-as-orchestrator, FNV-1a trust hash, two-shape resolver, gate order, KeybindingsRegistry disposable, MutableDisposable status-bar, WORKSPACE-scope onboarding, periodic janitor |
| [settings-namespaces.md](architecture/settings-namespaces.md) | Что такое `vibeide.*` vs `chat.*` в TOC native Settings, как добавить новый ключ, как работает coverage CI |
| [doc-structure.md](architecture/doc-structure.md) | Структура документации проекта |
| [two-patches-folders.md](architecture/two-patches-folders.md) | `patches-node-modules/` vs `patches-vscode-source/` |
| [model-quirks.md](architecture/model-quirks.md) | Catalog-driven per-model quirks (temperature/topP/topK/reasoning/tool-format) — `resources/model-quirks.json` + CDN refresh |
| [xml-tool-normalization.md](architecture/xml-tool-normalization.md) | XML tool-call pipeline (Layer 1 normalize / Layer 2 parser / Layer 3 safety net), DSML/self-closing/malformed-close coverage |
| [xml-tool-format-matrix.md](architecture/xml-tool-format-matrix.md) | Living matrix: vendor × provider × format × coverage layer × test fixture |
| [context-report.md](architecture/context-report.md) | Команда `vibeide.context.status` (аналог `/context`): `buildContextBreakdown` считает состав промпта по живым геттерам, шкала из context-guard, история — остаток; рендер в untitled-md |
| [commands-palette-modal.md](architecture/commands-palette-modal.md) | «VibeIDE Команды» — resizable-окно списка всех `vibe*`-команд (brain-меню). Бридж-сервис + ленивый портал, почему не `VibeModalService`, новая tsup-точка + ручной `.d.ts`, `@@`-className-футган |
| [vibe-defaults.md](architecture/vibe-defaults.md) | `.vibe-defaults/` → генерируемый манифест (перечитывается с нуля каждую сборку) → `applyVibeDefaults` сеет в `.vibe/` (create-if-missing). Команда `vibeide.defaults.apply`, общий `collectVibeideCommands`, word wrap ON по умолчанию |
| [dynamic-providers.md](architecture/dynamic-providers.md) | `.vibe/providers.json` (JSONC) — user-defined провайдеры/модели без пересборки. **WIP:** Фаза 1 (формат + IntelliSense + диагностика + тоглы built-in) готова; 2b-2 (overlay в `settingsOfProvider` → список+caps+транспорт) с `_storeState`-риском — план внутри |
| [provider-diagnostics.md](architecture/provider-diagnostics.md) | «Проверка провайдеров» — модалка диагностики (brain-меню), послойные проверки L1–L5, **корень бага «токены не уходят до перезапуска»** (стейл-кэш SDK-клиентов в electron-main), кнопка сброса клиентов, диаг-логи, MD-экспорт |

### [ui/](ui/) — CSS, темы, view-инфраструктура

| Файл | О чём |
|---|---|
| [css-pipeline.md](ui/css-pipeline.md) | `vibeide.css`, `styles.css`, build flow, CSS MIME в dev |
| [scope-tailwind.md](ui/scope-tailwind.md) | `@@`-escape, классы в константах, `.vibe-scope *` preflight, ID с точками, popup borders, quick pick |
| [vibe-modal.md](ui/vibe-modal.md) | IVibeModalService: архитектура, `@@`-рассинхрон (инлайн vs переменная), blocking/non-blocking, размер+ресайз |
| [themes-and-chat.md](ui/themes-and-chat.md) | Vibe Neon, theme tokens, theming чат-панели, fullscreen modes, secondary sidebar border |
| [view-title-bar.md](ui/view-title-bar.md) | ViewPaneContainer, дубли иконок, single-row aux bar |
| [projects-pane.md](ui/projects-pane.md) | Vibe Projects native pane, decorations через ResourceLabel, FontAwesome escape |

### [chat-ux/](chat-ux/) — поведение чата

| Файл | О чём |
|---|---|
| [modes-and-policies.md](chat-ux/modes-and-policies.md) | Normal/Plan/Agent, autopilot vs auto-approve, pre-flight, Trust Score, T&C Suite, confidence vs LLM-judge |
| [attachments.md](chat-ux/attachments.md) | Paste файлов, vision-capability gate (двойной), скрытый dead-code |
| [chat-interrupt-and-inject.md](chat-ux/chat-interrupt-and-inject.md) | Дубль `tool_call id` после abort mid-tool-call (HTTP 400) — дедуп в `prepareMessages_openai_tools`; дизайн «подмешать контекст к следующему хопу» без прерывания |
| [shortcuts.md](chat-ux/shortcuts.md) | `Ctrl+Alt+I`, отвязка `workbench.action.chat.open`, скрытие builtin chat |
| [auto-repair-loop.md](chat-ux/auto-repair-loop.md) | Repair loop, DMS exclusions, pre-flight vs task decomposition |
| [model-stalls.md](chat-ux/model-stalls.md) | Журнал обрывов/зависаний LLM-ассистента: триггерные слова, шаблон инцидента, гипотезы, митигации |
| [stuck-chat-recovery.md](chat-ux/stuck-chat-recovery.md) | Stuck-chat recovery — три слоя защиты (abortRunning hard-timeout, stuck-state detection, submit-watchdog forceReset), `forceResetChatState` API, `recoverable` UI variants, Command Palette twins |
| [circuit-breakers.md](chat-ux/circuit-breakers.md) | Circuit breakers для repetitive failures: tool-invalid-params (Stage C) и empty-response (Stage K), no-hardcoded-names rule, reset semantics, anti-patterns (no auto-switch, no adaptive thresholds) |

### [vibe-dotfolder/](vibe-dotfolder/) — `.vibe/` config

| Файл | О чём |
|---|---|
| [template-and-rules.md](vibe-dotfolder/template-and-rules.md) | `vibeConfigInitService`, README, GUIDELINES + `VIBE_DOTVIBE_AGENT_PLAYBOOK` |
| [workspace-forms.md](vibe-dotfolder/workspace-forms.md) | Форма Workspace в настройках + рантайм корневых JSON |
| [settings-stack.md](vibe-dotfolder/settings-stack.md) | Приоритетный стек, `constraints.json` enforcement, CortexIDE как стартовая точка |
| [rule-link-resolution.md](vibe-dotfolder/rule-link-resolution.md) | Cursor-style резолюция ссылок в правилах (`mdc:`/относительные `.md`) → пассивный блок `<referenced_files>`; рекурсия по настройке/тоглу, within-tree + секрет-санитайз, лимиты |

### [i18n/](i18n/) — локализация

| Файл | О чём |
|---|---|
| [language-pack.md](i18n/language-pack.md) | `vscode-loc` vs VSIX, встроенный core language pack, `&&` мнемоники |
| [nls-indices.md](i18n/nls-indices.md) | Плейсхолдеры `{0}`, рассинхрон `nls.messages.json`, NLS extract в dev |
| [russian-first.md](i18n/russian-first.md) | Правило: все user-facing тексты на русском сразу в исходнике; список исключений (ByteString/Latin-1, идентификаторы, бренды) |
| [react-and-settings.md](i18n/react-and-settings.md) | `vibeSettingsRu.ts`, перевод настроек напрямую (без bundle), правило для будущих PR |

### [build/](build/) — сборка и dev

| Файл | О чём |
|---|---|
| [windows-toolchain.md](build/windows-toolchain.md) | VS C++ Build Tools, MSB8040 Spectre, native modules, `@vscode/vsce-sign` |
| [portable-and-electron.md](build/portable-and-electron.md) | Portable Windows ZIP, Electron mirror, Linux CI X11 |
| [compile-and-sync.md](build/compile-and-sync.md) | `tsgo` exit 2, sync без общего предка, `run-dev` / `vibe-dev` runner |
| [update-service.md](build/update-service.md) | GitHub releases + `IUpdateService`, semver сравнение |
| [vibe-keybindings.md](build/vibe-keybindings.md) | Встроенный IntelliJ-keymap `extensions/vibe-keybindings/`; модель владения keymap + история |
| [third-party-licensing.md](build/third-party-licensing.md) | Провенанс-флажок ДО сборки/релиза: сторонний код = поднять лицензию явно, не доводить молча до релиза |

### [git-and-tools/](git-and-tools/) — git, скрипты, инструменты

| Файл | О чём |
|---|---|
| [git-flow.md](git-and-tools/git-flow.md) | Стандартный flow, AI co-author hook, push из Cursor shell, lockfile в `extensions/*`, формат GitHub Releases |
| [vibe-doctor.md](git-and-tools/vibe-doctor.md) | `agent-locks-stale`, `plans-folder-footprint` |
| [nightly-roadmap.md](git-and-tools/nightly-roadmap.md) | Cursor rule + skill ночного прогона |
| [bin-scripts.md](git-and-tools/bin-scripts.md) | Каталог `bin/` и `scripts/` |
| [support-discord.md](git-and-tools/support-discord.md) | Discord → roadmap |

### [runtime-quirks/](runtime-quirks/) — runtime-ловушки

| Файл | О чём |
|---|---|
| [ieditor-service.md](runtime-quirks/ieditor-service.md) | Только `IEditorService.openEditor`, не `activeGroup.openEditor` |
| [services-accessor.md](runtime-quirks/services-accessor.md) | `ServicesAccessor` инвалидируется через `await` |
| [path-and-uri.md](runtime-quirks/path-and-uri.md) | `validateURI` на Windows, UTF-8 BOM в settings |
| [language-server-esm.md](runtime-quirks/language-server-esm.md) | HTML/CSS LS — ESM-клиент и CJS-бандл |
| [idle-memory.md](runtime-quirks/idle-memory.md) | Ночной OOM / блок других Electron-приложений / Idle Watchdog инструмент диагностики |
| [watchdog-commands.md](runtime-quirks/watchdog-commands.md) | Idle Watchdog: Command Palette entries, всех 18 settings keys, on-disk artefact layout, .jsonl schema v=1 |
| [xml-tool-format-incidents.md](runtime-quirks/xml-tool-format-incidents.md) | Chronological catalog of observed XML tool-call format incidents (model / format / fix commit / regression test) |
| [provider-quota-429.md](runtime-quirks/provider-quota-429.md) | Квотные 429 (retry-after в днях) vs burst-троттлинг: fail-fast в customFetch, отдельное семейство переводчика ошибок |
| [anthropic-shape-tool-history.md](runtime-quirks/anthropic-shape-tool-history.md) | Инцидент: tool_use/tool_result Anthropic-формы выбрасывались AI SDK адаптером → модель не видела результаты и реплеила вызовы; диагностика через прирост `in:` |
| [auto-downgrade-pipeline.md](runtime-quirks/auto-downgrade-pipeline.md) | Тройной инцидент авто-даунгрейда в XML: run-local guard, потеря undefined на IPC/диске (→ null-sentinel), recovery стирал свежие override'ы (→ age-guard) |

### [roadmap/](roadmap/) — run logs (long sessions)

| Файл | О чём |
|---|---|
| [runs.md](roadmap/runs.md) | Run logs ночных roadmap-max сессий |
| [token-economy.md](roadmap/token-economy.md) | Токен-экономия: cache-friendly prompt assembly, конденсер вывода терминала, auxiliary-модель для служебных вызовов |

### [assets/](assets/) — лого, иконки, онбординг

| Файл | О чём |
|---|---|
| [logo.md](assets/logo.md) | Создание лого, AI промпт, алгоритм вписывания в круг |
| [welcome-onboarding.md](assets/welcome-onboarding.md) | Welcome-онбординг, `vibeide-main.png` |

### [patterns/](patterns/) — кросс-доменные паттерны и footguns

| Файл | О чём |
|---|---|
| [lessons-from-roadmap-max-runs.md](patterns/lessons-from-roadmap-max-runs.md) | Pure-helper + DI wrapper, discriminated-union FSM, tagged-result envelopes, twin-shape redactor, JSDoc `*/`-footgun, ReadonlyArray push/sort, OAuth state-CSRF-first, HMAC + decoder pairing, sticky-comment CI |
| [settings-registration-sweep.md](patterns/settings-registration-sweep.md) | Phantom config keys, in-service vs centralised registration, standalone xxxConfiguration.ts, localize() for descriptions, ConfigurationScope choice, minimum/maximum clamp, code-review smell |
| [main-renderer-config-bridge.md](patterns/main-renderer-config-bridge.md) | Pattern для прокидывания renderer-side settings в electron-main process через IPC + `process.env` indirection. Когда использовать, когда нет, alternative с direct IPC channel при росте |
| [verify-before-hypothesizing.md](patterns/verify-before-hypothesizing.md) | **[правило]** Если симптом измерим — измерь (терминал/инструментация) ПЕРЕД гипотезой. Канон: get_dir_tree-тормоза (3 неверных гипотезы → 1 `Get-ChildItem` = 25мс → корень). Гипотезу без замера в roadmap помечать гипотезой, не причиной |
| [unit-test-runner-footguns.md](patterns/unit-test-runner-footguns.md) | `import from 'mocha'` убивает весь test.bat-прогон (использовать глобалы), test.bat гоняет `out/` (нужен `transpile-client`), псевдотесты с инлайн-копией логики вместо импорта продукта |
| [command-title-category.md](patterns/command-title-category.md) | Палитра склеивает `{category}: {title}` буквально → двойной «VibeIDE: VibeIDE: …». С `category` префикс в title не дублировать; без `category` — префикс «VibeIDE:» в title нормален |

### [agent-collaboration/](agent-collaboration/) — правила работы агента с автором

| Файл | О чём |
|---|---|
| [workflow.md](agent-collaboration/workflow.md) | Меньше mid-task confirmations, batch autonomous execution на explicit-разрешение, логирование model stalls |
| [release-protocol.md](agent-collaboration/release-protocol.md) | `release-windows.ps1 -Version` для минор/мажор, post-release sync README + pre-clean archive, About-диалог, gh account routing, donation phrase choice |
| [permissions-and-hooks.md](agent-collaboration/permissions-and-hooks.md) | Marker-gated permissions для write-tools / destructive Bash, не flat global allow |
| [xml-normalize-audit-checklist.md](agent-collaboration/xml-normalize-audit-checklist.md) | Pre-merge gate для XML normalize transform'ов (8 пунктов: escape / idempotency / null guard / structural assertions / symmetric defense / streaming partial / verbatim fixture) |
| [why-models-ignore-injected-rules.md](agent-collaboration/why-models-ignore-injected-rules.md) | Модель игнорит правила из-за framing, не отсутствия загрузки: `[Source: path]` читается как справка, нужна binding-обёртка (образец — `session_goals`). Авто-вызов завершения за модель = антипаттерн. Project-intent — прозой в `.vibe/rules.md`, не schema |

### [security/](security/) — безопасность конфигов и рантайма

| Файл | О чём |
|---|---|
| [config-guard.md](security/config-guard.md) | Config Guard — статический скан `.vibe/providers.json` и `mcp.json` при загрузке (12 правил из AgentShield под поверхность VibeIDE): non-https/raw-IP endpoint, хардкод секретов, `curl\|sh`/`npx -y`/`--no-sandbox` в MCP. Чистый `vibeConfigGuard.ts`, `vibeide.configGuard.*` (warn/block), команда `vibeide.configGuard.showFindings`. Что НЕ дублирует: secretDetection + promptGuard |

---

## Конвенции записей

- **Тег категории** в заголовке (`[архитектура]`, `[баг]`, `[vscode]`, `[ux]`, `[foot-gun]`, …) — сохраняется из исходника.
- Тело: блок **Контекст** / **Суть** / **Применение**. Опционально — **Antipatterns**, **Доп.**, **Устарело**.
- Ссылки на файлы кода — относительно репо: `[file](../../src/vs/...)`, либо markdown-link с номером строки `[file:42](../../src/.../file.ts#L42)`.

## Переход со старого `docs/knowledge.md`

Старый плоский файл (1267 строк, ~80 записей) был разбит на эту структуру 2026-05-09. Если какая-то запись осталась снаружи — добавлять в подходящий тематический файл, не плодить новые верхнеуровневые директории без необходимости.
