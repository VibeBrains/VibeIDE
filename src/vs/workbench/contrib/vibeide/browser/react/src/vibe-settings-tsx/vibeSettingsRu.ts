/*---------------------------------------------------------------------------------------------
 *  Russian UI strings for VibeIDE Settings (React panel).
 *--------------------------------------------------------------------------------------------*/

import type { ChatMode } from '../../../../common/vibeideSettingsTypes.js';
import { VIBE_WORKSPACE_FORMAT_VERSION } from '../../../../common/vibeDefaultWorkspaceReadme.js';

const VV = VIBE_WORKSPACE_FORMAT_VERSION;

/** Sidebar chat: mode labels in the dropdown. */
export const chatModeDisplayName: Record<ChatMode, string> = {
	normal: 'Чат',
	gather: 'Обзор',
	plan: 'План',
	agent: 'Агент',
};

/** Sidebar chat: mode tooltips in the dropdown. */
export const chatModeDetail: Record<ChatMode, string> = {
	normal: 'Обычный диалог',
	gather: 'Обход кодовой базы, только чтение',
	plan: 'Сначала план, потом действие',
	agent: 'Правит файлы и вызывает инструменты',
};

/** Plural helper: «N файлов с изменениями». */
export function chatFilesWithChangesLabel(n: number): string {
	if (n === 0) {
		return 'Нет файлов с изменениями';
	}
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) {
		return `${n} файл с изменениями`;
	}
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
		return `${n} файла с изменениями`;
	}
	return `${n} файлов с изменениями`;
}

/** Diff count line under file name in command bar. */
export function chatDiffCountLabel(n: number): string {
	if (n === 0) {
		return 'Нет правок';
	}
	if (n === 1) {
		return '1 правка';
	}
	if (n >= 2 && n <= 4) {
		return `${n} правки`;
	}
	return `${n} правок`;
}

/** Russian UI strings for VibeIDE sidebar chat (React). */
export const chatS = {
	placeholderShort: 'План, @ для контекста',
	placeholderFull: 'План, @ для контекста, / для команд',
	contextTokens: (total: number, budget: number, pct: number) =>
		`Контекст ~${total} / ${budget} токенов (${pct}%)`,
	contextUsageAria: (pct: number) => `Использование контекста ${pct}%`,
	contextNearLimit: (total: number, budget: number) =>
		`Контекст почти исчерпан: ~${total} / ${budget} токенов. Старые сообщения могут быть суммаризированы.`,
	suggestions: 'Подсказки',
	previousThreads: 'Прошлые чаты',
	chipFile: 'Файл',
	chipFolder: 'Папка',
	chipModel: 'Модель',
	chipFallbackFolder: 'папка',
	chipFallbackFile: 'файл',
	removeChipAria: (name: string) => `Убрать ${name}`,
	rangeTooltip: (path: string, start: number, end: number) =>
		`${path} (строки ${start}–${end})`,
	quickExplain: 'Объяснить',
	quickRefactor: 'Рефакторинг',
	quickAddTests: 'Добавить тесты',
	quickFixTests: 'Починить тесты',
	quickDocstring: 'Докстринг',
	quickOptimize: 'Оптимизация',
	quickDebug: 'Отладка',
	suggestSummarize: 'Кратко опиши мой проект',
	suggestRustTypes: 'Как устроены типы в Rust?',
	suggestAgentsMd: 'Помоги написать AGENTS.md для этого репозитория',
	suggestAgentRules: 'Прикрепить правила агента (@agent)',
	autopilotLabel: 'Автопилот',
	autopilotTitle:
		'Автопилот: запускать инструменты (правки, удаление, терминал, MCP) без подтверждения. Выключите — подтверждать каждый шаг.',
	trainingUnknown: 'обуч.?',
	trainingNone: 'без обуч.',
	trainingOptIn: 'opt-in',
	trainingOptOut: 'opt-out',
	trainingMayTrain: 'может обуч.',
	trainingTipUnknown:
		'Политика обучения неизвестна — обновите каталог или проверьте документацию провайдера (VibeIDE models.json).',
	trainingTipNone: 'Каталог: провайдер указывает, что данные API по умолчанию не используются для обучения.',
	trainingTipOptIn: 'Каталог: для обучения нужно явное согласие (opt-in).',
	trainingTipOptOut:
		'Каталог: по умолчанию обучение возможно; можно отключить (opt-out).',
	trainingTipMayTrain: 'Каталог: данные могут использоваться для обучения на типовых условиях.',
	sendMessageAria: 'Отправить сообщение',
	stopGenerationAria: 'Остановить генерацию',
	uploadImagesAria: 'Загрузить изображения',
	uploadImagesTitle: 'Загрузить изображения (или вставить / перетащить)',
	uploadPdfsAria: 'Загрузить PDF',
	uploadPdfsTitle: 'Загрузить PDF (или вставить / перетащить)',
	thinkingLabel: 'Рассуждение',
	thinkingDisabled: 'Рассуждение выключено',
	tokensSuffix: 'токенов',
	loadingThinkingAria: 'Думает',
	loadingTypingAria: 'Печатает',
	loadingProcessingAria: 'Обрабатывает',
	loadingDefaultAria: 'Загрузка',
	statusNeedsApproval: 'Нужно подтверждение',
	statusPreparing: 'Подготовка',
	statusRunning: 'Выполняется',
	statusDone: 'Готово',
	rejectAllTooltip: 'Отклонить всё',
	acceptAllTooltip: 'Принять всё',
	rejectFileTooltip: 'Отклонить файл',
	acceptFileTooltip: 'Принять файл',
	historyToolbarTitle: 'История чатов',
	historyFilterPlaceholder: 'Фильтр…',
	historyEmptyFiltered: 'Нет совпадений',
} as const;


