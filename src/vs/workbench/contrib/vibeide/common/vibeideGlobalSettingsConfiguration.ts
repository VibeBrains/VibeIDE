/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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

		// Vibe Server — local preview server with live reload (roadmap VS.2).
		registry.registerConfiguration({
			id: 'vibeide.vibeServer',
			title: localize('vibeide.vibeServer.title', 'VibeIDE — Vibe Server'),
			type: 'object',
			properties: {
				'vibeide.vibeServer.port': {
					type: 'number',
					default: 5500,
					minimum: 0,
					maximum: 65535,
					description: localize('vibeide.vibeServer.port.desc', 'Порт локального сервера предпросмотра. Если занят — берётся ближайший свободный выше. 0 — начать перебор с порта по умолчанию (5500).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.host': {
					type: 'string',
					default: '127.0.0.1',
					description: localize('vibeide.vibeServer.host.desc', 'Адрес привязки сервера. По умолчанию только локальная петля (127.0.0.1) — наружу в сеть сервер не виден.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.root': {
					type: 'string',
					default: '',
					description: localize('vibeide.vibeServer.root.desc', 'Корень раздачи относительно корня рабочей области. Пусто — корень рабочей области.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.ignoreFiles': {
					type: 'array',
					items: { type: 'string' },
					default: ['**/node_modules/**', '**/.git/**', '**/.vibe/**'],
					description: localize('vibeide.vibeServer.ignoreFiles.desc', 'Glob-шаблоны, исключаемые из слежения за изменениями (не вызывают перезагрузку предпросмотра).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.cssHotReload': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.vibeServer.cssHotReload.desc', 'Менять CSS без полной перезагрузки страницы (состояние и прокрутка сохраняются). При выключении любое изменение делает полную перезагрузку.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.spaFallback': {
					type: 'string',
					default: '',
					description: localize('vibeide.vibeServer.spaFallback.desc', 'Файл (относительно корня), отдаваемый для неизвестных путей — включает клиентский роутинг SPA (например, "index.html"). Пусто — отдавать 404.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.previewTarget': {
					type: 'string',
					enum: ['embedded', 'external'],
					enumDescriptions: [
						localize('vibeide.vibeServer.previewTarget.embedded', 'Встроенный браузер внутри VibeIDE.'),
						localize('vibeide.vibeServer.previewTarget.external', 'Внешний браузер по умолчанию.'),
					],
					default: 'embedded',
					description: localize('vibeide.vibeServer.previewTarget.desc', 'Где открывать предпросмотр по умолчанию.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.openAutomatically': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.vibeServer.openAutomatically.desc', 'Открывать предпросмотр сразу после запуска сервера.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.showOnStatusbar': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.vibeServer.showOnStatusbar.desc', 'Показывать состояние Vibe Server в строке состояния.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.reloadDebounceMs': {
					type: 'number',
					default: 100,
					minimum: 0,
					maximum: 5000,
					description: localize('vibeide.vibeServer.reloadDebounceMs.desc', 'Окно подавления дребезга (мс): несколько изменений за это время объединяются в одну перезагрузку.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.autoNavigate': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.vibeServer.autoNavigate.desc', 'Во встроенном браузере автоматически переходить на HTML-файл, который открыт в активном редакторе.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.runtime': {
					type: 'string',
					enum: ['auto', 'static', 'devServer', 'docker'],
					enumDescriptions: [
						localize('vibeide.vibeServer.runtime.auto', 'Автоопределение: при наличии скрипта dev/start/serve в package.json — dev-сервер фреймворка, иначе статический сервер. Docker никогда не поднимается автоматически.'),
						localize('vibeide.vibeServer.runtime.static', 'Всегда статический сервер (HTML/CSS/JS).'),
						localize('vibeide.vibeServer.runtime.devServer', 'Всегда dev-сервер фреймворка (Vite/Next/CRA/Angular).'),
						localize('vibeide.vibeServer.runtime.docker', 'Всегда Docker-окружение (docker-compose.yml / Dockerfile).'),
					],
					default: 'auto',
					description: localize('vibeide.vibeServer.runtime.desc', 'Чем обслуживать проект для предпросмотра.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.dockerStartTimeoutMs': {
					type: 'number',
					default: 120000,
					minimum: 10000,
					maximum: 1200000,
					description: localize('vibeide.vibeServer.dockerStartTimeoutMs.desc', 'Сколько ждать (мс) готовности порта контейнера после поднятия окружения.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.scrollSync': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.vibeServer.scrollSync.desc', 'Синхронизировать прокрутку между несколькими вкладками встроенного превью.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.https': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.vibeServer.https.desc', 'Раздавать статический сервер по HTTPS с самоподписанным сертификатом (для secure-context: service workers, geolocation). Браузер покажет предупреждение о недоверенном сертификате.'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.devScript': {
					type: 'string',
					default: '',
					description: localize('vibeide.vibeServer.devScript.desc', 'Имя npm-скрипта для запуска dev-сервера. Пусто — автоопределение (dev → start → serve).'),
					scope: ConfigurationScope.RESOURCE,
				},
				'vibeide.vibeServer.devServerStartTimeoutMs': {
					type: 'number',
					default: 60000,
					minimum: 5000,
					maximum: 600000,
					description: localize('vibeide.vibeServer.devServerStartTimeoutMs.desc', 'Сколько ждать (мс) URL от dev-сервера, прежде чем считать запуск неудачным.'),
					scope: ConfigurationScope.RESOURCE,
				},
			},
		});

		// `vibeide.modelQuirks.*` — catalog of per-model behaviour overrides
		// (temperature/topP/topK, reasoning placeholder enforcement, tool-call format).
		// Catalog source: `resources/model-quirks.json` shipped with the IDE + CDN refresh
		// from `https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/model-quirks.json`.
		// User `vibeide.modelQuirks` setting overrides catalog values per-model.
		// Implementation: `electron-main/modelQuirks/modelQuirksService.ts`. Settings read
		// ONCE at startup (no IPC channel) — restart required to apply changes.
		registry.registerConfiguration({
			id: 'vibeide.modelQuirks',
			title: localize('vibeide.modelQuirks.title', 'VibeIDE — Model behaviour quirks'),
			type: 'object',
			properties: {
				'vibeide.modelQuirks': {
					type: 'object',
					default: {},
					additionalProperties: {
						type: 'object',
						properties: {
							temperature: { type: 'number', minimum: 0, maximum: 2 },
							topP: { type: 'number', minimum: 0, maximum: 1 },
							topK: { type: 'integer', minimum: 1 },
							forceEmptyReasoning: { type: 'boolean' },
							mirrorReasoningContent: { type: 'boolean' },
							forceToolCallFormat: { type: 'string', enum: ['native', 'xml', 'auto'] },
						},
					},
					description: localize('vibeide.modelQuirks', 'User-уровневые override каталога `resources/model-quirks.json`. Ключ — точный id модели (как в выпадающем меню чата, например `qwen3.6-plus`), значение — объект с полями: `temperature` (0..2), `topP` (0..1), `topK` (натуральное число), `forceEmptyReasoning` (boolean), `mirrorReasoningContent` (boolean), `forceToolCallFormat` (`native` / `xml` / `auto`). Заполненные поля перекрывают каталог; пустые наследуются. Изменение требует перезапуска IDE.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.modelQuirks.catalogUrl': {
					type: 'string',
					default: 'https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/model-quirks.json',
					description: localize('vibeide.modelQuirks.catalogUrl', 'URL для CDN-обновления каталога квирков моделей. По умолчанию — main-ветка VibeIDE на GitHub. Можно указать private mirror (для CI / корпоративных сетей) или fork. Bundled-копия в `resources/model-quirks.json` используется как fallback при недоступности CDN. Изменение требует перезапуска IDE.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.modelQuirks.refreshIntervalHours': {
					type: 'number',
					default: 24,
					minimum: 0,
					maximum: 168,
					description: localize('vibeide.modelQuirks.refreshIntervalHours', 'Как часто (в часах) проверять обновления каталога через CDN. `0` — отключить периодический рефреш (только при старте IDE и по команде `VibeIDE: Refresh model quirks catalog`). Дефолт 24 часа. Изменение требует перезапуска IDE.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		// `vibeide.diagnostics.idleWatchdog.*` — main-process memory/handle sampler.
		// Writes JSONL snapshots to `${userDataPath}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`.
		// Implementation: `electron-main/vibeIdleWatchdogService.ts`. Reads config ONCE
		// at startup directly from `User/settings.json` (no IPC channel) — restart required
		// to apply changes. See docs/knowledge/runtime-quirks/idle-memory.md.
		registry.registerConfiguration({
			id: 'vibeide.diagnostics.idleWatchdog',
			title: localize('vibeide.diagnostics.idleWatchdog.title', 'VibeIDE — Idle Watchdog (diagnostics)'),
			type: 'object',
			properties: {
				'vibeide.diagnostics.idleWatchdog.enabled': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.diagnostics.idleWatchdog.enabled', 'Периодически писать снимок памяти и счётчиков дескрипторов в `${userData}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`. Помогает диагностировать медленные утечки и ночные OOM, которые DevTools не ловит. Изменение требует перезапуска IDE.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.intervalMinutes': {
					type: 'number',
					default: 5,
					minimum: 1,
					maximum: 60,
					description: localize('vibeide.diagnostics.idleWatchdog.intervalMinutes', 'Интервал между снимками памяти в минутах. Меньше = более гранулярная статистика, чуть больше записей на диск. Один день с дефолтным интервалом ≈ 75 КБ. Изменение требует перезапуска IDE.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.retentionDays': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 90,
					description: localize('vibeide.diagnostics.idleWatchdog.retentionDays', 'Сколько дней хранить файлы снимков. Старые удаляются при старте IDE и при пересечении полуночи (UTC). По умолчанию 3 — достаточно для разбора недавнего инцидента; увеличить, если ловите редкий баг.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.13 — opt-in detailed `process.report.getReport()` subset on every Nth tick.
				'vibeide.diagnostics.idleWatchdog.includeProcessReport': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.includeProcessReport', 'Каждый 10-й тик дописывать урезанный `process.report.getReport()` (типы libuv-хэндлов, top-5 native stack frames, maxRss) в `.jsonl`. Помогает локализовать утечки file-descriptor и socket. Объём — ~2 КБ на тик, поэтому off по умолчанию.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.4 — heap-snapshot trigger when rss crosses threshold.
				'vibeide.diagnostics.idleWatchdog.heapSnapshotOnHighRss': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.heapSnapshotOnHighRss', 'Снимать V8 heap snapshot процесса, когда rss превышает порог. Файл сохраняется в `logs/vibe-idle-watchdog/snapshots/`, ротируется до 3 последних. Off по умолчанию — снапшоты занимают 50-500 МБ.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.heapSnapshotThresholdMB': {
					type: 'number',
					default: 2000,
					minimum: 100,
					maximum: 16000,
					description: localize('vibeide.diagnostics.idleWatchdog.heapSnapshotThresholdMB', 'Порог rss (в МБ) для автоматического heap snapshot. Имеет смысл только если `heapSnapshotOnHighRss=true`.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.snapshotCooldownMinutes': {
					type: 'number',
					default: 30,
					minimum: 5,
					maximum: 1440,
					description: localize('vibeide.diagnostics.idleWatchdog.snapshotCooldownMinutes', 'Минимальный интервал между двумя heap snapshot одного и того же процесса. Защищает диск от спама при длительной нагрузке.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.5 — proactive notification on sustained memory growth.
				'vibeide.diagnostics.idleWatchdog.growthAlertMBPerMin': {
					type: 'number',
					default: 5,
					minimum: 1,
					maximum: 200,
					description: localize('vibeide.diagnostics.idleWatchdog.growthAlertMBPerMin', 'Порог роста rss (МБ/мин) на последних 12 тиках, при котором показать proactive-уведомление о возможной утечке. Один раз на (процесс, окно, pid) за сессию.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.sustainedAlertSamples': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.diagnostics.idleWatchdog.sustainedAlertSamples', 'Сколько ПОДРЯД оценок наклона должны превысить `growthAlertMBPerMin`, прежде чем показать уведомление об утечке. Скользящее 12-тиковое окно, попавшее на восходящий фронт GC-пилы (впадина→пик), даёт разовый ложный всплеск; следующее окно его гасит. Требование N подряд отсекает транзиенты, не пропуская реальный устойчивый рост. `1` — прежнее поведение (срабатывание с первого окна). Дефолт 3.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.x / #1632 — rapid-growth heap-snapshot trigger (defaults match
				// vibeIdleWatchdogService DEFAULTS so registering changes nothing at runtime).
				'vibeide.diagnostics.idleWatchdog.heapSnapshotOnRapidGrowth': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.heapSnapshotOnRapidGrowth', 'Снимать V8 heap snapshot при РЕЗКОМ росте rss (а не только при пересечении абсолютного порога `heapSnapshotOnHighRss`). Ловит спайки между тиками. Дельта роста задаётся `snapshotGrowthDeltaMB`. Off по умолчанию — снапшоты занимают 50-500 МБ.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.snapshotGrowthDeltaMB': {
					type: 'number',
					default: 500,
					minimum: 50,
					maximum: 8000,
					description: localize('vibeide.diagnostics.idleWatchdog.snapshotGrowthDeltaMB', 'Прирост rss (в МБ) между тиками, при котором срабатывает rapid-growth snapshot. Имеет смысл только при `heapSnapshotOnRapidGrowth=true`.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.22 — snapshot retention + child-process filter.
				'vibeide.diagnostics.idleWatchdog.maxSnapshotsRetained': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.diagnostics.idleWatchdog.maxSnapshotsRetained', 'Сколько последних heap snapshot файлов хранить в `logs/vibe-idle-watchdog/snapshots/`. Старые ротируются по mtime после каждого нового snapshot.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.diagnostics.idleWatchdog.includeChildProcessTypes': {
					type: 'array',
					items: {
						type: 'string',
						enum: ['Utility', 'GPU', 'Zygote', 'Sandbox helper', 'Pepper Plugin', 'Pepper Broker'],
					},
					default: ['Utility', 'GPU'],
					description: localize('vibeide.diagnostics.idleWatchdog.includeChildProcessTypes', 'Какие типы дочерних Electron-процессов сэмплировать через `app.getAppMetrics()`. Renderer (`Tab`) всегда покрыт отдельной renderer-side контрибуцией — здесь не нужен. Default: extension hosts (`Utility`) + GPU.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.26 — total disk budget for diagnostic logs.
				'vibeide.diagnostics.idleWatchdog.maxLogsTotalMB': {
					type: 'number', default: 500, minimum: 50, maximum: 10000,
					description: localize('vibeide.diagnostics.idleWatchdog.maxLogsTotalMB', 'Лимит общего размера `logs/vibe-idle-watchdog/` (`.jsonl` + snapshots). При превышении — prune oldest snapshots → oldest .jsonl.gz → oldest .jsonl (сегодняшний всегда сохраняется).'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.42 — pre-OOM heap-ratio detector.
				'vibeide.diagnostics.idleWatchdog.preOomHeapRatio': {
					type: 'number', default: 0.85, minimum: 0.5, maximum: 0.99,
					description: localize('vibeide.diagnostics.idleWatchdog.preOomHeapRatio', 'Порог `heapUsed / heapLimit`, при котором показывается pre-OOM нотификация. Default 0.85 — за минуты до V8 OOM aborts.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.46 — opt-in graceful auto-restart before V8 OOM.
				'vibeide.diagnostics.idleWatchdog.autoRestartOnPreOom': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.autoRestartOnPreOom', 'Когда pre-OOM threshold пересечён И пользователь не среагировал на нотификацию в течение 5 минут — автоматически перезапустить IDE (clean restart лучше crash). Off по умолчанию — intrusive feature.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.30 — gzip compression for old `.jsonl`.
				'vibeide.diagnostics.idleWatchdog.compressOldJsonl': {
					type: 'boolean', default: true,
					description: localize('vibeide.diagnostics.idleWatchdog.compressOldJsonl', 'Сжимать `.jsonl` файлы прошлых дней в `.jsonl.gz` при старте IDE. Экономит ~10× места на диске. Сегодняшний файл всегда без сжатия (active write).'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.50 — adaptive sampling.
				'vibeide.diagnostics.idleWatchdog.adaptiveSampling': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.adaptiveSampling', 'Снижать частоту семплирования в 6 раз когда IDE idle > 1 часа (нет активности пользователя). Экономит disk I/O в ночные idle-периоды. Resume normal rate при первом keystroke.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.33 — statistical outlier detection mode.
				'vibeide.diagnostics.idleWatchdog.statisticalOutlier': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.statisticalOutlier', 'Использовать 3-sigma outlier detection вместо фиксированного порога `growthAlertMBPerMin`. Подходит для машин с высоким baseline noise (нагруженные серверы, dev-builds).'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.6/W.29 — status bar widget.
				'vibeide.diagnostics.idleWatchdog.showStatusBar': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.showStatusBar', 'Показывать мини-виджет «🧠 main / renderer / ext» в status bar с обновлением раз в 60s. Click → open Timeline viewer.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.17 — DevTools auto-open on pre-OOM.
				'vibeide.diagnostics.idleWatchdog.autoOpenDevToolsOnPreOom': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.autoOpenDevToolsOnPreOom', 'При pre-OOM alert (W.42) автоматически открыть DevTools в текущем окне — пользователь может вручную снять heap snapshot до V8 abort. Off по умолчанию (intrusive).'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap B — renderer heap snapshot at the absolute commit threshold.
				'vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitAlert': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitAlert', 'Снимать heap snapshot renderer-процесса, когда его private commit пересекает `commitAlertMB`. Off по умолчанию — снимок многогигабайтного renderer у OOM тяжёлый и медленный. Снимок раз на pid.'),
					scope: ConfigurationScope.APPLICATION,
				},
				// Roadmap W.55 — renderer heap snapshot when the commit-slope alert fires (balloon forming).
				'vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitSlope': {
					type: 'boolean', default: false,
					description: localize('vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitSlope', 'Снимать heap snapshot renderer-процесса в момент commit-SLOPE алерта (баллон ещё формируется, ~2 ГБ), не дожидаясь абсолютного `commitAlertMB`. Ловит объекты-виновники, пока спайк в процессе (crash-report 2026-05-31: commit раздулся до ~2 ГБ под нагрузкой агента, но не достиг порога 3.5 ГБ → снимок не снялся). Off по умолчанию — тяжёлая операция; общий guard «раз на pid».'),
					scope: ConfigurationScope.APPLICATION,
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

		// `vibeide.history.*` — chat history project-scoping (roadmap §CH).
		registry.registerConfiguration({
			id: 'vibeide.history',
			title: localize('vibeide.history.title', 'VibeIDE — Chat History'),
			type: 'object',
			properties: {
				'vibeide.history.defaultShowAllProjects': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.history.defaultShowAllProjects', 'Показывать историю чатов из всех проектов по умолчанию. False (по умолчанию) — история ограничена текущим проектом, переключатель «Все проекты» доступен в списках истории. Применяется только пока пользователь сам не переключил тумблер (после этого запоминается выбор пользователя).'),
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
				'vibeide.llm.repairBrokenToolCalls': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.llm.repairBrokenToolCalls', 'Авто-починка битых XML tool-call\'ов: если модель прислала tool-call в некорректном/обрезанном XML (частая проблема deepseek/minimax через aggregator), агент вливает корректирующий ход и даёт модели переотправить вызов в каноне (1 попытка на ход), вместо того чтобы «заткнуться». **Режим отладки совместимости** — добавляет доп. обращение к модели (медленнее) на битых ходах. ON по умолчанию; выключите, если важнее предсказуемая скорость/стоимость.'),
					scope: ConfigurationScope.APPLICATION,
				},
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
				'vibeide.llm.timeoutMs.streamIdle': {
					type: 'integer',
					minimum: 1000,
					maximum: 600_000,
					default: 45_000,
					description: localize('vibeide.llm.timeoutMs.streamIdle', 'Idle-таймаут потока (миллисекунды): прервать стрим, если после НАЧАЛА выдачи контента не пришло ни одного нового токена дольше этого времени. По умолчанию 45000. НЕ покрывает молчаливую фазу размышления ДО первого токена (её ограничивает только общий таймаут) — поэтому reasoning-модели не обрываются на «думании». Поднимите, если модель делает длинные паузы между токенами на медленном upstream.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.llm.timeoutMs.connection': {
					type: 'integer',
					minimum: 1000,
					maximum: 600_000,
					default: 90_000,
					description: localize('vibeide.llm.timeoutMs.connection', 'Таймаут подключения (миллисекунды): прервать запрос, если от провайдера не пришло НИ ОДНОГО фрагмента стрима любого вида. По умолчанию 90000. Снимается первым же фрагментом, поэтому подключённая-но-думающая модель не обрывается. Это ceiling на «мёртвый»/неответивший запрос, не на скорость ответа.'),
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
				'vibeide.chat.auxiliaryModel': {
					type: 'string',
					default: '',
					description: localize('vibeide.chat.auxiliaryModel', 'Дешёвая модель для СЛУЖЕБНЫХ LLM-вызовов (генерация execution-плана и т.п.) в формате `provider/model` (например `openCodeZen/grok-code` ) или просто `model` (поиск по провайдерам в порядке предпочтения). Основной агентский цикл НЕ затрагивается. Пусто (дефолт) — служебные вызовы идут на основную модель. Несуществующая модель — молчаливый fallback на основную (warning в лог).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.continueButtonText': {
					type: 'string',
					default: 'продолжи',
					description: localize('vibeide.chat.continueButtonText', 'Текст, который отправляет кнопка быстрого продолжения (слева от стрелки отправки в композере чата). Этот же текст показывается в её тултипе. Пустое значение — вернуть дефолт «продолжи».'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.compactToolResultsAtTokens': {
					type: 'number',
					default: 60000,
					minimum: 0,
					maximum: 500000,
					description: localize('vibeide.chat.compactToolResultsAtTokens', 'Токен-бюджетная компакция истории: когда суммарный объём tool-result\'ов в треде превышает порог, старые результаты ОДНИМ проходом заменяются стабами `[summarized: N tokens]` — кроме последних `compactKeepRecentToolResults`. Между компакциями история append-only, поэтому prompt-кеш провайдера живёт; компакция = один осознанный сброс кеша (логируется warning-ом). Заменяет прежний `compactToolResultsAfterTurns` (окно по user-ходам не срабатывало в агентских прогонах с одним сообщением, а при срабатывании ломало кеш каждый ход). `0` — отключить. Дефолт 60 000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.compactKeepRecentToolResults': {
					type: 'number',
					default: 8,
					minimum: 1,
					maximum: 100,
					description: localize('vibeide.chat.compactKeepRecentToolResults', 'Сколько ПОСЛЕДНИХ tool-result\'ов сохранять целиком при токен-бюджетной компакции (`compactToolResultsAtTokens`) — свежие чтения/выводы команд остаются у модели дословно, старые стабятся. Дефолт 8.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.maxRetries': {
					type: 'number',
					default: 3,
					minimum: 0,
					maximum: 10,
					description: localize('vibeide.chat.maxRetries', 'Сколько раз переотправлять запрос той же модели при НЕ-rate-limit ошибке (только вне auto-режима выбора модели). Между попытками — экспоненциальный backoff (`retryInitialDelayMs`…`retryMaxDelayMs`). `0` — не повторять. Дефолт 3. Поднимите для нестабильных провайдеров/агрегаторов.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.retryInitialDelayMs': {
					type: 'number',
					default: 1000,
					minimum: 0,
					maximum: 60000,
					description: localize('vibeide.chat.retryInitialDelayMs', 'Начальная задержка (мс) перед первым повтором запроса (см. `vibeide.chat.maxRetries`); далее удваивается до `retryMaxDelayMs`. Локальные провайдеры используют более короткий старт (0.5с), т.к. падают быстро. Дефолт 1000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.retryMaxDelayMs': {
					type: 'number',
					default: 5000,
					minimum: 0,
					maximum: 120000,
					description: localize('vibeide.chat.retryMaxDelayMs', 'Верхний потолок задержки (мс) между повторами запроса при экспоненциальном backoff (см. `vibeide.chat.maxRetries`). Дефолт 5000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.maxConsecutiveToolErrors': {
					type: 'number',
					default: 15,
					minimum: 1,
					maximum: 100,
					description: localize('vibeide.chat.maxConsecutiveToolErrors', 'Circuit-breaker: прервать агентский цикл после стольких ОШИБОК инструментов подряд (счётчик сбрасывается успешным вызовом). Срабатывает как последний рубеж, когда даже авто-даунгрейд на XML-fallback не помог. 15 даёт запас слабым моделям нащупать формат вызова, но не даёт бесконечно молотить на безнадёжной комбинации. Резолвится один раз на прогон. Дефолт 15.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.calibrateTokenBudgetFromUsage': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.chat.calibrateTokenBudgetFromUsage', 'Самокалибровка бюджета контекста по реальным promptTokens провайдера. Внутренняя оценка размера промпта — грубая (`длина/4`) и систематически занижает реальный счёт (tool-схемы, форматирование, токенайзер модели для кода/CJK), из-за чего промпт кажется влезающим в окно, а провайдер видит overflow. При включении VibeIDE ведёт per-(провайдер×модель) EWMA-фактор `реальные/оценка` и делит на него пороги усечения/hard-cap — резерв подгоняется под реальность. По умолчанию **on**; off — вернуться к чистой `длина/4`-оценке.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.antiLoopRepeatThreshold': {
					type: 'number',
					default: 3,
					minimum: 0,
					maximum: 20,
					description: localize('vibeide.chat.antiLoopRepeatThreshold', 'Anti-loop guard: после указанного числа ИДЕНТИЧНЫХ tool-call (одно имя + одни и те же аргументы) в рамках одного запроса VibeIDE не выполняет вызов повторно, а возвращает модели подсказку «результат не изменится, используй уже полученный или двигайся дальше». Разрывает зацикливание на повторных read_file/run_command даже при усечённом контексте. По умолчанию 3; 0 — отключить guard.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.maxInputTokensSafety': {
					type: 'number',
					default: 0,
					minimum: 0,
					maximum: 1000000,
					description: localize('vibeide.chat.maxInputTokensSafety', 'ЛЕГАСИ-страховка: жёсткий потолок input-токенов одного запроса; всё сверх него молча резалось до 120-символьных огрызков. Раньше был захардкожен на 20 000 («под OpenAI 30k TPM») и для моделей с большим окном уничтожал контекст: ломал prompt-кеш на каждом ходу и стирал у модели память о прочитанных файлах (циклы перечитывания — инцидент 2026-06-07). Теперь `0` = ВЫКЛЮЧЕНО (дефолт): payload ограничивает окно модели, а rate-limit обрабатывается автопаузой. Установите положительное значение только если ваш провайдер реально режет по input-TPM и автопаузы не хватает; срабатывание клампа теперь логируется warning-ом.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.hardStallAutoRetry': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.chat.hardStallAutoRetry', 'Авто-повтор хода после hard-stall: если стрим завис (нет токенов дольше `streamHardStallSeconds`), автоматически отправить тот же ход заново ОДИН раз вместо остановки с ошибкой. Наблюдаемый паттерн Zen: большие запросы (40–90k токенов) изредка держатся без единого байта, свежая попытка обычно проходит. Второй stall подряд — ошибка как раньше (зависание системное). Счётчик сбрасывается на успешном ответе.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.hardStallAutoResetTransport': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.chat.hardStallAutoResetTransport', 'Пересоздавать сетевой транспорт перед повтором при зависании стрима. «Тихий» стоп облачного провайдера (запрос ушёл, токенов нет, ошибок нет, биллинг не стартовал) — обычно заклинивший общий keep-alive пул undici; ручной обход был «сменить провайдера / перезапустить IDE», оба дают свежий пул. При включённом флаге авто-повтор и кнопка «Повторить запрос» сначала сбрасывают кэши клиентов и пересоздают пул. Выключите, если хотите повторять на том же соединении.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.autoSendPendingInjections': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.chat.autoSendPendingInjections', 'Авто-досыл подмешанного контекста: если, пока агент работал, вы по Enter поставили текст в очередь (полоска над полем ввода), но ход завершился раньше, чем очередь успела подмешаться, — отправить накопленное автоматически новым ходом вместо того, чтобы оставить его висеть. Срабатывает только на штатном завершении (выполнено / остановка с «Продолжить»); при ошибке, прерывании или ожидании ответа пользователя очередь не трогается. Выключите, если хотите досылать очередь вручную.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.rateLimitAutoWaitMaxSeconds': {
					type: 'number',
					default: 120,
					minimum: 0,
					maximum: 600,
					description: localize('vibeide.chat.rateLimitAutoWaitMaxSeconds', 'Автоожидание минутного rate-limit: при 429 с коротким retry-after агент паузится на указанное провайдером время (потолок — это значение) и продолжает прогон сам, вместо остановки с ошибкой. Работает независимо от автопилота — во время паузы инструменты не выполняются, повторяется только тот же LLM-ход. Квотные лимиты с retry-after в часах/днях сюда не попадают (обрабатываются как 402 без ретраев). `0` — отключить автоожидание (останавливаться сразу, как раньше). Дефолт 120.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.rateLimitAutoWaitMaxRetries': {
					type: 'number',
					default: 3,
					minimum: 0,
					maximum: 10,
					description: localize('vibeide.chat.rateLimitAutoWaitMaxRetries', 'Сколько автоожиданий rate-limit ПОДРЯД допускается на один тред, прежде чем прогон остановится с ошибкой (защита от бесконечного «подожди-повтори» на жёстко зажатом лимите). Счётчик сбрасывается на любом успешном ответе. Дефолт 3.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.antiLoopMaxBlocks': {
					type: 'number',
					default: 8,
					minimum: 1,
					maximum: 50,
					description: localize('vibeide.chat.antiLoopMaxBlocks', 'Эскалация anti-loop guard: после стольких СУММАРНО заблокированных повторных tool-call за один запрос (любые сигнатуры) прогон агента обрывается с явным сообщением — модель игнорирует подсказки guard\'а. Дефолт 8. Первая линия защиты — `antiLoopRepeatThreshold`.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.antiLoopMaxConsecutiveSameBlocks': {
					type: 'number',
					default: 3,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.chat.antiLoopMaxConsecutiveSameBlocks', 'Жёсткая эскалация anti-loop guard: столько ПОДРЯД заблокированных повторов ОДНОЙ И ТОЙ ЖЕ сигнатуры (без единого выполненного вызова между ними) обрывают прогон — модель дословно реплеит один вызов, и каждый повтор стоит полного LLM-обращения. Счётчик сбрасывается, как только модель меняет аргументы/инструмент. Дефолт 3 — ниже общего потолка `antiLoopMaxBlocks`, потому что дословный replay безнадёжнее смешанных повторов.'),
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
					description: localize('vibeide.chat.toolInvalidParamsCircuitBreakerThreshold', 'Сколько раз подряд модель должна вызвать один и тот же tool с одной и той же неверной формой параметров (`invalid_params` подряд) до того, как VibeIDE прервёт чат с явной ошибкой вместо продолжения цикла schema-hint-ов. Защищает от OOM-петель когда aggregator-проксированные модели (Nemotron/qwen/minimax через openCodeGo-zen) застревают в неверном tool-call shape. Сравнить с `emptyResponseCircuitBreakerThreshold` — оба ловят разные классы repetitive failures. По умолчанию 3.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.toolInvalidParamsThrashBreakerThreshold': {
					type: 'number',
					default: 6,
					minimum: 3,
					maximum: 20,
					description: localize('vibeide.chat.toolInvalidParamsThrashBreakerThreshold', 'Сколько tool-вызовов подряд должны завершиться `invalid_params` (с ЛЮБЫМ именем инструмента и ЛЮБОЙ формой параметров, без единого успешного вызова между ними), чтобы VibeIDE прервал чат. В отличие от `toolInvalidParamsCircuitBreakerThreshold` (одинаковый tool + одинаковая форма) этот порог ловит «болтанку» (thrash), когда модель перебирает РАЗНЫЕ неверные сочетания «инструмент ↔ параметры» — типичный для aggregator-проксированных моделей рассинхрон, выжигающий весь токен-бюджет. По умолчанию 6 (> 2, чтобы модель, исправляющаяся за пару попыток, не обрывалась).'),
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
				'vibeide.chat.maxStoredToolResultKB': {
					type: 'number',
					default: 24,
					minimum: 4,
					maximum: 2048,
					description: localize('vibeide.chat.maxStoredToolResultKB', 'Максимальный РАЗМЕР (КБ) одного сохранённого tool-результата в истории треда, ПОСЛЕ того как он выходит из окна `keepRecentFullToolResults`. Дополняет `maxMessagesPerThread` (тот ограничивает ЧИСЛО сообщений, а этот — размер каждого): один огромный `read_file`/поиск может весить больше сотен мелких сообщений. Сверх порога — head+tail усечение с маркером и подсчётом КБ; перезапуск инструмента восстанавливает полный вывод. Снижает память рендерера и размер стора на диске на длинных сессиях. Дефолт 24 КБ. Поднимите, если часто нужен полный старый вывод; нижний предел 4 КБ — чтобы маркер не вытеснял сам результат.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.keepRecentFullToolResults': {
					type: 'number',
					default: 16,
					minimum: 0,
					maximum: 200,
					description: localize('vibeide.chat.keepRecentFullToolResults', 'Сколько ПОСЛЕДНИХ tool-результатов в треде хранить целиком (без размерного усечения `maxStoredToolResultKB`). Свежие результаты нужны и активному просмотру, и LLM-контексту, поэтому 16 — заведомо больше окна LLM-компакции (`compactKeepRecentToolResults`, дефолт 8): агентский цикл никогда не видит усечённого свежего результата. Дефолт 16.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.maxOpenTabs': {
					type: 'number',
					default: 5,
					minimum: 1,
					maximum: 20,
					description: localize('vibeide.chat.maxOpenTabs', 'Максимум одновременно открытых вкладок чата. При превышении самая старая вкладка автоматически закрывается (тред остаётся в истории, не удаляется). Активная вкладка никогда не закрывается. Установите 1, чтобы держать только один чат за раз.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.chat.defaultWidth': {
					type: 'number',
					default: 650,
					minimum: 320,
					maximum: 2000,
					description: localize('vibeide.chat.defaultWidth', 'Ширина боковой панели VibeIDE (в пикселях), применяемая при открытии чата. Задаёт ширину чата по умолчанию. Применяется один раз; после ручного перетаскивания границы ваш размер сохраняется. Изменение этого значения снова применит новую ширину при следующем открытии чата.'),
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
				'vibeide.agent.forceToolUseOnNudge': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.agent.forceToolUseOnNudge', 'В автопилоте, когда модель завершила ход ТЕКСТОМ без вызова инструмента, корректирующий нудж отправляется с `tool_choice: required` — модель ОБЯЗАНА эмитить вызов (нужный инструмент или `vibe_complete`), а не вернуть прозу снова. Лечит слабые модели (MiniMax/deepseek через агрегатор), которые пишут «Завершаю» текстом вместо вызова `vibe_complete`. Не действует в XML-режиме (native-тулзы туда не шлются) и на прямых ходах. Если провайдер не поддерживает `tool_choice` (404) — срабатывает штатный авто-даунгрейд в XML. Дефолт on; off — прежнее поведение (нудж без форса).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.agent.implicitCompleteOnExhaustedNudge': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.agent.implicitCompleteOnExhaustedNudge', 'Сеть-подстраховка автопилота: когда бюджет нуджей (`autoContinueMaxNudges`) исчерпан, а модель упорно ДЕКЛАРИРУЕТ завершение прозой («Готово», «Завершаю», «Задача выполнена») вместо вызова `vibe_complete` — закрыть прогон как неявное завершение, вместо тупика с кнопкой «Продолжить». Узко: только автопилот + исчерпанный бюджет + терминальный текст-завершение (не воскрешает старый always-on «Готово»-матчинг). Provider-независимо — работает даже если форс `tool_choice` проигнорирован. Дефолт on; off — всегда показывать «Продолжить».'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.agent.implicitCompleteAfterFirstNudge': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.agent.implicitCompleteAfterFirstNudge', 'Раннее чистое завершение автопилота: если модель уже получила хотя бы ОДИН принудительный нудж (`tool_choice=required` — явный шанс вызвать `vibe_complete`), но снова заканчивает НЕ-вопросный ход терминальной прозой завершения («Готово», «Задача выполнена», "task complete") — принять это как неявное завершение СРАЗУ, не доедая остаток бюджета нуджей. Зачем: лишние нуджи «продолжай!» на реально завершённой задаче провоцируют слабую модель выдумывать ненужную работу. Вопросы сюда не попадают (идут своим путём подпинывания). Дефолт on; off — ждать полного исчерпания бюджета (см. `implicitCompleteOnExhaustedNudge`).'),
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
		// (openCodeGo/minimax-m2.7) to return empty responses → AI_RetryError. Truncation
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
				'vibeide.tools.searchBackendRetries': {
					type: 'number',
					default: 1,
					minimum: 0,
					maximum: 5,
					description: localize('vibeide.tools.searchBackendRetries', 'Сколько раз авто-повторять запуск поискового backend\'а (ripgrep) при перемежающемся сбое spawn (`ENOENT`). Такой сбой на присутствующем здоровом `rg.exe` обычно означает, что антивирус/EDR держит лок на бинарнике в момент частых вызовов подряд. Ретрай делает это прозрачным для агента. `0` = не повторять (сразу явная ошибка). Дефолт 1.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.searchBackendRetryDelayMs': {
					type: 'number',
					default: 150,
					minimum: 0,
					maximum: 5000,
					description: localize('vibeide.tools.searchBackendRetryDelayMs', 'Задержка в миллисекундах между повторными попытками запуска поискового backend\'а (см. `vibeide.tools.searchBackendRetries`). Даёт антивирусу/EDR отпустить лок на `rg.exe` перед повтором. Дефолт 150 мс.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.disableExpensiveSearchInNonAgentModes': {
					type: 'boolean',
					default: false,
					description: localize('vibeide.tools.disableExpensiveSearchInNonAgentModes', 'Отключать «дорогие» поисковые тулзы (`grep`, `glob`, `search_for_files`, `get_dir_tree`) в чат-режимах кроме Agent (`gather`/`plan`). Read/navigation тулзы (`read_file`, `ls_dir`, `go_to_definition`, `find_references`) остаются доступны. Off-by-default; включите если ваш провайдер сильно лимитирован по токенам и вы используете не-агентские режимы только для точечных вопросов.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.readFileDefaultLineLimit': {
					type: 'number',
					default: 2000,
					minimum: 1,
					maximum: 100000,
					description: localize('vibeide.tools.readFileDefaultLineLimit', 'Сколько строк возвращает `read_file` при чтении файла БЕЗ явного диапазона/лимита. Прямо определяет, сколько контента одно чтение вливает в контекст = токен-стоимость. Дефолт 2000. Поднимите, если модель часто дочитывает файлы по частям; опустите на жёстко лимитированных по токенам провайдерах.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.rewriteFileTruncationGuard': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.tools.rewriteFileTruncationGuard', '`rewrite_file`: отклонять перезапись существенного файла контентом, составляющим малую долю от текущего размера — почти всегда это значит, что модель пере-эмитила весь файл, но её вывод обрезался (тихая потеря данных). Новые/пустые файлы guard не трогает. Выключите, если осознанно сильно ужимаете большие файлы целофайловым rewrite.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.rewriteFileTruncationMinChars': {
					type: 'number',
					default: 2000,
					minimum: 0,
					maximum: 1000000,
					description: localize('vibeide.tools.rewriteFileTruncationMinChars', 'Минимальный размер ТЕКУЩЕГО файла (символы), ниже которого truncation-guard `rewrite_file` не срабатывает. Мелкие файлы не проверяются. Дефолт 2000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.rewriteFileTruncationRatio': {
					type: 'number',
					default: 0.3,
					minimum: 0,
					maximum: 1,
					description: localize('vibeide.tools.rewriteFileTruncationRatio', 'Порог truncation-guard `rewrite_file`: срабатывает, если новый контент короче `ratio × текущий_размер`. 0.3 = блокировать, когда новый файл < 30% старого (>70% усечение). Ниже = строже (меньше ложных), выше = чувствительнее. Дефолт 0.3.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.readFileMaxLineLimit': {
					type: 'number',
					default: 10000,
					minimum: 1,
					maximum: 1000000,
					description: localize('vibeide.tools.readFileMaxLineLimit', 'Верхний потолок на явный `line_limit` в `read_file` — запрос большего числа строк ужимается до этого значения. Защищает от вытягивания гигантского файла одним вызовом. Дефолт 10000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.readFileMaxCharsPerPage': {
					type: 'number',
					default: 500000,
					minimum: 10000,
					maximum: 5000000,
					description: localize('vibeide.tools.readFileMaxCharsPerPage', 'Жёсткий байтовый потолок на ОДНУ страницу вывода `read_file` (пагинация для огромных/минифицированных файлов). Также ограничивает длину блока lint-ошибок. Дефолт 500000 символов.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.largeFileThresholdChars': {
					type: 'number',
					default: 200000,
					minimum: 10000,
					maximum: 5000000,
					description: localize('vibeide.tools.largeFileThresholdChars', 'Порог «большого файла»: полное чтение файла крупнее этого числа символов сужается до окна `largeFileWindowChars` и помечается как частичное (модель докручивает через start_line/grep), чтобы один read не съел весь контекст. Дефолт 200000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.largeFileWindowChars': {
					type: 'number',
					default: 80000,
					minimum: 5000,
					maximum: 2000000,
					description: localize('vibeide.tools.largeFileWindowChars', 'Ширина окна (в символах), до которого ужимается полное чтение файла крупнее `largeFileThresholdChars`. Дефолт 80000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.tools.maxTerminalOutputChars': {
					type: 'number',
					default: 100000,
					minimum: 1000,
					maximum: 5000000,
					description: localize('vibeide.tools.maxTerminalOutputChars', 'Максимум символов вывода терминала (`run_command`/чтение терминала), попадающего в контекст модели за один вызов. Сверх порога — head+tail truncation. Смысловой конденсер (`vibeide.terminal.condenseOutput`) отрабатывает ДО этого жёсткого капа. Дефолт 100000.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.terminal.condenseOutput': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.terminal.condenseOutput', 'Смысловое сжатие вывода `run_command` перед отправкой модели: схлопывать повторяющиеся строки (`[× N]`) и серии «шумовых» строк тест-раннеров/сборщиков (прогресс-бары, «ok»-маркеры, Downloading/Compiling-спам) с маркером `[… +N similar lines condensed]`. Строки с ошибками (±3 строки контекста), итоговые summary-строки и голова/хвост вывода сохраняются дословно. Срабатывает только на длинном выводе (от 80 строк); экономит input-токены на тестовых прогонах. Размерный кламп (head+tail) остаётся страховкой после сжатия. Off — отправлять вывод как есть.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});

		registry.registerConfiguration({
			id: 'vibeide.notify',
			title: localize('vibeide.notify.title', 'VibeIDE — Уведомления'),
			type: 'object',
			properties: {
				'vibeide.notify.sound.enabled': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.notify.sound.enabled', 'Проигрывать короткий звук, когда IDE переходит в состояние «жду пользователя», а работа агента НЕ идёт: ход завершён, прогон встал (показан «Продолжить») или агент ждёт ответа/подтверждения плана. Тонкая настройка событий — ниже (`onComplete`/`onStalled`/`onAwaitingUser`).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.sound': {
					type: 'string',
					enum: ['taskCompleted', 'success', 'chatUserActionRequired', 'terminalBell', 'break', 'custom'],
					enumDescriptions: [
						localize('vibeide.notify.sound.sound.taskCompleted', 'Завершение задачи (дефолт)'),
						localize('vibeide.notify.sound.sound.success', 'Успех'),
						localize('vibeide.notify.sound.sound.chatUserActionRequired', 'Требуется действие'),
						localize('vibeide.notify.sound.sound.terminalBell', 'Звонок терминала'),
						localize('vibeide.notify.sound.sound.break', 'Короткий сигнал'),
						localize('vibeide.notify.sound.sound.custom', 'Свой файл (укажите путь в `customPath`)'),
					],
					default: 'taskCompleted',
					description: localize('vibeide.notify.sound.sound', 'Какой звук проигрывать. Удобнее всего — пикер с превью по клику в Настройках VibeIDE → «Уведомления», либо редактор «VibeIDE Звуки» (меню-мозг в заголовке), где можно загрузить свой трек и вырезать фрагмент. Прослушать выбранный вариант также можно командой «VibeIDE: Прослушать звук уведомления». Для своего звука выберите `custom` и укажите путь в `vibeide.notify.sound.customPath`.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.customPath': {
					type: 'string',
					default: '',
					description: localize('vibeide.notify.sound.customPath', 'Абсолютный путь к своему звуковому файлу (используется, когда `sound` = `custom`). Допустимые форматы: mp3, ogg, wav. Лимиты: размер до 1 МБ, длительность до 5 секунд. Файл вне правил не принимается — будет проигран дефолтный звук, причина пишется в лог.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.volume': {
					type: 'number',
					default: 0.6,
					minimum: 0,
					maximum: 1,
					description: localize('vibeide.notify.sound.volume', 'Громкость звука уведомления (0 — тихо, 1 — максимум). Дефолт 0.6.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.muteWhenFocused': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.notify.sound.muteWhenFocused', 'Не проигрывать звук, если окно IDE сейчас в фокусе. Телефонная логика «позвать, когда отошёл»: звук слышен только когда вы переключились в другое окно/приложение. Бонусом гасит звук при ручной остановке (Escape), когда вы у клавиатуры. Выключите, чтобы звук играл всегда.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.onComplete': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.notify.sound.onComplete', 'Звук при завершении хода (модель закончила работу: `vibe_complete` / естественный конец).'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.onStalled': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.notify.sound.onStalled', 'Звук, когда прогон встал без подпинываний: автопилот исчерпал бюджет нуджей и показана кнопка «Продолжить».'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.notify.sound.onAwaitingUser': {
					type: 'boolean',
					default: true,
					description: localize('vibeide.notify.sound.onAwaitingUser', 'Звук, когда агент ждёт пользователя: вопрос или подтверждение плана.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeideGlobalSettingsConfigurationContribution.ID, VibeideGlobalSettingsConfigurationContribution, WorkbenchPhase.BlockRestore);

