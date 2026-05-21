/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export class VibeideGlobalSettingsConfigurationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideGlobalSettingsConfiguration';

	constructor() {
		super();

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		registry.registerConfiguration({
			id: 'vibeide.skills',
			title: localize('vibeide.skills.title', 'VibeIDE — Agent Skills'),
			type: 'object',
			properties: {
				'vibeide.skills.globalPaths': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.skills.globalPaths', 'Абсолютные пути дополнительных корней SKILL.md (parity с ~/.cursor/skills/). Workspace `.vibe/skills/` перекрывает скиллы с теми же идентификаторами.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.skills.sessionActiveIds': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.skills.sessionActiveIds', 'Идентификаторы скиллов (поле `name` из frontmatter), ограниченные для GUIDELINES-выдачи в этой сессии. Пусто = все загруженные скиллы. Меняется через Command Palette: «Skills — select for session».'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.auditSkillSuggestions': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.skills.auditSkillSuggestions', 'Когда включён журнал аудита (`vibeide.audit.enable`) — записывать локальные события про использование `/skill:` и неявные keyword-подсказки скиллов (без отправки в облако).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.notifyDiskDiff': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.skills.notifyDiskDiff', 'Когда markdown-файл скилла из workspace `.vibe/skills/**` изменился на диске — показывать info-уведомление с опциональным diff к предыдущему in-memory снапшоту.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.communityCatalogUrl': {
					type: 'string',
					default: '',
					description: localize('vibeide.skills.communityCatalogUrl', 'HTTPS URL JSON-каталога сообщества скиллов (`vibe-community-skills-catalog-v1`). Используется как значение по умолчанию для «Browse community skills catalog». Пусто — вводить URL вручную.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.discoveryDescriptionMaxChars': {
					type: 'number',
					default: 600,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.discoveryDescriptionMaxChars', 'Максимум символов на описание скилла в GUIDELINES-списке (контроль токенов/контекста). 0 = без ограничений.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.implicitDescriptionMaxChars': {
					type: 'number',
					default: 400,
					minimum: 0,
					maximum: 4096,
					description: localize('vibeide.skills.implicitDescriptionMaxChars', 'Максимум символов на описание скилла в блоке неявных keyword-подсказок. 0 = без ограничений.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.skills.workspaceDiscoveryHint': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.skills.workspaceDiscoveryHint', 'Показывать info-уведомление при первом открытии workspace с непустой `.vibe/skills/` директорией, чтобы пользователь знал о доступных проектных скиллах. On-by-default; уведомление показывается один раз на workspace.'),
					scope: ConfigurationScope.RESOURCE,
				},
			},
		});

		// `vibeide.commands.*` — Project Commands settings (roadmap §K.4 L306, L322).
		// Pure helpers landed in `projectCommandsGlobalPaths.ts` (decoder + workspace-wins
		// merge) and `projectCommandsToolbar.ts` (position decoder + visibility predicate).
		// Surfacing the keys here lets users pin them via Settings UI before the runtime
		// `IVibeCustomCommandsService` lands (the helpers already handle the absent /
		// malformed cases without throwing).
		registry.registerConfiguration({
			id: 'vibeide.commands',
			title: localize('vibeide.commands.title.shared', 'VibeIDE — Project Commands'),
			type: 'object',
			properties: {
				'vibeide.commands.globalPaths': {
					type: 'array',
					items: { type: 'string' },
					default: [],
					description: localize('vibeide.commands.globalPaths', 'Абсолютные пути дополнительных корней `.vibe/commands.json` (parity с `vibeide.skills.globalPaths`). Команды из workspace `.vibe/commands.json` перекрывают глобальные с тем же `id`; конфликтующие глобальные id попадают в `shadowedGlobalIds[]` для banner-уведомления.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.commands.toolbar.position': {
					type: 'string',
					enum: ['titlebar', 'statusbar', 'hidden'],
					enumDescriptions: [
						localize('vibeide.commands.toolbar.position.titlebar', 'Закреплённые команды отображаются в title-bar (по умолчанию).'),
						localize('vibeide.commands.toolbar.position.statusbar', 'Закреплённые команды отображаются в статус-баре.'),
						localize('vibeide.commands.toolbar.position.hidden', 'Кнопки скрыты; палитра, шорткаты и индикатор «▶ N» остаются доступны.'),
					],
					default: 'titlebar',
					description: localize('vibeide.commands.toolbar.position', 'Где рендерить закреплённые команды Project Commands. `hidden` оставляет палитру / шорткаты / status-bar `▶ N` индикатор активными, но скрывает inline-кнопки.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.commands.toolbar.maxPinned': {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					default: 6,
					description: localize('vibeide.commands.toolbar.maxPinned', 'Максимальное число закреплённых команд (`pinned: true`), которые рендерятся в статус-баре. Остальные доступны через палитру `VibeIDE: Run Project Command`. Диапазон 1–20; визуально комфортный предел — 6–8.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		// `vibeide.model.*` — per-file model routing (roadmap §L928).
		registry.registerConfiguration({
			id: 'vibeide.model',
			title: localize('vibeide.model.title', 'VibeIDE — Model Routing'),
			type: 'object',
			properties: {
				'vibeide.model.routing': {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							pattern: { type: 'string' },
							modelId: { type: 'string' },
						},
						required: ['pattern', 'modelId'],
						additionalProperties: false,
					},
					default: [],
					description: localize('vibeide.model.routing', 'Упорядоченный список правил { pattern, modelId } для маршрутизации модели по пути файла. Первое совпадение побеждает; при отсутствии совпадений — модель по умолчанию. modelId: "provider/modelName" или просто "modelName" (провайдер выбирается автоматически). Пример: [{ "pattern": "**/*.md", "modelId": "anthropic/claude-haiku-4-5" }, { "pattern": "src/**/*.spec.ts", "modelId": "sonnet" }].'),
					scope: ConfigurationScope.RESOURCE,
				},
			},
		});

		// `vibeide.llm.*` — LLM provider runtime knobs that experienced users may want to tune
		// without rebuilding. Defaults are conservative and chosen for typical reasoning/streaming
		// loads; bump them if your provider takes longer to deliver the first byte (large context,
		// slow upstream behind a proxy aggregator, etc.). Values are in milliseconds.
		registry.registerConfiguration({
			id: 'vibeide.llm',
			title: localize('vibeide.llm.title', 'VibeIDE — LLM Runtime'),
			type: 'object',
			properties: {
				'vibeide.llm.timeoutMs.local': {
					type: 'integer',
					minimum: 1000,
					maximum: 600_000,
					default: 30_000,
					description: localize('vibeide.llm.timeoutMs.local', 'Таймаут запроса к локальному LLM-провайдеру (Ollama, vLLM, LM Studio, любой openAICompatible с эндпоинтом на localhost). Миллисекунды. По умолчанию 30000 — локальные модели должны отвечать быстро; долгое ожидание обычно означает, что сервис не запущен или перегружен.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.llm.timeoutMs.cloud': {
					type: 'integer',
					minimum: 1000,
					maximum: 600_000,
					default: 90_000,
					description: localize('vibeide.llm.timeoutMs.cloud', 'Таймаут запроса к прямому облачному провайдеру (OpenAI, Anthropic, Gemini, Mistral, xAI, Groq, DeepSeek, Qwen, Azure, Vertex). Миллисекунды. По умолчанию 90000 — покрывает reasoning-модели (Claude Opus thinking, GPT-5 high reasoning, etc.) при умеренном контексте.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.llm.timeoutMs.aggregator': {
					type: 'integer',
					minimum: 1000,
					maximum: 600_000,
					default: 180_000,
					description: localize('vibeide.llm.timeoutMs.aggregator', 'Таймаут запроса к провайдеру-агрегатору (OpenRouter, OpenCode Zen, OpenCode Go, LM Router, LiteLLM). Миллисекунды. По умолчанию 180000 — у агрегаторов двойной hop (клиент → агрегатор → upstream), что добавляет латентности; на больших контекстах + reasoning-моделях первый байт может приходить через 2–3 минуты.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.llm.assumeNativeTools': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.llm.assumeNativeTools', '**DEPRECATED**, используйте `vibeide.llm.toolFallbackMode` вместо. Для неизвестных моделей через OpenAI-compatible агрегаторов (OpenRouter, OpenCode Zen/Go, LM Router, LiteLLM, openAICompatible, Pollinations) — по умолчанию использовать native function-calling (`tools: [...]` в payload), а не XML-описание тулов в system prompt. On — большинство моделей корректно вызывают тулы. Off — fallback на XML-в-промпте.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.llm.toolFallbackMode': {
					type: 'string',
					enum: ['auto', 'native', 'xml'],
					enumDescriptions: [
						localize('vibeide.llm.toolFallbackMode.auto', 'Auto: использовать native function-calling по умолчанию, runtime detect / auto-downgrade переключает на XML при повторных quirk-ошибках (`numeric tool names`, missing required fields). Рекомендуется в большинстве случаев.'),
						localize('vibeide.llm.toolFallbackMode.native', 'Native: всегда форсить native function-calling для неизвестных моделей через aggregator. Игнорирует auto-detected override\'ы. Используйте если уверены, что ваша модель корректно работает с native FC, и auto-downgrade ошибочно срабатывает.'),
						localize('vibeide.llm.toolFallbackMode.xml', 'XML: всегда форсить XML-в-промпте для неизвестных моделей через aggregator. Используйте если знаете, что все ваши aggregator-модели имеют quirks с native FC (медленнее, но совместимее).'),
					],
					default: 'auto',
					description: localize('vibeide.llm.toolFallbackMode.description', 'Стратегия выбора tool-call формата для неизвестных моделей через OpenAI-compatible aggregator (OpenRouter, OpenCode Zen/Go, LM Router, LiteLLM, openAICompatible, Pollinations). **auto** — стартовать с native, авто-переключение на XML при quirk-ошибках. **native** — всегда native, игнор авто-override\'ов. **xml** — всегда XML. Известные модели (Claude/GPT/Gemini/Grok/DeepSeek/Llama/Qwen и пр.) — не затрагиваются (используют формат из каталога). Заменяет `vibeide.llm.assumeNativeTools` (deprecated: true=auto, false=xml).'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		// `vibeide.global.*` — user-wide preferences read from `vibeideSettingsService`.
		// Source of truth: VS Code configuration; the in-memory `globalSettings.localFirstAI`
		// mirrors this key via a config-change listener.
		registry.registerConfiguration({
			id: 'vibeide.global',
			title: localize('vibeide.global.title', 'VibeIDE — Глобальные'),
			type: 'object',
			properties: {
				'vibeide.global.localFirstAI': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.global.localFirstAI', 'Предпочитать локальные LLM-провайдеры (Ollama, LM Studio, vLLM) поверх облачных при routing-выборе модели. Off-by-default (cloud-first); включение разворачивает порядок: сначала локальные, при их отсутствии — облако.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		// `vibeide.chat.*` — chat-stream behavior. The hard-stall watchdog auto-aborts a
		// stuck stream so `isRunning` doesn't latch forever and block subsequent sends.
		// Lighter signals (inline banner at 15s, toasts at 30s/45s) already exist for
		// transient slow responses; this is the final fallback when a provider truly
		// hangs (e.g. aggregator drops the upstream connection silently, or rejects
		// a large payload without returning an error).
		registry.registerConfiguration({
			id: 'vibeide.chat',
			title: localize('vibeide.chat.title', 'VibeIDE — Чат'),
			type: 'object',
			properties: {
				'vibeide.chat.streamHardStallEnabled': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.chat.streamHardStallEnabled', 'Автоматически прерывать LLM-стрим, если провайдер не присылает ни одного нового токена дольше `vibeide.chat.streamHardStallSeconds` секунд. Сбрасывает `isRunning`, показывает ошибку, разблокирует кнопку отправки. Off — ждать бесконечно (старое поведение).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.streamHardStallSeconds': {
					type: 'number',
					default: 120,
					minimum: 30,
					maximum: 1800,
					description: localize('vibeide.chat.streamHardStallSeconds', 'Порог hard-stall авто-abort в секундах. Reset на каждый новый токен. По умолчанию 120 (2 минуты) — достаточно для reasoning-моделей (o1/Claude reasoning могут думать до 60s перед первым токеном) + запас на нестабильные провайдеры. Минимум 30 (≥ streamFirstTokenStallSeconds), максимум 1800 (30 минут — sanity cap).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.streamEarlyStallSeconds': {
					type: 'number',
					default: 15,
					minimum: 5,
					maximum: 120,
					description: localize('vibeide.chat.streamEarlyStallSeconds', 'Soft-signal порог — показать инлайн-баннер «AI зависает» (без тоста) когда первый токен не пришёл за указанное число секунд. Дешёвое уведомление пока пользователь ждёт. По умолчанию 15. Поднимите для медленных моделей (большие Ollama / локальные GGUF), опустите для быстрых API (Haiku 4.5).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.streamFirstTokenStallSeconds': {
					type: 'number',
					default: 30,
					minimum: 10,
					maximum: 300,
					description: localize('vibeide.chat.streamFirstTokenStallSeconds', 'Toast-уровень порог — показать предупреждение «модель ещё думает» когда первый токен не пришёл за указанное число секунд. Срабатывает один раз. По умолчанию 30. Для reasoning-моделей с длинной фазой размышления (o1, Claude reasoning) поднимите до 60+.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.streamMidStreamStallSeconds': {
					type: 'number',
					default: 45,
					minimum: 15,
					maximum: 600,
					description: localize('vibeide.chat.streamMidStreamStallSeconds', 'Toast-уровень порог — показать предупреждение «стрим завис» когда активный стрим перестал получать токены за указанное число секунд. Reset на каждом новом токене. По умолчанию 45. Не путать с `streamHardStallSeconds` (auto-abort) — это только soft notification.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.compactToolResultsAfterTurns': {
					type: 'number',
					default: 3,
					minimum: 0,
					maximum: 50,
					description: localize('vibeide.chat.compactToolResultsAfterTurns', 'Сжимать tool-results старше указанного числа user-turns (отсчёт от текущего сообщения). Старые tool-outputs заменяются на short summary с пометкой `[summarized: N tokens]`, что предотвращает линейный рост входного prompt при долгих агентских циклах (главная причина AI_RetryError у openCode/minimax-m2.7 на больших проектах). 0 — отключить сжатие; 3 — баланс между сохранением свежего контекста и контролем токенов.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.autoToolSynthesis': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.chat.autoToolSynthesis', 'Эвристика «автосинтеза tool-call» когда модель ответила текстом вместо ожидаемого инструмента. Если включено, VibeIDE подменяет ответ модели захардкоженным «I will help you with that…» / «I will search for files…» и сам выполняет synthesized tool. Полезно для слабых tool-calling моделей; для современных (Claude / GPT-4 / DeepSeek thinking) скорее мешает — реальный ответ модели теряется, цепочка диалога ломается. По умолчанию **off** после инцидента OOM от петли invalid_params в долгой сессии. Включайте только если ваша модель регулярно «забывает» вызвать tool.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.emptyResponseCircuitBreakerThreshold': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.chat.emptyResponseCircuitBreakerThreshold', 'Сколько раз подряд провайдер/модель должны вернуть «Empty response» подряд из одной (thread × provider × model)-комбинации, чтобы VibeIDE заменил стандартный toast на recoverable error с предложением сменить модель. Счётчик сбрасывается на любом успешном ответе из той же комбинации. По умолчанию 3 — баланс между «дайте модели шанс» и «не насилуйте провайдер ещё одним retry». Поднимите для нестабильных сетей, опустите до 1 для агрессивного fail-fast.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.toolInvalidParamsCircuitBreakerThreshold': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.chat.toolInvalidParamsCircuitBreakerThreshold', 'Сколько раз подряд модель должна вызвать один и тот же tool с одной и той же неверной формой параметров (`invalid_params` подряд) до того, как VibeIDE прервёт чат с явной ошибкой вместо продолжения цикла schema-hint-ов. Защищает от OOM-петель когда aggregator-проксированные модели (Nemotron/qwen/minimax через openCode-zen) застревают в неверном tool-call shape. Сравнить с `emptyResponseCircuitBreakerThreshold` — оба ловят разные классы repetitive failures. По умолчанию 3.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.maxMessagesPerThread': {
					type: 'number',
					default: 500,
					minimum: 100,
					maximum: 5000,
					description: localize('vibeide.chat.maxMessagesPerThread', 'Жёсткий потолок на количество сообщений в одном thread. При превышении старые сообщения обрезаются до `maxMessagesPerThread - 100` + вставляется маркер с подсчётом. Это **независимо** от LLM-payload truncation (smart truncation в convertToLLMMessageService) — этот лимит ограничивает JSON, который хранится в renderer-памяти и на диске, чтобы долгие агент-сессии не приводили к OOM рендерера. Поднимите для очень длинных проектов; опустите если у вас слабая машина.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.catalog.modelsDevCacheTtlHours': {
					type: 'number',
					default: 24,
					minimum: 1,
					maximum: 720,
					description: localize('vibeide.catalog.modelsDevCacheTtlHours', 'TTL для дискового кеша `models.dev` каталога в часах. В пределах TTL VibeIDE подаёт catalog мгновенно с диска и refresh-ит из сети в фоне (stale-while-revalidate). За пределами TTL fetch синхронный (~500ms на первом запросе). По умолчанию 24h — aggregator-каталог обновляется редко. Поднимите до 168 (неделя) для медленных корпоративных сетей, опустите до 1 для очень частого refresh при работе с быстро меняющимися моделями.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.cost.confirmThreshold': {
					type: 'number',
					default: 0.5,
					minimum: 0,
					maximum: 100,
					description: localize('vibeide.cost.confirmThreshold', 'Порог в USD: если forecast-нутая стоимость одного запроса превышает значение, VibeIDE показывает диалог-подтверждение перед отправкой. По умолчанию $0.50 — баланс между «не теряй фокус из-за каждой копейки» и «не получи неожиданный счёт». Поднимите для безлимитных подписок, опустите до 0 для прозрачности каждого запроса.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.cost.confirmTokenThreshold': {
					type: 'number',
					default: 50000,
					minimum: 0,
					maximum: 2000000,
					description: localize('vibeide.cost.confirmTokenThreshold', 'Порог в токенах: если prompt + ожидаемый response превышает значение, VibeIDE требует подтверждения. По умолчанию 50000 — около половины Claude 200K-окна. Защищает от случайной отправки гигантского контекста.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.cost.alwaysConfirm': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.cost.alwaysConfirm', 'Если включено — диалог-подтверждение показывается перед КАЖДЫМ запросом, независимо от `confirmThreshold`/`confirmTokenThreshold`. Используйте для аудитов, обучения, демонстраций.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.agent.maxLoopIterations': {
					type: 'number',
					default: 30,
					minimum: 0,
					maximum: 200,
					description: localize('vibeide.agent.maxLoopIterations', 'Максимум итераций tool-use loop в одном агентском прогоне. По умолчанию 30, диапазон 0–200. **0 = без лимита** (для уверенных — есть риск зацикливания и расхода токенов). Защищает от runaway-loops когда модель циклично вызывает tool с теми же параметрами.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.agent.responseLanguage': {
					type: 'string',
					default: 'auto',
					enum: ['auto', 'en', 'ru'],
					enumDescriptions: [
						localize('vibeide.agent.responseLanguage.auto', 'Авто-детект: модель отвечает на языке, который использовал пользователь.'),
						localize('vibeide.agent.responseLanguage.en', 'Принудительно английский — даже если запрос на русском.'),
						localize('vibeide.agent.responseLanguage.ru', 'Принудительно русский — даже если запрос на английском.'),
					],
					description: localize('vibeide.agent.responseLanguage', 'Язык ответов агента. По умолчанию `auto` — agent отвечает на языке пользователя. `en`/`ru` форсят язык независимо от запроса. Перекрывается per-skill настройкой `language` в SKILL.md frontmatter.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.agent.preferJsonToolArguments': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.agent.preferJsonToolArguments', 'Если включено — tool arguments в LLM-payload отправляются как **JSON-кодированные строки** (как делает старый OpenAI Functions API), вместо нативных объектов AI SDK. Используйте только при работе с моделями, которые ломаются на nested JSON в tool_use блоках (редкие quirks через aggregator-проксирование). Default off — современные модели лучше handle nested.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		// `vibeide.tools.*` — runtime behavior of built-in agent tools. Primary motivation:
		// large search-tool outputs (grep / glob / search_for_files matching hundreds of
		// files) blow up the LLM input prompt and cause aggregator-proxied models
		// (openCode/minimax-m2.7) to return empty responses → AI_RetryError. Truncation
		// here caps any single tool result so one runaway search can't sink the request.
		registry.registerConfiguration({
			id: 'vibeide.tools',
			title: localize('vibeide.tools.title', 'VibeIDE — Tool I/O'),
			type: 'object',
			properties: {
				'vibeide.tools.searchMaxChars': {
					type: 'number',
					default: 8000,
					minimum: 1000,
					maximum: 50000,
					description: localize('vibeide.tools.searchMaxChars', 'Максимум символов в одном tool-output для поисковых тулзов (`grep`, `glob`, `search_for_files`, `search_pathnames_only`, `ls_dir`, `get_dir_tree`). Сверх этого порога — head+tail truncation с маркером `[truncated]`, модель видит начало + конец результата. Защищает от того, что один `grep "**/*"` на большом репо забивает весь context window. 8000 ≈ ~2K токенов — достаточно для понимания результата, но не разрушает контекст.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.disableExpensiveSearchInNonAgentModes': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.tools.disableExpensiveSearchInNonAgentModes', 'Отключать «дорогие» поисковые тулзы (`grep`, `glob`, `search_for_files`, `get_dir_tree`) в чат-режимах кроме Agent (`gather`/`plan`). Read/navigation тулзы (`read_file`, `ls_dir`, `go_to_definition`, `find_references`) остаются доступны. Off-by-default; включите если ваш провайдер сильно лимитирован по токенам и вы используете не-агентские режимы только для точечных вопросов.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeideGlobalSettingsConfigurationContribution.ID, VibeideGlobalSettingsConfigurationContribution, WorkbenchPhase.BlockRestore);