/** Полная справка (Markdown) для вкладки JSON в Workspace; правда о рантайме см. код `vibeConstraintsService`, `toolsService`, `vibeAgentTerritorialLockService`. */
export function workspaceRootJsonDocMarkdown(basename: string): string {
	switch (basename) {
		case 'agent-locks.json':
			return [
				'### Консультативные блокировки записи (**agent-locks**)',
				'',
				'- **Что делает.** Перед сохранением правок через инструменты **write / rewrite / edit** VibeIDE сопоставляет путь файла с вашими записями. Путь берётся **относительно корня папки воркспейса** (формат как в проводнике: `src/app.ts`, `.vibe/rules.md`; прямые слеши).',
				'- **Формат.** Корневое поле **`locks`** — массив объектов:',
				'  - **`holder`** — произвольная подпись владельца или причины (показывается в ошибке или аудите).',
				'  - **`paths`** — массив **glob-паттернов** (как в `glob` VS Code).',
				'  - **`until`** _(опционально)_ — строка времени ISO-8601. Пока `Date.now() ≤ until`, запись действует; без **`until`** — бессрочно. Невалидная дата ⇒ запись **игнорируется**.',
				'- **Жёсткость.** Если включены **не** полностью авто-режимы правок (**agent autopilot** и **авто-подтверждение правок** выключены), совпадение по паттерну **блокирует** сохранение с текстом ошибки и списком `holder`/`patterns`. Если включён автопохожий режим (**autopilot или авто-approve правок**), запись может **пройти**, но в аудит может уйти событие `advisory_territorial_lock` (консультативная фиксация).',
				'- **Подсказка.** Для конфликта «люди vs один агент» заведите **узкий holder** (`human: задача №123 — Имя`) и **ясные glob**. Для временной аренды папки — **`until`**.',
			].join('\n');

		case 'allowed-models.json':
			return [
				'### Whitelist моделей (**allowed-models**)',
				'',
				'- **`models`.** Массив строк. Если массив **пустой** или файл отсутствует ⇒ **нет ограничения**.',
				'- **Логика сопоставления** (метод сервиса): модель считается разрешённой, если **полное совпадение строки без учёта регистра** или **полный идентификатор модели содержит** одну из строк списка (тоже регистронезависимо). Короткая строка вроде «gpt» зацепит и `gpt-4o`, и `my-gpt-lite` — лучше полные суффиксы.',
				'- **Когда подхватывается.** Файл перечитывается вместе с `constraints.json` при старте и после сохранения из этой формы (`save` триггерит `reload`).',
				'- **Честно про текущий код.** Поле загружается в `IVibeConstraintsService`; публичный метод **`isModelAllowed` существует**, но на момент этой сборки **ни один путь отправки сообщения не вызывает его** ⇒ список **не отсекает** выбор модели в UI автоматически. Используйте файл как зафиксированную политику команды и задел; для реальной экономии ключей ограничивайте доступ к провайдерам во **встроенных настройках**.',
			].join('\n');

		case 'constraints.json':
			return [
				'### Жёсткие ограничения IDE (**constraints**)',
				'',
				'- **Не обходится промптами** — это вызовы на уровне инструментов до записи/части операций.',
				'- **`rules`** — массив правил:',
				'  - **`deny_write` + `pattern` + необязательный `message` — реально блокируют запись**, если абсолютный путь матчится **glob-подобным** шаблоном (`*`, `?`, `**`), см. код сервиса.',
				'  - **`deny_read` + `pattern`** — поддержаны в том же типе данных, **`checkReadAllowed` сейчас не вызывается из `read_file`**, то есть блокировку чтения агентом через этот тип **не следует считать рабочей**; исключите мусор и секреты из контекста через **`.vibe/ignore`**.',
				'  - Типы **`max_lines_per_function`** и **`deny_age`** заданы в типах, но **в текущей реализации `checkWriteAllowed` они не проверяются** — не рассчитывайте на них.',
				'- **Отдельно:** `.vibe/goals.md` — по умолчанию агент **может** писать через инструменты; чтобы сделать файл только для человека, добавьте **`deny_write`** для `.vibe/goals.md` в **constraints.json**.',
			].join('\n');

		case 'pinned.json':
			return [
				'### Закрепления (**pinned**)',
				'',
				'- **Назначение полей.** `files` — пути файлов или glob/идентификаторы вашей договорённости; `symbols` — символы (например `workspace:ClassName` или короткая метка) — трактуйте как согласованный список «что считать ключевым».',
				'- **Текущий рантайм.** Файл создаётся при инициализации `.vibe/` и участвует в health-check; **автоматического приклеивания к каждому запросу агента** в этом репозитории пока не подключено (см. `vibeUnifiedConfigService` Phase 2).',
				'- **Практика.** Держите здесь живой минимальный список; важный контент всё равно **прикрепляйте @** в сообщении или ссылайтесь в `rules.md`.',
			].join('\n');

		default:
			return [
				'### Любой другой `.json` в корне `.vibe/`',
				'',
				`- Сохраняйте **валидный JSON** и поле **vibeVersion** по договорённости команды (сейчас ориентир **${VV}**).`,
				'- Встроенная логика VibeIDE **не импортирует произвольные** корневые JSON — они для скриптов, CI и ваших процессов, пока вы сами их не начнёте читать.',
			].join('\n');
	}
}


