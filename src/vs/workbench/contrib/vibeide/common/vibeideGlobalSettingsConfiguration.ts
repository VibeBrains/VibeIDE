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
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeideGlobalSettingsConfigurationContribution.ID, VibeideGlobalSettingsConfigurationContribution, WorkbenchPhase.BlockRestore);

