# Knowledge Base — VibeIDE

> Инсайты которые дорого стоят при повторном выяснении.

База знаний разложена по доменам. Каждый файл — связанная тематическая группа из 4–12 записей формата **Контекст / Суть / Применение**.

---

## Базовые принципы

1. **Документация проекта** живёт в `docs/v1/` (33 файла по модулям) + `docs/roadmap.md` (чеклист с фазами) + `docs/idea.md` (исходный документ идеи). См. [architecture/docStructure.md](architecture/docStructure.md).
2. **Roadmap.md** — единственный источник истины по тому, «что уже сделано». Любая новая сессия начинается с его чтения.
3. **Кодовая база** — форк CortexIDE → форк VS Code. Префикс модуля и команд — `vibeide.*`. См. AGENTS.md в корне репо.
4. **Локализация UI**: ВСЕ пользовательские тексты — на русском, сразу в исходнике; исключения (ByteString, идентификаторы, бренды) — в [i18n/russianFirst.md](i18n/russianFirst.md).
5. **CSS React-чата** проходит через `scope-tailwind` — это источник большей части визуальных багов. См. [ui/scopeTailwind.md](ui/scopeTailwind.md).

---

## Индекс по разделам

### [architecture/](architecture/) — архитектурные решения

| Файл | О чём |
|---|---|
| [chatPane.md](architecture/chatPane.md) | Две поверхности чата, `VibeChatEditorPane`, multi-chat tabs, lockdown, session restore |
| [plansAndAgents.md](architecture/plansAndAgents.md) | Persisted plans, lease, JSONL journal, dashboard, subagents, background agent, stall watchdog, project rules, agent skills |
| [llmAndContext.md](architecture/llmAndContext.md) | LLM-провайдеры, remote catalog, OpenCode Zen vs Go vs OpenRouter, context filter, `@diagram` |
| [aiSdkMigrationWip.md](architecture/aiSdkMigrationWip.md) | **НЕЗАВЕРШЕНО.** Миграция провайдеров с нативных SDK на Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`). 14 провайдеров мигрировано, рантайм-тест не пройден, anthropic/gemini/local ещё не тронуты. |
| [apiProtocolRouting.md](architecture/apiProtocolRouting.md) | `API_PROTOCOL_VALUES` const-as-source-of-truth, three-tier SDK routing (user override → models.dev → fallback), `ModelOverrides.apiProtocol` field, adapter quirks (anthropic-beta headers, Google functionDeclarations), checklist на добавление нового SDK |
| [toolCalling.md](architecture/toolCalling.md) | Каналы доставки тулов модели (AI SDK / Anthropic / Gemini / OpenAI native / XML fallback), `specialToolFormat`, правило одного канала, MCP-префикс `<server>_<tool>`, `experimental_repairToolCall`, alias-таблица, `modelFamily` infra |
| [orphanServices.md](architecture/orphanServices.md) | L.1 «orphan» сервисы — persona, gitAutoStash, riskScoring, nlShell, perfGuardrails, memories, telemetry |
| [projectCommands.md](architecture/projectCommands.md) | Project Commands runtime (`.vibe/commands.json`): service-as-singleton + contribution-as-orchestrator, FNV-1a trust hash, two-shape resolver, gate order, KeybindingsRegistry disposable, MutableDisposable status-bar, WORKSPACE-scope onboarding, periodic janitor |
| [vibeServerStack.md](architecture/vibeServerStack.md) | Стек `.vibe/servers.json`: сшивка чистого ядра (`planStartOrder`/`selectWithDependencies`) с UI; оркестратор `IVibeServerStackService` (browser-контракт/electron-browser-реализация), readyCheck-раннер (гоча: `http`-проба и `pathPrepend` — в main из-за CSP/резолва PATH), два UI-потребителя (боковая панель + welcome браузера) |
| [settingsNamespaces.md](architecture/settingsNamespaces.md) | Что такое `vibeide.*` vs `chat.*` в TOC native Settings, как добавить новый ключ, как работает coverage CI |
| [docStructure.md](architecture/docStructure.md) | Структура документации проекта |
| [twoPatchesFolders.md](architecture/twoPatchesFolders.md) | `patches-node-modules/` vs `patches-vscode-source/` |
| [upstreamBoundary.md](architecture/upstreamBoundary.md) | **[правило]** Граница наш код ↔ upstream: почему upstream-файлы НЕ правим ради стиля/линта (налог на merge-конфликты при синке VS Code, нулевая продуктовая ценность, наш конфиг строже их CI). Вместо правки — исключаем из гейта (`.eslint-ignore`/`tsec.exemptions`/layers-базлайн). Как отличить наш от upstream; когда трогать МОЖНО (баг/фича/security, не стиль) |
| [modelQuirks.md](architecture/modelQuirks.md) | Catalog-driven per-model quirks (temperature/topP/topK/reasoning/tool-format) — `resources/model-quirks.json` + CDN refresh |
| [modelPricing.md](architecture/modelPricing.md) | Прайс моделей: `getModelCapabilities().cost` (USD/1M), `{0,0}`=«неизвестно»≠$0; **ловушка**: каталожный cost per-token → `modelRouter.costPerM` врёт в 1e6 раз |
| [xmlToolNormalization.md](architecture/xmlToolNormalization.md) | XML tool-call pipeline (Layer 1 normalize / Layer 2 parser / Layer 3 safety net), DSML/self-closing/malformed-close coverage |
| [xmlToolFormatMatrix.md](architecture/xmlToolFormatMatrix.md) | Living matrix: vendor × provider × format × coverage layer × test fixture |
| [contextReport.md](architecture/contextReport.md) | Команда `vibeide.context.status` (аналог `/context`): `buildContextBreakdown` считает состав промпта по живым геттерам, шкала из context-guard, история — остаток; рендер в untitled-md |
| [commandsPaletteModal.md](architecture/commandsPaletteModal.md) | «VibeIDE Команды» — resizable-окно списка всех `vibe*`-команд (brain-меню). Бридж-сервис + ленивый портал, почему не `VibeModalService`, новая tsup-точка + ручной `.d.ts`, `@@`-className-футган |
| [vibeDefaults.md](architecture/vibeDefaults.md) | `.vibe-defaults/` → генерируемый манифест (перечитывается с нуля каждую сборку) → `applyVibeDefaults` сеет в `.vibe/` (create-if-missing). Команда `vibeide.defaults.apply`, общий `collectVibeideCommands`, word wrap ON по умолчанию |
| [layerSplitElectronBrowser.md](architecture/layerSplitElectronBrowser.md) | **[рецепт]** Сплит desktop-only сервиса: контракт в `common/`, класс+`registerSingleton`+`IMainProcessService` в `electron-browser/`, перевязка в `workbench.desktop.main.ts` (апстримный файл — цена осознанная). **Ловушки:** `browser/` тоже запретная зона; список нарушителей грепом врёт (спрашивать чекер); регистрация «попутной» загрузкой умирает молча. **Базлайн 3 — зелёным быть не может**: все три апстримные (`nativeBrowserElementsService.ts`), **наших нарушений ноль** — счётчик выше 3 значит новое нарушение в правке. Смоук: реестр живого рантайма через CDP + доказательство сквозь IPC |
| [inheritedPrototypes.md](architecture/inheritedPrototypes.md) | Три вектора, спасённые из мёртвого кода базы форка перед удалением (7 файлов из `Initial import`, `registerSingleton` не выполнялся никогда): **роутер, обучающийся на телеметрии** (поправки поверх правил + явный abstain), **pre-apply verification по SHA-256** (`FileBaseSignature` + `isDirty`: буфер vs диск), **сбор quick-fix'ов IDE** вместо токенов LLM в repair-loop |
| [dynamicProviders.md](architecture/dynamicProviders.md) | `providers.json` (JSONC) — user-defined провайдеры/модели без пересборки. **Волна «равные права» 2026-07-22:** `ProviderId` вместо compile-time `ProviderName` во всех API, глобальный `~/.vibe/providers.json` (workspace перекрывает, `mergeProvidersLists`), кэш смерженного набора, конфиг-провайдеры в авто-выборе ПЕРВЫМИ, OS-env ключ гейтит модели, `protocol` файла управляет SDK. **Три аудита:** реестр 9 закрытых дефектов + канонический список легитимных различий + урок «выборочный греп не доказывает отсутствие — только исчерпывающий поштучный проход». Гоча split-brain: derived-сиды в блоб не персистить. История Фаз 1/2b — внутри |
| [mcpSpec20260728.md](architecture/mcpSpec20260728.md) | Ревизия MCP **2026-07-28**: stateless-протокол (`Mcp-Session-Id` удалён), заголовки `Mcp-Method`/`Mcp-Name`, OAuth по **RFC 9207**, deprecated Roots/Sampling/Logging (≥12 мес). Что внедрили (валидация `iss`, Sampling «не развивать»). **Ревизия 23.07 — два тезиса первой редакции опровергнуты фактом:** DCR у нас ЕСТЬ (`oauth.ts:857`), сессии ЕСТЬ по обе стороны, включая наш собственный gateway. Плюс `server/discover`, multi round-trip, Apps/Tasks как расширения (Apps уже реализованы), почему пул соединений — не задача. Плюс модельный ландшафт 22.07: DeepSeek V4 (text-only, старые id гаснут 24.07), GPT-5.6 Sol/Terra/Luna (ловушка алиаса), Kimi K3 (`effort` дословно + preserved-thinking-history → `mirrorReasoningContent`). **Пересверка 24.07 и опровержение 25.07:** «гэп OAuth Resource Indicators (RFC 8707) + `application_type`» **оказался ложным** — `resource` шлётся в authorize/device/token живого апстрим-пути, `application_type: 'native'` в DCR есть; смотрели в `vibeMCPOAuthService.ts`, который **не на живом пути** (флоу-методы не вызываются ниоткуда, код из «Initial import»). Урок: проверять не только наличие параметра в файле, но и вызывается ли файл. Развилка по нашей политике ротации MCP-токенов — в roadmap. K3 — три уровня effort по первоисточнику (расхождение с фиксом 23.07), mirror подтверждён докой |
| [providerApiKeyFromEnv.md](architecture/providerApiKeyFromEnv.md) | Ключ провайдера из окружения ОС (`ANTHROPIC_API_KEY` и др.): **почему одного резолва в electron-main мало** — `_didFillInProviderSettings` гейтит UI в renderer, поэтому пробрасывается ФАКТ наличия (значение не покидает main); правило «в карту только провайдеры, где `apiKey` — единственное поле». Плюс **разбор подписочного OAuth Anthropic**: Bearer работает, но API требует дословную преамбулу Claude Code в system и маскирует отказ под `429` — путь закрыт ToS, не реализовывать |
| [providerDiagnostics.md](architecture/providerDiagnostics.md) | «Проверка провайдеров» — модалка диагностики (brain-меню), послойные проверки L1–L5, **корень бага «токены не уходят до перезапуска»** (стейл-кэш SDK-клиентов в electron-main), кнопка сброса клиентов, диаг-логи, MD-экспорт |
| [vibeServerPreviewCookies.md](architecture/vibeServerPreviewCookies.md) | Cookie-авторизация в превью: перезапись Set-Cookie → `SameSite=None; Secure` для зарегистрированных loopback-origin'ов; **гоча: один `onHeadersReceived` на сессию** — вызов встроен в апстрим-хендлер `app.ts` |
| [previewInspectElement.md](architecture/previewInspectElement.md) | Inspect-режим превью (клик → селектор в чат): труба postMessage `__vibeBrowser` вместо одностороннего WS, cross-origin пускает селектор но не скриншот (блокер VS.6), window-capture бьёт document-capture, селектор — кандидат не истина, только static-runtime, `CSS.escape` для Tailwind-классов |

### [ui/](ui/) — CSS, темы, view-инфраструктура

| Файл | О чём |
|---|---|
| [cssPipeline.md](ui/cssPipeline.md) | `vibeide.css`, `styles.css`, build flow, CSS MIME в dev |
| [scopeTailwind.md](ui/scopeTailwind.md) | `@@`-escape, классы в константах (и в цвет-хелперах → SVG `stroke: none`), `.vibe-scope *` preflight, ID с точками, popup borders, quick pick |
| [vibeModal.md](ui/vibeModal.md) | IVibeModalService: архитектура, `@@`-рассинхрон (инлайн vs переменная), blocking/non-blocking, размер+ресайз |
| [themesAndChat.md](ui/themesAndChat.md) | Vibe Neon, theme tokens, theming чат-панели, fullscreen modes, secondary sidebar border, гонка setState при dispatchEvent('input') |
| [viewTitleBar.md](ui/viewTitleBar.md) | ViewPaneContainer, дубли иконок, single-row aux bar |
| [projectsPane.md](ui/projectsPane.md) | Vibe Projects native pane, decorations через ResourceLabel, FontAwesome escape |
| [specsPane.md](ui/specsPane.md) | Панель «Спеки»: sidebar-view из `specs/<id>/` воркспейса; квартет файлов + correlated-watcher; паттерн добавления боковой панели; DnD из дерева в чат (`text/uri-list`, capture-фаза) + markdown-превью |
| [vibeDocsPane.md](ui/vibeDocsPane.md) | Панель «Документы»: CRUD поверх ObjectTree; скрытие расширения (раздвоенная валидация, бейдж `.mdx`); пруниг пустых папок vs «Создать папку»; инлайн-ввод (фокус на кадр позже, re-entrancy, черновик и collapse через repaint); свой буфер без связанности с `contrib/files` |
| [vibeDocsGraph.md](ui/vibeDocsGraph.md) | Граф документов: два парсера + тест паритета (скрипт бездепный); wikilinks дали +39 рёбер; резолв по уникальному basename; активный док нельзя вывести из превью-webview; canvas (подгонка на остывании, rAF не вечный, порог драга, детерминированная раскладка); палитра `charts.*`; чем врут CDP-проверки |
| [designContext.md](ui/designContext.md) | Дизайн-контекст проекта: `product.md` (стратегия) + `design.md` (визуальный мир), именованные правила как цитируемые инварианты, класс правила `floor` (не отключается) против `drift` (проект объявляет идентичностью — находка остаётся видимой с причиной), двухвьюпортный замер с физическим сужением до 390px и ловушка headless-минимума ~500px, хук на завершение хода, снятие системы со снимка живой страницы |
| [designReview.md](ui/designReview.md) | Детерминированные детекторы «сгенерированного» вида (55 признаков поверх снимка вычисленных стилей, разбиты по категориям) + словарь команд вместо «сделай красивее»; ловушки: диапазон hue промахивался мимо канонического #7C5CFF, цвет полосы считается по израсходованной доле, ожидания тестов записаны по прикидке вместо факта |
| [tokenBudgetSurfaces.md](ui/tokenBudgetSurfaces.md) | Носители расхода токенов (кружок+поповер, статус-бар, кнопка сброса) и один источник чисел; сигнал ≥80% без тоста и связка настройка↔класс↔CSS; инцидент `TokenBudgetFooter` — 7 недель мёртвого кода за ложной сноской «rendered by Sidebar.tsx», `git log -S "<Component"` как проверка рендера, `[x]` в roadmap ≠ фича в продукте |

### [chatUx/](chatUx/) — поведение чата

| Файл | О чём |
|---|---|
| [modesAndPolicies.md](chatUx/modesAndPolicies.md) | Normal/Plan/Agent, autopilot vs auto-approve, pre-flight, Trust Score, T&C Suite, confidence vs LLM-judge |
| [attachments.md](chatUx/attachments.md) | Paste файлов, vision-capability gate (двойной), скрытый dead-code |
| [chatInterruptAndInject.md](chatUx/chatInterruptAndInject.md) | Дубль `tool_call id` после abort mid-tool-call (HTTP 400) — дедуп в `prepareMessages_openai_tools`; дизайн «подмешать контекст к следующему хопу» без прерывания; **правило: живой UI-статус в треде — транзиентом, не персистентным сообщением** (инвариант `messages[length-1]`, буфер notice до idle) |
| [shortcuts.md](chatUx/shortcuts.md) | `Ctrl+Alt+I`, отвязка `workbench.action.chat.open`, скрытие builtin chat |
| [autoRepairLoop.md](chatUx/autoRepairLoop.md) | Repair loop, DMS exclusions, pre-flight vs task decomposition |
| [modelStalls.md](chatUx/modelStalls.md) | Журнал обрывов/зависаний LLM-ассистента: триггерные слова, шаблон инцидента, гипотезы, митигации |
| [stuckChatRecovery.md](chatUx/stuckChatRecovery.md) | Stuck-chat recovery — три слоя защиты (abortRunning hard-timeout, stuck-state detection, submit-watchdog forceReset), `forceResetChatState` API, `recoverable` UI variants, Command Palette twins |
| [circuitBreakers.md](chatUx/circuitBreakers.md) | Circuit breakers для repetitive failures: tool-invalid-params (Stage C) и empty-response (Stage K), no-hardcoded-names rule, reset semantics, anti-patterns (no auto-switch, no adaptive thresholds) |

### [vibeDotfolder/](vibeDotfolder/) — `.vibe/` config

| Файл | О чём |
|---|---|
| [templateAndRules.md](vibeDotfolder/templateAndRules.md) | `vibeConfigInitService`, README, GUIDELINES + `VIBE_DOTVIBE_AGENT_PLAYBOOK`; **auto-seed идёт на каждом открытии** (не «на первом»); lock примирения `.defaults.lock.json` — почему `customized` обязан молчать |
| [workspaceForms.md](vibeDotfolder/workspaceForms.md) | Форма Workspace в настройках + рантайм корневых JSON |
| [settingsStack.md](vibeDotfolder/settingsStack.md) | Приоритетный стек, `constraints.json` enforcement, CortexIDE как стартовая точка |
| [ruleLinkResolution.md](vibeDotfolder/ruleLinkResolution.md) | Cursor-style резолюция ссылок в правилах (`mdc:`/относительные `.md`) → пассивный блок `<referenced_files>`; рекурсия по настройке/тоглу, within-tree + секрет-санитайз, лимиты |
| [specFirstDefaults.md](vibeDotfolder/specFirstDefaults.md) | Spec-скиллы уже засеяны — пробел был в правиле-триггере (`spec-first.mdc`), а не в контенте; сверка со Spec Kit; анти-дубль MASTER.md; ре-ген манифеста |

### [voice/](voice/) — голосовой ввод (локальный STT)

| Файл | О чём |
|---|---|
| [localSttSherpaOnnx.md](voice/localSttSherpaOnnx.md) | Пайплайн диктовки: sherpa-onnx в utility-процессе, гибрид T-one (interim) + GigaAM v3 (финал), провайдер в апстримный `ISpeechService` (оживляет редактор/терминал), **три инварианта контракта** (sync-создание, `Error`→`Stopped`, отмена токена = жёсткая), грабли: `@loader_path` вместо DYLD, мусор старых zipformer-экспортов, GigaAM без пунктуации в sherpa, tar.bz2 → zip-зеркало `stt-models-v1` |

### [video/](video/) — просмотр видео в чате (/watch)

| Файл | О чём |
|---|---|
| [watchVideoPipeline.md](video/watchVideoPipeline.md) | Пайплайн `/watch`: yt-dlp + ffmpeg дочерними процессами из electron-main (UtilityProcess не нужен), кадры по сменам сцен с якорем `eq(n,0)` и тайм-кодами showinfo → `ChatImageAttachment[]`, STT-fallback батч-декодом GigaAM (чанки ≤28 с, одна busy-периода idle-shutdown), зеркало `video-tools-v1`; аудио-ветка без кадров (подкаст/mp3/голосовое: probe-first детект с хинтом-tie-break'ом по расширению, vision-гейт пропускается + повторяется после пайплайна при перекосе, субтитры отменяют скачивание, батч-STT offline: ru/GigaAM + en NeMo-CTC small/medium выбором `vibeide.voice.englishBatchModel`, развязано с бандлом диктовки); грабли: yt-dlp игнорирует навязанный контейнер (`%(ext)s` + глоб), ноль сцен на статичном видео, showinfo `s:WxH` в ffmpeg 6.x vs `s=WxH` в 8.x (тихие 0 кадров), `yt-dlp -U` кнопкой при протухании |

### [i18n/](i18n/) — локализация

| Файл | О чём |
|---|---|
| [languagePack.md](i18n/languagePack.md) | `vscode-loc` vs VSIX, встроенный core language pack, `&&` мнемоники |
| [nlsIndices.md](i18n/nlsIndices.md) | Плейсхолдеры `{0}`, рассинхрон `nls.messages.json`, NLS extract в dev |
| [russianFirst.md](i18n/russianFirst.md) | Правило: все user-facing тексты на русском сразу в исходнике; список исключений (ByteString/Latin-1, идентификаторы, бренды) |
| [reactAndSettings.md](i18n/reactAndSettings.md) | `vibeSettingsRu.ts`, перевод настроек напрямую (без bundle), правило для будущих PR |

### [build/](build/) — сборка и dev

| Файл | О чём |
|---|---|
| [windowsToolchain.md](build/windowsToolchain.md) | VS C++ Build Tools, MSB8040 Spectre, native modules, `@vscode/vsce-sign`, кросс-платформенная сборка Windows из тега (доливка в релиз mac) |
| [linuxToolchain.md](build/linuxToolchain.md) | `release-linux.sh`: deb/rpm/AppImage/tar.gz × x64/arm64, двухфазный флоу, Docker-кросс-сборка, cross-toolchain arm64 |
| [macosToolchain.md](build/macosToolchain.md) | `release-macos.sh`: DMG/ZIP arm64, двухфазный флоу, ad-hoc/Developer ID подпись + notarization, грабли сборки (OOM манглера, husky-бамп) и релизного флоу (расхождение origin/main → merge-не-rebase, замена авто-нот `--generate-notes` курируемыми), VERIFY-GATE целостности бандла (форкнутый воркер выпал из `.app` 1.9.0) |
| [buildFromSource.md](build/buildFromSource.md) | `home-build.*`: самосборка портатива под свою ОС одной командой, self-contained bootstrap (fnm+Node+deps) + гейт намерений |
| [portableAndElectron.md](build/portableAndElectron.md) | Portable Windows ZIP, Electron mirror, Linux CI X11 |
| [compileAndSync.md](build/compileAndSync.md) | `tsgo` exit 2, sync без общего предка, `run-dev` / `vibe-dev` runner |
| [reactBundleDeclarations.md](build/reactBundleDeclarations.md) | `.d.ts`-шимы у React-бандлов: почему `tsgo` падает на `no exported member 'mount*'` (баг детекта CJS по `__commonJS`-обёрткам, воспроизводится и локально — не OOM, как считалось) и как кодоген деклараций из `index.tsx` это чинит |
| [reactTypecheck.md](build/reactTypecheck.md) | Гейт `npm run react-typecheck`: 56 TSX-файлов не проверял никто (react исключён из `src/tsconfig.json`, `@types/react` не стоял); настройка конфига (4057 → 53 ошибки) и что улов вскрыл — 14 инструментов без заголовков и рендера, нерабочие `@recent`/тултипы, три мёртвых сломанных компонента |
| [updateService.md](build/updateService.md) | GitHub releases + `IUpdateService`, semver сравнение |
| [vibeKeybindings.md](build/vibeKeybindings.md) | Встроенный IntelliJ-keymap `extensions/vibe-keybindings/`; модель владения keymap + история |
| [thirdPartyLicensing.md](build/thirdPartyLicensing.md) | Провенанс-флажок ДО сборки/релиза: сторонний код = поднять лицензию явно, не доводить молча до релиза |

### [gitAndTools/](gitAndTools/) — git, скрипты, инструменты

| Файл | О чём |
|---|---|
| [gitFlow.md](gitAndTools/gitFlow.md) | Стандартный flow, AI co-author hook, push из Cursor shell, lockfile в `extensions/*`, формат GitHub Releases |
| [aiGitFeatures.md](gitAndTools/aiGitFeatures.md) | Инвентаризация AI вокруг git: генерация коммитов через свой LLM (готово, `MenuId.SCMInputBox`; **дубль** с Copilot-командой в `product.json`); merge-конфликты `vibeMergeConflictService` — **только Phase 1, LLM-Phase 2 брошена, потребителей ноль**; выделенных git-tools у чата нет (только shell + blame + worktree) |
| [cdpSmokeAutomation.md](gitAndTools/cdpSmokeAutomation.md) | **[рецепт]** Живой смоук dev-IDE через CDP: agent-browser (палитра — press по клавише, `type` молча теряет текст), координатные клики ВНУТРЬ webview/превью — сырой `Input.dispatchMouseEvent` на корневом таргете добивает до OOPIF любой глубины (`snapshot`/`click` agent-browser туда не видят), верификация по эффекту в главном документе, скриншот-пиксели == CSS при DPR 1 |
| [vibeDoctor.md](gitAndTools/vibeDoctor.md) | `agent-locks-stale`, `plans-folder-footprint` |
| [nightlyRoadmap.md](gitAndTools/nightlyRoadmap.md) | Cursor rule + skill ночного прогона |
| [binScripts.md](gitAndTools/binScripts.md) | Каталог `bin/` и `scripts/` |
| [supportDiscord.md](gitAndTools/supportDiscord.md) | Discord → roadmap |
| [precommitHygiene.md](gitAndTools/precommitHygiene.md) | `tsx`-раннер hygiene/eslint, фильтры Unicode/indentation для vibeide, lint-staged без eslint, `--no-verify` на больших коммитах. **+ [foot-gun]** фильтры **каскадные** (`all ⊃ eol ⊇ indentation ⊃ copyright ⊃ typescript`) — исключение в раннем фильтре снимает и все последующие проверки (`!` в copyright отключил ESLint); shebang vs заголовок на строке 0 — ложная дилемма (shebang рудимент); линт видит файл, только когда он staged |
| [docsLayout.md](gitAndTools/docsLayout.md) | Правило «всё в `docs/` — camelCase» + мануалы только в `manuals/`; рецепт массового переименования (`git mv`, якоря, антипаттерны); почему `CONTRIBUTING.md` нельзя унести (GitHub ищет в 3 путях); ловушка вшитых абсолютных URL в засеянных `.vibe`. **+ [правило]** `docs/README.md` — корень навигации: любой док достижим оттуда по ссылкам; **ASCII-дерево в код-блоке ссылок не создаёт** (из-за него 29 доков висели сиротами, а дерево успело соврать). Гейт `unreachable` строго сильнее «сирот». Release notes в репо не хранятся — источник правды GitHub Releases |

### [testing/](testing/) — тест-инфраструктура и диагностика

| Файл | О чём |
|---|---|
| [electronTestPollution.md](testing/electronTestPollution.md) | **[кейс+метод]** 34 Electron-фейла = каскад от ОДНОГО зависшего теста с непереустановленными fake timers (форк убрал workspace-recommendations toast → upstream-тест ждёт промпт вечно). Метод: изолированный прогон (зелёный изолированно + красный в полном = pollution) → бинарный поиск нарушителя через `--runGlob` → fake-timers первый подозреваемый. «Фейлы после ↑таймаута» ≠ регресс, а разоблачение долга |
| [ciCoverageSkips.md](testing/ciCoverageSkips.md) | **[реестр+долг]** Скипы/soft-гейты тестов в CI = заплатки, не решения (CI существует, чтобы гонять, а не скипать). Реестр форк-долгов: policyExport (вложенный Electron виснет→скип), screenshot-test (hediet 403→workflow_dispatch), disposable-audit (leak soft gate→continue-on-error), playwright componentFixtures (тихий test.skip если фикстура недоступна→риск всегда-зелёного). Что НЕ долг: vibeDocsGraph renderer-скип (бежит в node), react/out-исключения, upstream diagnostics/publish continue-on-error. Фикс — чинить причину, а не прятать |

### [toolSystem/](toolSystem/) — слой встроенных тулов (поверхность, которую видит LLM)

| Файл | О чём |
|---|---|
| [overview.md](toolSystem/overview.md) | Карта кода слоя (`toolsServiceTypes`, `prompts`, `toolsService`, `terminalToolService`, `toolHardening`) + зачем закаляли: одна ручка `run_command` = зависание на длинных чтениях (у shell-stdout нет ни пагинации, ни таймаута) |
| [antiShellContract.md](toolSystem/antiShellContract.md) | Что `run_command` отбивает и почему (`detectShellMisuse`): shell-формы, дублирующие штатные тулы (`Get-Content`/`cat`/`findstr`); error surface; когда расширять список |
| [readFileV2.md](toolSystem/readFileV2.md) | Line-based slicing, нумерация строк в выводе, контракт пагинации, large-file warning, стык с edit safety |
| [editSafety.md](toolSystem/editSafety.md) | Pre-flights перед мутацией: `edit_file` «must read first», `create_file_or_folder` «parent must exist»; **[баг]** тихая запись пустого файла (stale `_fileExistenceCache`, TTL 5 c, v0.21.3); **[правило]** truncation-guard `rewrite_file` (`rewriteFileTruncationMinChars`/`Ratio`) против молчаливой потери данных при обрыве вывода модели |
| [editFileIndentationAlignment.md](toolSystem/editFileIndentationAlignment.md) | Выравнивание отступа при толерантном матче `edit_file` — корень, фикс (v1.2.4), урок |
| [globAndGrep.md](toolSystem/globAndGrep.md) | Поиск на ripgrep: `glob` (по именам) vs `grep` (по содержимому); почему два тула, а не один слитый |
| [backgroundCommands.md](toolSystem/backgroundCommands.md) | `run_in_background` / `read_background_output` / `kill_background_command`: когда какой, жизненный цикл, границы; почему не делали push-уведомления |

### [runtimeQuirks/](runtimeQuirks/) — runtime-ловушки

| Файл | О чём |
|---|---|
| [ieditorService.md](runtimeQuirks/ieditorService.md) | Только `IEditorService.openEditor`, не `activeGroup.openEditor` |
| [servicesAccessor.md](runtimeQuirks/servicesAccessor.md) | `ServicesAccessor` инвалидируется через `await` |
| [pathAndUri.md](runtimeQuirks/pathAndUri.md) | `validateURI` на Windows, UTF-8 BOM в settings |
| [languageServerEsm.md](runtimeQuirks/languageServerEsm.md) | HTML/CSS LS — ESM-клиент и CJS-бандл |
| [idleMemory.md](runtimeQuirks/idleMemory.md) | Ночной OOM / блок других Electron-приложений / Idle Watchdog инструмент диагностики |
| [watchdogCommands.md](runtimeQuirks/watchdogCommands.md) | Idle Watchdog: Command Palette entries, всех 18 settings keys, on-disk artefact layout, .jsonl schema v=1 |
| [xmlToolFormatIncidents.md](runtimeQuirks/xmlToolFormatIncidents.md) | Chronological catalog of observed XML tool-call format incidents (model / format / fix commit / regression test) |
| [providerQuota429.md](runtimeQuirks/providerQuota429.md) | Квотные 429 (retry-after в днях) vs burst-троттлинг: fail-fast в customFetch, отдельное семейство переводчика ошибок |
| [anthropicShapeToolHistory.md](runtimeQuirks/anthropicShapeToolHistory.md) | Инцидент: tool_use/tool_result Anthropic-формы выбрасывались AI SDK адаптером → модель не видела результаты и реплеила вызовы; диагностика через прирост `in:` |
| [undiciBypassesProxyAndCerts.md](runtimeQuirks/undiciBypassesProxyAndCerts.md) | Голый undici/Node-fetch в electron-main минует системный прокси и CA → ложный «офлайн» на корпоративной сети; вести через IRequestService |
| [llmProxyDispatcher.md](runtimeQuirks/llmProxyDispatcher.md) | Прокси для LLM-трафика (`vibeide.llm.proxy.url`): единый undici-диспетчер как точка внедрения, HTTP/HTTPS через ProxyAgent, SOCKS вручную через пакет `socks`; почему не DPI-обход и не `http.proxy` |
| [verifyGate.md](runtimeQuirks/verifyGate.md) | VERIFY-GATE: реальный гейт сборки/тестов на `vibe_complete` (не промпт) — захват exit-кода через ITerminalToolService, чистая политика bounce/stop/warn, edit-guard, анти-цикл maxAttempts |
| [autoDowngradePipeline.md](runtimeQuirks/autoDowngradePipeline.md) | Тройной инцидент авто-даунгрейда в XML: run-local guard, потеря undefined на IPC/диске (→ null-sentinel), recovery стирал свежие override'ы (→ age-guard) |
| [openRouterFrontierModels.md](runtimeQuirks/openRouterFrontierModels.md) | LongCat-2.0 (плавающие 33–56B активных, OpenAI+Anthropic API) и Inkling (reasoning-effort 0.2–0.99 как драйвер цены) как BYOK-провайдеры; правило «один LLM ненадёжен для security-скана → ансамбль провайдеров + мерж находок» |

### [roadmap/](roadmap/) — run logs (long sessions)

| Файл | О чём |
|---|---|
| [runs.md](roadmap/runs.md) | Run logs ночных roadmap-max сессий |
| [tokenEconomy.md](roadmap/tokenEconomy.md) | Токен-экономия: cache-friendly prompt assembly, конденсер вывода терминала, auxiliary-модель для служебных вызовов |

### [assets/](assets/) — лого, иконки, онбординг

| Файл | О чём |
|---|---|
| [logo.md](assets/logo.md) | Создание лого, AI промпт, алгоритм вписывания в круг |
| [welcomeOnboarding.md](assets/welcomeOnboarding.md) | Welcome-онбординг, `vibeide-main.png` |

### [patterns/](patterns/) — кросс-доменные паттерны и footguns

| Файл | О чём |
|---|---|
| [lessonsFromRoadmapMaxRuns.md](patterns/lessonsFromRoadmapMaxRuns.md) | Pure-helper + DI wrapper, discriminated-union FSM, tagged-result envelopes, twin-shape redactor, JSDoc `*/`-footgun, ReadonlyArray push/sort, OAuth state-CSRF-first, HMAC + decoder pairing, sticky-comment CI |
| [settingsRegistrationSweep.md](patterns/settingsRegistrationSweep.md) | Phantom config keys, in-service vs centralised registration, standalone xxxConfiguration.ts, localize() for descriptions, ConfigurationScope choice, minimum/maximum clamp, code-review smell |
| [mainRendererConfigBridge.md](patterns/mainRendererConfigBridge.md) | Pattern для прокидывания renderer-side settings в electron-main process через IPC + `process.env` indirection. Когда использовать, когда нет, alternative с direct IPC channel при росте |
| [verifyBeforeHypothesizing.md](patterns/verifyBeforeHypothesizing.md) | **[правило]** Если симптом измерим — измерь (терминал/инструментация) ПЕРЕД гипотезой. Канон: get_dir_tree-тормоза (3 неверных гипотезы → 1 `Get-ChildItem` = 25мс → корень). Гипотезу без замера в roadmap помечать гипотезой, не причиной. **+ «Зелёный чек ≠ работающий чек»**: три способа соврать (не запускается / слеп к классу поломки / шапка врёт про код) + дублирующие индексы расходятся по построению |
| [unitTestRunnerFootguns.md](patterns/unitTestRunnerFootguns.md) | `import from 'mocha'` убивает весь test.bat-прогон (использовать глобалы), test.bat гоняет `out/` (нужен `transpile-client`), псевдотесты с инлайн-копией логики вместо импорта продукта |
| [agenticRewriteNeedsOracle.md](patterns/agenticRewriteNeedsOracle.md) | **[правило]** Массовый агентский рефакторинг — только при оракуле, не зависящем от переписываемого слоя. Кейс Bun (Zig→Rust, 11 дней, ≈$165k): TS-тесты как конформити-оракул, adversarial review по диффу без нарратива автора, trial run на 3 файлах. Разблокировка отложенного split `vibeide/common` |
| [commandTitleCategory.md](patterns/commandTitleCategory.md) | Палитра склеивает `{category}: {title}` буквально → двойной «VibeIDE: VibeIDE: …». С `category` префикс в title не дублировать; без `category` — префикс «VibeIDE:» в title нормален |

### [agentCollaboration/](agentCollaboration/) — правила работы агента с автором

| Файл | О чём |
|---|---|
| [workflow.md](agentCollaboration/workflow.md) | Меньше mid-task confirmations, batch autonomous execution на explicit-разрешение, логирование model stalls |
| [externalServicesParity.md](agentCollaboration/externalServicesParity.md) | Разбор присланных сервисов → паритет с VibeIDE. Алгоритм разбора; Multica/Paperclip = паритет с Vibe Agents (маппинг «их фича → наш сервис»); единственное реально новое — денежный per-agent бюджет (Paperclip); PCLink = AGPL → только паттерн. Пользовательская проекция — `docs/references-v1/vibeide-vs-alternatives.md` |
| [externalAgentToolkits.md](agentCollaboration/externalAgentToolkits.md) | Разбор open-source skill-репозиториев для агентов (граница с `externalServicesParity`: там сервисы, здесь заимствуемые механизмы). Заход 2026-07-24: claude-video (4 профиля детализации vs наши 5 ручек `vibeide.video.*`), graphify (граф проекта на tree-sitter, рёбра `EXTRACTED`/`INFERRED`/`AMBIGUOUS`, **демонстративно без векторного стора** — против нашего эмбеддингового RAG; наш граф только по `*.md`), impeccable (23 команды-словаря + 60 детекторов ai-slop без LLM; live-режим ≈ наш inspect-превью), obsidian-skills (JSON Canvas, defuddle — нет), raytsystem (сводка «Требует внимания» — **взята 2026-07-30**, вместе с ledger-моделью прогонов и fencing; см. [[agentRunLedger]]). **ponytail = полный паритет и шире** (лестница + `/simplify` + леджер `vibe-later`) — вывод «у нас нет» был опровергнут грепом, урок оформлен правилом |
| [agentGates.md](agentCollaboration/agentGates.md) | Три гейта хода (VERIFY-GATE, DESIGN-HOOK, TURN-CHECKS) построены по одной форме `режим → чистая decideX → bounce/stop`, счётчик попыток у каждого свой; проверка результата обязана быть детерминированной — `TurnCheckId` закрыт типом, чтобы LLM-судья не просочился (галлюцинирующий вердикт хуже отсутствия проверки); тесты во время `npm run compile` падают на постороннем модуле — это половинчатый `out/`, а не поломка |
| [agentRunLedger.md](agentCollaboration/agentRunLedger.md) | Журнал прогонов агентов: чужой `epoch` не доказывает смерть окна — сироту определяет молчание heartbeat (иначе второе окно объявляет живые роли брошенными); новая React-панель требует записи в `entry` у `tsup.config.js` (список явный, не glob; `src2` регенерируется из `src`); границы слоя выкинули коммит и снимок графа из отпечатка сессии, а `policyKey` — как дубль `allowedTools` |
| [releaseProtocol.md](agentCollaboration/releaseProtocol.md) | `release-windows.ps1 -Version` для минор/мажор, post-release sync README + pre-clean archive, About-диалог, gh account routing, donation phrase choice |
| [permissionsAndHooks.md](agentCollaboration/permissionsAndHooks.md) | Marker-gated permissions для write-tools / destructive Bash, не flat global allow |
| [xmlNormalizeAuditChecklist.md](agentCollaboration/xmlNormalizeAuditChecklist.md) | Pre-merge gate для XML normalize transform'ов (8 пунктов: escape / idempotency / null guard / structural assertions / symmetric defense / streaming partial / verbatim fixture) |
| [whyModelsIgnoreInjectedRules.md](agentCollaboration/whyModelsIgnoreInjectedRules.md) | Модель игнорит правила из-за framing, не отсутствия загрузки: `[Source: path]` читается как справка, нужна binding-обёртка (образец — `session_goals`). Авто-вызов завершения за модель = антипаттерн. Project-intent — прозой в `.vibe/rules.md`, не schema |
| [autoScout.md](agentCollaboration/autoScout.md) | Авто-разведчик на «продолжи»: read-only explore по правкам+плану → гейт «оно/не оно» в треде. Триггер A+C (не B), гейт-в-треде, контекст дописывается в `content` user-сообщения (конвертер не трогаем), thin-context skip, confidence-автоскип, «Уточнить»=петля |
| [visionRouting.md](agentCollaboration/visionRouting.md) | Картинка субагенту → роль на vision-модели: 5 звеньев (проброс `images` через контракт спавна, image-aware `buildRoute`, авто-vision-фолбэк, дизайнер vision-by-default, image-вход в модалке). DRY `isModelVisionCapable`; грабли бандла модалки (Tailwind только text-утилиты; `appearance:base-select` не поддержан) |

### [security/](security/) — безопасность конфигов и рантайма

| Файл | О чём |
|---|---|
| [configGuard.md](security/configGuard.md) | Config Guard — статический скан `.vibe/providers.json` и `mcp.json` при загрузке (12 правил из AgentShield под поверхность VibeIDE): non-https/raw-IP endpoint, хардкод секретов, `curl\|sh`/`npx -y`/`--no-sandbox` в MCP. Чистый `vibeConfigGuard.ts`, `vibeide.configGuard.*` (warn/block), команда `vibeide.configGuard.showFindings`. Что НЕ дублирует: secretDetection + promptGuard |

---

## Конвенции записей

- **Тег категории** в заголовке (`[архитектура]`, `[баг]`, `[vscode]`, `[ux]`, `[foot-gun]`, …) — сохраняется из исходника.
- Тело: блок **Контекст** / **Суть** / **Применение**. Опционально — **Antipatterns**, **Доп.**, **Устарело**.
- Ссылки на файлы кода — относительно репо: `[file](../../src/vs/...)`, либо markdown-link с номером строки `[file:42](../../src/.../file.ts#L42)`.

## Этот файл — единственный индекс базы

Старый плоский `docs/knowledge.md` (1267 строк, ~80 записей) разбит на эту структуру 2026-05-09; его огрызок-редирект удалён 2026-07-15 вместе с подындексом `toolSystem/README.md` — **дублирующие списки одного множества расходятся по построению** (огрызок знал 11 доменов из 14, подындекс — 5 записей из 6, `toolSystem/` не был виден отсюда 7 недель).

**Правило:** запись без строки в этой таблице не существует — её никто не найдёт. Добавил файл → добавь строку. Гейтится `npm run docs-graph-check` (dead links + членство в индексе), гоняется в CI.

Новую запись — в подходящий тематический файл; новые верхнеуровневые домены без необходимости не плодить.