/** Подробные примеры JSON для кнопки «Подставить пример». */
export const VIBE_CONSTRAINTS_JSON_EXAMPLE = `${JSON.stringify(
	{
		vibeVersion: VV,
		_comment_file:
			'Жёсткие ограничения перед записью (и типы правил для чтения). См. справку в форме про deny_write / deny_read.',
		rules: [
			{
				_comment_rule: 'Пример 1 — запрет перезаписи секретов и prod-конфигов под glob.',
				type: 'deny_write',
				pattern: '**/.env*',
				message: 'Секреты и .env только вручную, без инструментов агента',
			},
			{
				_comment_rule: 'Пример 2 — любой файл с суффиксом .pem в дереве.',
				type: 'deny_write',
				pattern: '**/*.pem',
				message: 'Ключи не трогаем из чата',
			},
			{
				type: 'deny_read',
				pattern: '**/internal-audit/**',
				message:
					'Тип поддержан в данных, но read_file пока не вызывает deny_read — для скрытия из контента используйте .vibe/ignore',
			},
		],
	},
	null,
	'\t',
)}\n`;

export const VIBE_ALLOWED_MODELS_JSON_EXAMPLE = `${JSON.stringify(
	{
		vibeVersion: VV,
		_comment_file:
			'Пустой models = любая модель. Непустой = whitelist; см. справку: сопоставление по равенству или substring (регистр игнорируется). На текущую сборку — без автоблокировки выбора в UI.',
		models: [
			'claude-opus',
			'gpt-5',
			'qwen2.5-coder',
		],
	},
	null,
	'\t',
)}\n`;

export const VIBE_PINNED_JSON_EXAMPLE = `${JSON.stringify(
	{
		vibeVersion: VV,
		_comment_files:
			'Пути от корня репозитория или понятная вам кодировка; автоподтяжка в промпт может быть не включена — см. справку.',
		_comment_symbols:
			'Строковые ключи символов/модулей по договорённости команды (точный формат на ваш стандарт).',
		files: [
			'docs/architecture.md',
			'src/domain/core/types.ts',
		],
		symbols: [
			'AppService',
			'AuthFlow',
		],
	},
	null,
	'\t',
)}\n`;

export const VIBE_AGENT_LOCKS_JSON_EXAMPLE = `${JSON.stringify(
	{
		vibeVersion: VV,
		_comment_file:
			'Массив locks: holder + glob paths относительно корня воркспейса; until опционально (ISO UTC). Один объект с until, второй без срока.',
		locks: [
			{
				_comment: 'Человек ведёт крупный рефакторинг — до указанной даты агенту лучше не трогать эти файлы.',
				holder: 'human: платёжный модуль — Алекс до ревью',
				paths: [
					'src/features/billing/**/*',
					'package.json',
				],
				until: '2026-06-01T09:00:00.000Z',
			},
			{
				holder: 'no-agent-touch: кодоген без ручной проверки',
				paths: [
					'generated/**/*',
				],
			},
		],
	},
	null,
	'\t',
)}\n`;

/** Default example for arbitrary `.json` in `.vibe/` root. */
export const VIBE_GENERIC_ROOT_JSON_EXAMPLE = `{\n\t"vibeVersion": "${VV}",\n\t"_comment": "Пример произвольного корневого JSON под ваш пайплайн"\n}\n`;

/** Tool approval type labels (shown next to auto-approve switches). */
export const toolApprovalLabel = (t: string): string => {
	switch (t) {
		case 'edits': return 'Авто-подтверждение правок файлов';
		case 'terminal': return 'Авто-подтверждение терминала';
		case 'MCP tools': return 'Авто-подтверждение инструментов MCP';
		default: return `Авто-подтверждение ${t}`;
	}
};

export const nav = {
	workspace: 'Рабочая область',
	models: 'Модели',
	localProviders: 'Локальные провайдеры',
	providers: 'Облачные провайдеры',
	featureOptions: 'Функции',
	general: 'Общие',
	mcp: 'MCP',
	all: 'Все настройки',
} as const;

export const modelsS = {
	refreshUpToDate: (providerTitle: string) => `${providerTitle}: модели актуальны!`,
	refreshNotFound: (providerTitle: string) => `${providerTitle}: не найден!`,
	refreshManual: (providerTitle: string) => `Обновить список моделей ${providerTitle} вручную.`,
	catalogRefreshed: (providerTitle: string) => `Каталог ${providerTitle} обновлён!`,
	catalogFailed: (providerTitle: string) => `Не удалось обновить каталог ${providerTitle}`,
	catalogRefresh: (providerTitle: string) => `Обновить каталог моделей ${providerTitle}`,
	add: 'Добавить',
	confirmReset: 'Подтвердить сброс',
	invalidJson: 'Неверный JSON',
	changeDefaultsTitle: (modelName: string, providerTitle: string) =>
		`Изменить значения по умолчанию для ${modelName} (${providerTitle})`,
	modelPackaged: (modelName: string) =>
		`${modelName} входит в поставку VibeIDE — обычно менять эти параметры не нужно.`,
	modelUnknown: 'Модель не распознана VibeIDE.',
	modelRecognized: (modelName: string, recognizedModelName: string) =>
		`VibeIDE распознаёт ${modelName} («${recognizedModelName}»).`,
	overrideDefaults: 'Переопределить параметры модели',
	sourcecodeRef: (link: string) =>
		`См. [исходники](${link}) как справку по JSON (для продвинутых).`,
	cancel: 'Отмена',
	save: 'Сохранить',
	tooltipShowInDropdown: 'Показать в списке',
	tooltipHideFromDropdown: 'Скрыть из списка',
	tooltipDetectedLocally: 'Обнаружено локально',
	tooltipCustomModel: 'Пользовательская модель',
	tooltipAdvanced: 'Расширенные параметры',
	tooltipDelete: 'Удалить',
	selectProvider: 'Выберите провайдера.',
	enterModelName: 'Введите имя модели.',
	modelExists: 'Такая модель уже есть.',
	noProviders: 'Провайдеры ещё не настроены. Списки моделей появятся после сохранения ключей API или конечных точек на вкладке ',
	providersTabStrong: 'Облачные провайдеры',
	noProviders2: ' (и обновления там, где доступно).',
	defaultsHidden: 'Значения по умолчанию скрыты, пока не подключён провайдер — список короче.',
	added: 'Добавлено',
	providerNamePh: 'Имя провайдера',
	modelNamePh: 'Имя модели',
	addModel: 'Добавить модель',
	noConfiguredProviders: 'Пока нет настроенных провайдеров.',
	/** Placeholder for substring filter in the model list (matches model id, case-insensitive). */
	modelSearchPlaceholder: 'Поиск по имени модели…',
	/** Filter toggle: show only models whose per-row switch is on (visible in dropdowns). */
	modelsOnlyActiveLabel: 'активные',
	modelsOnlyActiveTitle:
		'Показывать в списке только модели, включённые переключателем (видимые в списках выбора модели).',
} as const;

export const providersS = {
	warnOllama: 'Установите модель Ollama — мы её подхватим автоматически.',
	warnAddModel: (providerTitle: string) =>
		`Добавьте модель для ${providerTitle} (раздел «Модели»).`,
	openRouterPublicCatalog:
		'Загружать полный список моделей с OpenRouter без ключа (для запросов к API ключ по-прежнему нужен, если не используете только бесплатные эндпоинты).',
	/** Shown under "add model" warning on Providers tab when catalog can be refetched */
	catalogRetryHint:
		'Список не появился — обновите каталог. Переключатели моделей сохраняются в настройках VibeIDE и не сбрасываются при обновлении.',
} as const;

export const generalS = {
	autoDetectLocal: (list: string) =>
		`Автоматически обнаруживать локальные провайдеры и модели (${list}).`,
	aiInstructionsPlaceholder:
		'Не меняйте мои отступы и не удаляйте комментарии. В TS/JS не добавляйте точки с запятой. По возможности пишите новый код на Rust.',
	fastApply: 'Быстрый Apply',
	slowApply: 'Медленный Apply',
	fastApplyDetail: 'Блоки поиска/замены',
	slowApplyDetail: 'Перезапись целых файлов',
} as const;

export const ollamaS = {
	statusStarting: 'Запуск установки Ollama и открытие терминала…',
	statusRunningInstaller: 'Установщик в терминале…',
	statusLaunched: 'Установщик запущен. Ожидание моделей…',
	statusRunning: 'Ollama работает. Модели скоро появятся.',
	failStart: 'Не удалось начать установку. Повторите или установите вручную.',
	failStartShort: 'Ошибка запуска. См. терминал или установите вручную.',
	notifStarted: 'Установка Ollama начата во встроенном терминале. Модели появятся, когда будут готовы.',
	notifFail: 'Не удалось запустить установку Ollama. Повторите или установите вручную.',
	header: 'Установка Ollama (rev 2025-10-30-1)',
	installMethodTitle: 'Способ установки',
	optAuto: 'Авто',
	optBrew: 'Homebrew (macOS)',
	optCurl: 'Скрипт curl (macOS/Linux)',
	optWinget: 'Winget (Windows)',
	optChoco: 'Chocolatey (Windows)',
	btnInstall: 'Установить Ollama',
	btnInstalling: 'Установка…',
	btnRetry: 'Повтор',
	healthy: 'ОК',
	waiting: 'Ожидание',
	autoTune: 'Автонастройка после pull',
	repoIndexer: 'Включить индексатор репозитория',
	headlessBrowse: 'Фоновый браузер',
	headlessTitle:
		'Headless BrowserWindow для лучшего извлечения со сложных страниц. Отключите — будет прямой HTTP.',
	btnCopyLog: 'Копировать журнал',
	btnClear: 'Очистить',
	pullModel: 'Скачать модель:',
	btnPull: 'Скачать',
	btnDelete: 'Удалить',
	groupCode: 'Кодовые модели',
	groupVision: 'Модели зрения (анализ изображений)',
	groupGeneral: 'Универсальные',
	optgroupHint: (label: string) => label,
	warnSelectPull: 'Выберите модель для скачивания.',
	warnSelectDelete: 'Выберите модель для удаления.',
	confirmDelete: (tag: string) => `Удалить модель «${tag}» из Ollama?`,
	step1: '1. Если установка не стартует, скачайте Ollama вручную с [ollama.com/download](https://ollama.com/download).',
	step2: '2. По желанию выполните `ollama pull llama3.1` для стартовой модели.',
	autoDetectNote: 'VibeIDE автоматически находит локально запущенные модели и включает их.',
	pullFailed: (tag: string) => `Не удалось скачать ${tag}. Подробности — в терминале.`,
	pullFailedNotif: (tag: string) => `Не удалось скачать модель «${tag}». См. терминал.`,
	pullOk: (tag: string) => `Модель ${tag} успешно скачана.`,
	pullOkNotif: (tag: string) => `Модель «${tag}» скачана.`,
	pulling: (tag: string) => `Скачивание ${tag}…`,
	deleting: (tag: string) => `Удаление ${tag}…`,
	pullLong: (tag: string) => `Скачивание ${tag}… (большие модели могут идти долго)`,
	pullStartedNotif: (tag: string) => `Начато скачивание «${tag}». Прогресс — в терминале.`,
	deleteOk: (tag: string) => `${tag} удалена.`,
	deleteOkNotif: (tag: string) => `Модель «${tag}» удалена.`,
	deleteFailed: (tag: string, code: number) =>
		`Не удалось удалить ${tag} (код выхода ${code}). См. терминал.`,
	deleteFailedNotif: (tag: string, text: string) =>
		`Не удалось удалить «${tag}»: ${text}. См. терминал.`,
	deleteTimeout: (tag: string) =>
		`Тайм-аут удаления ${tag}. Смотрите терминал, возможно команда ещё выполняется.`,
	deleteTimeoutNotif: (tag: string) =>
		`Тайм-аут удаления «${tag}». Проверьте терминал.`,
	deleteErr: (tag: string, msg: string) => `Ошибка удаления ${tag}: ${msg}`,
	deleteErrNotif: (tag: string, msg: string) => `Не удалось удалить «${tag}»: ${msg}`,
	deleteStartErr: (tag: string, msg: string) => `Не удалось начать удаление: ${msg}`,
	deleteStartErrNotif: (tag: string, msg: string) => `Не удалось начать удаление «${tag}»: ${msg}`,
	pullExitErr: (tag: string, code: number) =>
		`Не удалось скачать ${tag} (код ${code}). См. терминал.`,
	pullExitNotif: (tag: string, text: string) =>
		`Не удалось скачать «${tag}»: ${text}. См. терминал.`,
	pullErr: (tag: string, msg: string) => `Ошибка скачивания ${tag}: ${msg}`,
	pullErrNotif: (tag: string, msg: string) => `Не удалось скачать «${tag}»: ${msg}`,
	pullStartErr: (tag: string, msg: string) => `Не удалось начать скачивание: ${msg}`,
	pullStartErrNotif: (tag: string, msg: string) => `Не удалось начать скачивание «${tag}»: ${msg}`,
	warmIndex: 'Прогрев индекса проекта…',
	warmIndexDone: 'Индекс проекта прогрет.',
} as const;

export const miscS = {
	redoOnboarding: 'Показать экран знакомства?',
	transferFrom: (editor: string) => `Перенести из ${editor}`,
	transferring: 'Перенос…',
	settingsTransferred: 'Настройки перенесены',
	mcpNoTools: 'Нет доступных инструментов',
	mcpCommand: 'Команда:',
	mcpNoServers: 'Серверы не найдены',
	fimExperimental: 'Экспериментально.',
	fimTooltip: 'Рекомендуем самый большой qwen2.5-coder в Ollama (например qwen2.5-coder:3b).',
	fimOnly: 'Только модели с FIM.*',
	enabled: 'Включено',
	disabled: 'Выключено',
	applyDesc: 'Параметры кнопки Apply.',
	sameAsChat: 'Как модель чата',
	differentModel: 'Другая модель',
	toolsTitle: 'Инструменты',
	toolsDesc: 'Инструменты — это функции, которые может вызывать LLM. Некоторые требуют подтверждения.',
	fixLint: 'Учитывать ошибки линтера',
	autoAcceptLlm: 'Авто-принятие правок LLM',
	yoloTitle: 'Режим YOLO',
	yoloDesc:
		'Автоматически применять правки с низким риском без запроса. Опасные правки всегда требуют подтверждения.',
	riskThreshold: 'Порог риска:',
	riskHelp: 'Правки с риском ниже этого порога применяются автоматически (0,0 — безопасно, 1,0 — опасно)',
	confidenceThreshold: 'Порог уверенности:',
	confidenceHelp: 'Правки с уверенностью выше этого порога применяются автоматически (0,0 — неуверенно, 1,0 — уверенно)',
	editorTitle: 'Редактор',
	editorDesc: 'Отображение подсказок VibeIDE в редакторе кода.',
	showSuggestions: 'Показывать подсказки при выделении',
	scmDesc: 'Параметры генератора сообщений коммита.',
	importExportTitle: 'Импорт / экспорт',
	oneClickTitle: 'Перенос одним кликом',
	transferEditorIn: 'Перенесите настройки редактора в VibeIDE.',
	transferVibe: 'Импорт и экспорт настроек и чатов VibeIDE.',
	importSettings: 'Импорт настроек',
	exportSettings: 'Экспорт настроек',
	resetSettings: 'Сбросить настройки',
	importChats: 'Импорт чатов',
	exportChats: 'Экспорт чатов',
	resetChats: 'Сбросить чаты',
	builtinTitle: 'Встроенные параметры',
	builtinDesc: 'Параметры IDE, клавиши и тема.',
	generalSettings: 'Общие параметры',
	keyboardSettings: 'Сочетания клавиш',
	themeSettings: 'Тема',
	openLogs: 'Открыть журналы',
	metricsTitle: 'Метрики',
	metricsDesc:
		'Простая анонимная статистика помогает поддерживать VibeIDE. Можно отказаться ниже. Код, сообщения и ключи API мы не видим.',
	metricsOptOut: 'Отказаться (нужен перезапуск)',
	aiInstrTitle: 'Инструкции для ИИ',
	aiInstrMd: `
Системные инструкции ко всем запросам ИИ.
Правила репозитория — **AGENTS.md** (корень) и **.vibe/rules.md**; откройте **Настройки VibeIDE → Рабочая область**, чтобы править без поиска файлов.
`,
	disableSysMsg: 'Отключить системное сообщение',
	disableSysMsgHint:
		'Если отключено, VibeIDE не добавит в системное сообщение ничего, кроме текста в поле выше.',
	pageTitle: 'Настройки VibeIDE',
	workspaceFold: 'Рабочая область',
	workspaceIntro:
		'Пакет ИИ проекта: `rules.md`, `AGENTS.md`, JSON в корне `.vibe/`, промпты, workflows и навыки.',
	modelsH2: 'Модели',
	projectAiBtn: 'ИИ проекта и рабочая область .vibe…',
	localProvH2: 'Локальные провайдеры',
	localProvBlurb:
		'Любые модели на вашей машине. Локальные модели по умолчанию обнаруживаются автоматически.',
	mainProvH2: 'Облачные провайдеры',
	mainProvBlurb: 'Модели Anthropic, OpenAI, OpenRouter и других провайдеров.',
	featureOptH2: 'Функции',
	generalH2: 'Общие',
	mcpBlurb: 'Model Context Protocol — дополнительные инструменты для режима агента.',
	addMcp: 'Добавить сервер MCP',
	featureOptionsFold: 'Функции',
	importedOk: (t: string) => `${t} успешно импортированы!`,
	importFail: (t: string) => `Не удалось импортировать ${t}`,
	chats: 'Чаты',
	settings: 'Настройки',
} as const;

export const modelDdS = {
	auto: 'Авто',
	autoDetail: 'Автовыбор модели',
	searchModels: 'Быстрый поиск…',
	noModelSearchMatches: 'Нет совпадений',
	noModels: 'Нет доступных моделей',
	enableModel: 'Включите модель в списке',
	addModel: 'Добавьте модель',
	needProvider: 'Нужен провайдер',
} as const;

/** Default skeleton for Workspace → «Цели» — insert button copies this verbatim. */
export const VIBE_GOALS_FORM_EXAMPLE = `# Цели сессии

<!-- vibeVersion: 1.0.0 -->

**Период:** …  

## Сейчас в фокусе

1. …
2. …

## Явные non-goals

- …

## Критерии «готово»

- [ ] …

## Заметки

…

`;

export const workspaceS = {
	reloadDisk: 'Файл изменился на диске. Перезагрузить форму с диска? (Отмена — оставить ваши правки.)',
	overwriteDisk: 'Перезаписать версию на диске вашими правками?',
	fileExceedsBytes: (n: number) => `Файл больше ${n} байт — откройте в редакторе.`,
	savedRules: 'Сохранено .vibe/rules.md',
	savedAgents: 'Сохранено AGENTS.md',
	invalidPromptName: 'Неверное имя промпта — только буквы, цифры, ._-',
	promptExists: (name: string) => `Промпт «${name}» уже существует.`,
	renamePrompt: (a: string, b: string) => `Переименовать /my:${a} → /my:${b}? Старый вызов нужно будет обновить.`,
	renameFailed: (r: string) => `Не удалось переименовать (${r}). Перезагрузите форму, если файл менялся на диске.`,
	savedPromptAs: (name: string) => `Промпт сохранён как ${name}`,
	overwrite: 'Перезаписать на диске?',
	templateExceedsBytes: (n: number) => `Шаблон больше ${n} байт.`,
	savedPrompt: (name: string) => `Промпт сохранён: ${name}`,
	createPromptFailed: (r: string) => `Не удалось создать промпт (${r}).`,
	dupFailed: (d: string) => `Дублирование не удалось (${d}).`,
	deletePrompt: (name: string) => `Удалить промпт «${name}»?`,
	skillTooLarge: 'Файл навыка слишком большой.',
	savedSkill: 'Сохранено SKILL.md',
	invalidFolderId: 'Неверный id папки.',
	folderExists: 'Папка уже существует или не удалось создать.',
	deleteSkillFolder: (id: string) => `Удалить всю папку навыка «${id}»?`,
	discardDirty: 'Отменить несохранённые правки в форме?',
	unsavedReadme: 'Есть несохранённые правки. Перейти к README?',
	noFolder: 'Откройте папку в рабочей области, чтобы править файлы ИИ проекта (.vibe).',
	openFolderHint: 'Файл → Открыть папку, затем вернитесь сюда.',
	editingFolder: 'Папка:',
	switchFolder: 'Сменить папку? Несохранённые правки на этой вкладке могут пропасть.',
	readmeBtn: '.vibe/README…',
	readmeTitle: 'Читать .vibe/README.md (карта папки агента)',
	rulesHint: (maxKb: number) => `Правила проекта в контекст ИИ (файл на диске). Максимум ${maxKb} КБ в этой форме.`,
	rulesTooLarge: 'Файл слишком большой — откройте .vibe/rules.md в редакторе.',
	save: 'Сохранить',
	revert: 'Отменить',
	openEditor: 'Открыть в редакторе',
	agentsHint: 'AGENTS.md в корне рабочей области — не глобальные «Инструкции для ИИ» в разделе «Общие».',
	agentsTooLarge: 'Файл слишком большой — откройте AGENTS.md в редакторе.',
	goalsHint:
		'Файл .vibe/goals.md — цели периода (спринт, неделя, сессия): фокус, non-goals, критерии готовности. Не заменяет детальный план в .vibe/plans/. Контент в чат автоматически не подставляется — процитируйте или попросите агента открыть файл. По умолчанию агент может обновлять файл по вашей просьбе; запрет — deny_write для .vibe/goals.md в constraints.json.',
	goalsTooLarge: 'Файл слишком большой — откройте .vibe/goals.md в редакторе.',
	insertGoalsExample: 'Подставить пример ниже в поле',
	insertGoalsExampleConfirm:
		'Заменить текущее содержимое поля текстом-примером ниже?',
	savedGoals: 'Сохранено .vibe/goals.md',
	promptsHint: 'Шаблоны для `/my:name`. Переменные: `$UPPER_SNAKE` в тексте.',
	addPrompt: 'Добавить промпт',
	duplicate: 'Дублировать',
	delete: 'Удалить',
	noPrompts: 'Нет промптов',
	templateName: 'Имя шаблона (имя файла)',
	promptTooLarge: 'Слишком большой для этой формы.',
	selectPrompt: 'Выберите или создайте промпт',
	workflowsHint:
		'Файлы `.vibe/workflows/*.json` — многошаговые сценарии для чата. Вызов: `/workflow:имя` (как имя файла без `.json`). Поля: `name`, `description`, массив `steps` с объектами `name` и `description`; опционально `requiresApproval`, `toolConstraints`, `allowedModels`.',
	addWorkflow: 'Добавить workflow',
	noWorkflows: 'Нет workflow',
	workflowFileId: 'Идентификатор (имя файла без .json)',
	selectWorkflow: 'Выберите или создайте workflow',
	deleteWorkflowConfirm: (name: string) => `Удалить workflow «${name}»?`,
	savedWorkflow: (name: string) => `Сохранён workflow: ${name}`,
	createWorkflowFailed: (r: string) => `Не удалось создать workflow (${r}).`,
	workflowExists: (name: string) => `Workflow «${name}» уже существует.`,
	renameWorkflowConfirm: (a: string, b: string) =>
		`Переименовать ${a}.json → ${b}.json? При необходимости поправьте поле «name» внутри JSON.`,
	invalidWorkflowJson: 'Невалидный JSON — исправьте перед сохранением.',
	workflowStepCount: (n: number) => `${n} ш.`,
	skillsHint: 'Каталог под `.vibe/skills/` с файлом `SKILL.md`. Поле `name` в YAML — id для `/skill:` (может отличаться от папки).',
	newFolderId: 'Id новой папки',
	createSkill: 'Создать навык',
	noSkills: 'Нет навыков',
	folderFixed: 'Папка (фикс.)',
	skillName: 'Имя навыка (YAML → /skill:)',
	description: 'Описание',
	bodyMd: 'Текст (markdown)',
	skillTooLargeEditor: 'Слишком большой — правьте SKILL.md в редакторе.',
	deleteSkillFolderBtn: 'Удалить папку навыка…',
	selectOrCreateSkill: 'Выберите или создайте навык',
	vibeStructureTab: 'Структура .vibe',
	vibeStructureHint:
		'Быстрое сырое редактирование любого файла под `.vibe/`: дерево слева, промпты и workflows уже на отдельных вкладках. JSON в корне — отдельные кнопки ниже README.',
	noVibeTree: 'Нет содержимого `.vibe/` или папка недоступна.',
	selectStructureFile: 'Выберите файл в дереве',
	savedVibeRelative: (rel: string) => `Сохранено .vibe/${rel}`,
	rootJsonHint: (name: string) =>
		`Файл .vibe/${name}. Ниже — подробная справка по рантайму VibeIDE и пример JSON для копирования.`,
	rootJsonDocFold: 'Справка: как это работает',
	insertRootJsonExample: 'Подставить пример в поле',
	insertRootJsonExampleConfirm:
		'Заменить текущее содержимое поля текстом-примером ниже?',
	backToForms: '← Назад к формам рабочей области',
	readmeH: 'Workspace .vibe/README.md',
	readmeIntro: 'Карта папки `.vibe` в рабочей области. Предпросмотр — при необходимости правьте файл в редакторе.',
	readmeTooLarge: (maxKb: number) =>
		`Файл слишком большой для предпросмотра (> ${maxKb} КБ) — откройте в редакторе.`,
	refreshPreview: 'Обновить предпросмотр',
	editInEditor: 'Править в редакторе',
} as const;
