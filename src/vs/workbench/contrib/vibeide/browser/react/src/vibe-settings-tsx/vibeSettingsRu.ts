/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
	budgetFillSuffix: (kept: number, summarized: number) =>
		` · ${kept} целиком / ${summarized} свёрнуто`,
	suggestions: 'Подсказки',
	previousThreads: 'Прошлые чаты',
	chipFile: 'Файл',
	chipModel: 'Модель',
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
		'Автопилот (вкл. по умолчанию): запускать инструменты (правки, удаление, терминал, MCP) без подтверждения. Выключите — подтверждать каждый шаг.',
	rulesLinksRecursiveLabel: 'Ссылки↻',
	rulesLinksRecursiveTitle:
		'Рекурсия по ссылкам в правилах проекта. Вкл — следовать по ссылкам внутри уже подтянутых файлов (с лимитами и защитой от циклов); выкл — только один уровень. Дубль настройки vibeide.projectRules.resolveLinksRecursive.',
	maxLoopIterationsLabel: 'итер.',
	maxLoopIterationsOffLabel: '∞ итер.',
	maxLoopIterationsOffHint: 'лимит снят',
	maxLoopIterationsTitle:
		'Жёсткий потолок итераций tool-use loop в одном агентском прогоне (vibeide.agent.maxLoopIterations). Дефолт 30, диапазон 0–200. 0 = без лимита (до победного). ВАЖНО: отдельно работает «пауза» (soft-checkpoint, справа) — она спрашивает «продолжить?» даже при ∞.',
	iterStepperDec: 'Уменьшить',
	iterStepperInc: 'Увеличить',
	softCheckpointLabel: 'пауза',
	softCheckpointOffLabel: 'без пауз',
	softCheckpointOffHint: 'пауза снята',
	softCheckpointTitle:
		'Soft-checkpoint: после скольких шагов в ОДНОМ прогоне агент паузится и спрашивает «продолжить?» (vibeide.agent.softCheckpointIterations). Работает НЕЗАВИСИМО от лимита итераций слева — срабатывает даже при ∞ как страховка от тихого runaway. Дефолт 0 = без пауз (полная автономия); поставьте, например, 25 для контролируемого режима.',
	autoNudgesLabel: 'подпин.',
	autoNudgesOffLabel: 'без подпин.',
	autoNudgesOffHint: 'автоподпинывание выключено',
	autoNudgesTitle:
		'Автоподпинывание (vibeide.agent.autoContinueMaxNudges): сколько раз ПОДРЯД при включённом автопилоте агент подтолкнёт модель продолжить, если та завершила ход текстом без вызова инструмента (артефакт слабых tool-calling-моделей). Счётчик сбрасывается на каждом выполненном инструменте. 0 = выкл — останавливаться сразу. Дефолт 2.',
	questionNudgesLabel: 'подпин?',
	questionNudgesOffLabel: '∞ подпин?',
	questionNudgesOffHint: 'без лимита',
	questionNudgesTitle:
		'Автоподпин при вопросе (vibeide.agent.autoContinueOnQuestion): если при включённом автопилоте модель завершила ход ВОПРОСОМ (последний символ «?»), агент подтолкнёт её продолжить — не тратит лимит обычных подпинов слева и работает даже при их 0. Значение — сколько вопрос-подпинов ПОДРЯД допускается (счётчик сбрасывается на каждом выполненном инструменте). 0 = без лимита (∞). Дефолт 3.',
	sessionResetTitle: (used: string) =>
		`Сбросить счётчик токенов сессии (израсходовано ${used}). Обнуляет session-лимит безопасности — история чата не затрагивается.`,
	sessionResetAria: 'Сбросить счётчик токенов сессии',
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
	thinkingDisabled: 'off',
	tokensSuffix: 'токенов',
	loadingThinkingAria: 'Думает',
	loadingTypingAria: 'Печатает',
	loadingProcessingAria: 'Обрабатывает',
	loadingDefaultAria: 'Загрузка',
	statusNeedsApproval: 'Нужно подтверждение',
	statusPreparing: 'Подготовка',
	statusRunning: 'Выполняется',
	statusDone: 'Готово',
	providerDegradedTooltip: 'Провайдер нестабилен (серия сбоев за ~10 мин) — кликните, чтобы сменить модель.',
	rejectAllTooltip: 'Отклонить всё',
	acceptAllTooltip: 'Принять всё',
	rejectFileTooltip: 'Отклонить файл',
	acceptFileTooltip: 'Принять файл',
	historyToolbarTitle: 'История чатов',
	historyFilterPlaceholder: 'Фильтр…',
	historySearchPlaceholder: 'Поиск',
	historyEmptyFiltered: 'Нет совпадений',
	historyEmptyState: 'История чатов пуста.',
	historyNoMatches: (q: string) => `Нет совпадений для «${q}»`,
	historyError: 'Ошибка доступа к истории чатов.',
	historyShowMore: (n: number) => `Ещё ${n}…`,
	historyShowLess: 'Свернуть',
	historyScopeThisProject: 'Этот проект',
	historyScopeAllProjects: 'Все проекты',
	historyBadgeOtherProject: 'Другой проект',
	historyBadgeNoProject: 'Без проекта',
	historyMoveToProject: 'Переместить в этот проект',
	historyOtherProjectsHint: (n: number) => `Ещё ${n} в других проектах — нажмите, чтобы показать`,
	historyOtherMatches: (n: number) => `Найдено ещё ${n} в других проектах — показать`,
	historyDateToday: 'Сегодня',
	historyDateYesterday: 'Вчера',
	historyDateLast7: 'Последние 7 дней',
	historyDateLast30: 'Последние 30 дней',
	historyDateOlder: 'Ранее',
	maximizeChatTitle: 'Развернуть чат на всю ширину (повторно — вернуть)',
	maximizeChatAria: 'Развернуть/свернуть чат',
	zenModeTitle: 'Zen-режим: скрыть всё, включая табы (повторно — выйти)',
	zenModeAria: 'Переключить Zen-режим чата',
	bottomChildrenLintErrors: 'Ошибки линтера',
	bottomChildrenError: 'Ошибка',
	reasoningHeader: 'Рассуждение',
	streamingContentAria: 'Стрим контента',
	planRejectTitle: 'Отклонить план',
	planRejectAria: 'Отклонить план',
	planRejectLabel: 'Отклонить',
	planExecuteInAgentTitle: 'Переключиться в режим Агента и выполнить план',
	planExecuteInAgentAria: 'Выполнить план в режиме Агента',
	planExecuteInAgentLabel: 'Выполнить в Агенте',
	planApproveTitle: 'Одобрить и выполнить',
	planApproveAria: 'Одобрить и выполнить план',
	planApproveLabel: 'Одобрить и выполнить',
	planPauseAria: 'Поставить выполнение плана на паузу',
	planPauseLabel: 'Пауза',
	planResumeAria: 'Возобновить выполнение плана',
	planResumeLabel: 'Возобновить',
	agentContinueLabel: 'Продолжить',
	agentContinueTitle: 'Подтолкнуть модель продолжить: она завершила ход текстом без вызова инструмента',
	chatTabNewTooltip: 'Новый чат',
	chatTabCloseTooltip: 'Закрыть вкладку (чат останется в истории)',
	chatTabUntitled: 'Новый чат',
	historyRailTitle: 'История',
	historyCollapseTooltip: 'Свернуть историю (оставить только чат)',
	historyExpandTooltip: 'Показать историю',
	exportChatCopyTooltip: 'Скопировать чат в Markdown (tool-результаты усечены — для полного лога используйте «Экспорт»)',
	exportChatExportTooltip: 'Экспорт чата в .md (полные tool-результаты)',
	exportChatSaveTitle: 'Экспорт чата в Markdown',
	exportChatCopied: 'Чат скопирован в Markdown',
	exportChatSaved: 'Чат экспортирован в .md',
	exportChatEmpty: 'Чат пуст — нечего экспортировать',
	exportChatFailed: 'Не удалось экспортировать чат',
	planAdvisoryReview: 'Совет ревьюера: ',
	planStepAria: (n: number, status: string, desc: string) => `Шаг ${n}, ${status}: ${desc}`,
	budgetFooterSessionLabel: 'Сессия',
	budgetFooterContextLabel: 'Окно',
	budgetFooterDisabled: 'Лимит отключён',
	budgetFooterUnknown: '—',
	budgetFooterResetTitle: 'Сбросить счётчик сессии',
	budgetFooterResetAria: 'Сбросить токены сессии',
	budgetFooterSettingsTitle: 'Открыть Settings → Safety',
	budgetFooterSettingsAria: 'Настройки лимита токенов',
	budgetFooterCounts: (used: string, limit: string, pct: number) => `${used} / ${limit} (${pct}%)`,
} as const;

/** Russian UI strings for ErrorDisplay (sidebar-tsx/ErrorDisplay.tsx). */
export const errorDisplayS = {
	header: 'Ошибка',
	unknown: 'Произошла неизвестная ошибка. Подробности — в журнале.',
	hideDetails: 'Скрыть подробности',
	showDetails: 'Показать подробности',
	dismissAria: 'Закрыть ошибку',
	retryLabel: 'Повторить',
	retryAria: 'Повторить операцию',
	rollbackLabel: 'Откатить',
	rollbackAria: 'Откатить изменения',
	openLogsLabel: 'Открыть журналы',
	openLogsAria: 'Открыть журналы',
	technicalDetails: 'Технические подробности: ',
} as const;

/** Russian UI strings for VibeTooltip (vibe-tooltip/VibeTooltip.tsx). */
export const tooltipS = {
	starterModelsTitle: 'Хорошие стартовые модели',
	forChat: 'Для чата:',
	forAutocomplete: 'Для автодополнения:',
	useLargest: 'По возможности берите самую большую из этих моделей!',
} as const;

/** Russian UI strings for QuickEditChat (quick-edit-tsx/QuickEditChat.tsx). */
export const quickEditS = {
	placeholder: 'Инструкция или / для шаблона…',
	slashHintRow: 'Шаблоны:',
} as const;

const _pluralRu = (n: number, one: string, few: string, many: string): string => {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) { return one; }
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) { return few; }
	return many;
};

/** Russian UI strings for VibeCommandBar (vibe-editor-widgets-tsx/VibeCommandBar.tsx). */
export const commandBarS = {
	filesChanged: (n: number) => `${n} ${_pluralRu(n, 'файл изменён', 'файла изменено', 'файлов изменено')}`,
	nextLabel: 'Далее',
	acceptAll: 'Принять всё',
	rejectAll: 'Отклонить всё',
	acceptFile: 'Принять файл',
	rejectFile: 'Отклонить файл',
	diffOf: (idx: number, total: number) => `Правка ${idx} из ${total}`,
	noChangesYet: 'Изменений пока нет',
	noChanges: 'Нет изменений',
	fileOf: (idx: number, total: number) => `Файл ${idx} из ${total}`,
	filesCount: (n: number) => `${n} ${_pluralRu(n, 'файл', 'файла', 'файлов')}`,
} as const;

/** Russian UI strings for VibeSelectionHelper (vibe-editor-widgets-tsx/VibeSelectionHelper.tsx). */
export const selectionHelperS = {
	addToChat: 'Добавить в чат',
	editInline: 'Править inline',
	disableSuggestions: 'Отключить подсказки?',
} as const;

/** Russian UI strings for util/inputs.tsx (chat input dropdowns and shared widgets). */
export const inputsS = {
	noResultsFound: 'Ничего не найдено',
	enterTextToFilter: 'Введите текст для фильтра…',
	noChangesFound: 'Нет изменений',
	diffChangeOf: (idx: number, total: number) => `Изменение ${idx} из ${total}`,
} as const;

/** Russian UI strings for image/PDF attachments (util/ImageAttachmentChip, ImageMessageRenderer, PDFAttachmentList, PDFMessageRenderer, ImageLightbox). */
export const attachmentsS = {
	imageAttachmentAria: (filename: string, size: string, status: 'uploading' | 'failed' | 'ready') =>
		`Изображение: ${filename}, ${size}. ${status === 'uploading' ? 'Загружается' : status === 'failed' ? 'Ошибка' : 'Готово'}`,
	processing: 'Обработка…',
	cancelUpload: 'Отменить загрузку',
	cancelProcessing: 'Отменить обработку',
	cancel: 'Отмена',
	removeAttachment: (filename: string) => `Удалить ${filename}`,
	retry: 'Повторить',
	loading: 'Загрузка…',
	imageGridAria: (n: number) => `${n} ${_pluralRu(n, 'изображение', 'изображения', 'изображений')}`,
	pdfGridAria: (n: number) => `${n} PDF`,
	imageClickToZoom: (filename: string) => `Изображение: ${filename}. Клик — увеличить.`,
	imageFallbackAlt: (idx: number) => `Изображение ${idx}`,
	pdfAria: (filename: string) => `PDF: ${filename}`,
	pageOf: (filename: string) => `Страница 1 из ${filename}`,
	pagesCount: (n: number) => `${n} ${_pluralRu(n, 'страница', 'страницы', 'страниц')}`,
	morePages: (n: number) => `+${n} ещё`,
	listAria: (n: number, kind: 'image' | 'pdf') =>
		kind === 'image'
			? `${n} ${_pluralRu(n, 'вложение-изображение', 'вложения-изображения', 'вложений-изображений')}`
			: `${n} PDF-${_pluralRu(n, 'вложение', 'вложения', 'вложений')}`,
	lightboxDialogAria: (idx: number, total: number, filename: string) =>
		`Изображение ${idx} из ${total}: ${filename}`,
	lightboxClose: 'Закрыть лайтбокс',
	lightboxPrev: 'Предыдущее изображение',
	lightboxNext: 'Следующее изображение',
	lightboxGoTo: (idx: number) => `Перейти к изображению ${idx}`,
	lightboxCountSuffix: (idx: number, total: number) => `${idx} из ${total}`,
} as const;

/** Russian UI strings for markdown/ApplyBlockHoverButtons.tsx (chat code-block hover buttons). */
export const markdownApplyS = {
	copyIdle: 'Копировать',
	copyDone: 'Скопировано!',
	copyError: 'Не удалось скопировать',
	goToFile: 'Перейти к файлу',
	stop: 'Остановить',
	apply: 'Применить',
	remove: 'Убрать',
	keep: 'Принять',
	done: 'Готово',
	applying: 'Применяю',
	applyErrorNoFile: 'Ошибка VibeIDE: не удалось запустить Apply. Этот блок Apply работает с текущим файлом, но возможно ни один файл не открыт.',
	applyErrorFile: (path: string) => `Ошибка VibeIDE: не удалось запустить Apply. Этот блок Apply работает с ${path}, но файл может не существовать.`,
	applyErrorRuntime: (e: string) => `Ошибка VibeIDE: проблема при выполнении Apply: ${e}.`,
} as const;

/** Russian UI strings for markdown/ChatMarkdownRender.tsx. */
export const chatMarkdownRenderS = {
	unknownToken: 'Неизвестный токен…',
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
				'- **Что это.** Согласованный командой список «что считать ключевым контекстом» — файлы и логические символы. Создаётся `vibeConfigInitService` при первом открытии `.vibe/`.',
				'- **Структура.**',
				'  - **`files`** — пути относительно корня воркспейса (`docs/architecture.md`, `src/domain/core/types.ts`) или glob-паттерны вашей договорённости.',
				'  - **`symbols`** — строковые ключи: имена классов/функций/модулей в принятой команде нотации (например `workspace:ClassName`, `AuthFlow`, `AppService`).',
				'  - **`vibeVersion`** — ориентир для миграций (`' + VV + '`).',
				'- **Где читается в коде.** `vibeUnifiedConfigService` экспонирует поле `pinnedFiles` в snapshot для UI (`vibeUnifiedConfigService.ts` — Phase 2 stub); **автоприклеивания к промпту агента в этом релизе нет**, файл — задел и зафиксированная политика.',
				'- **Отличие от других механизмов.**',
				'  - **`@`-вложения в чате** — точечно прикрепляют конкретный файл к одному сообщению (динамический контекст).',
				'  - **`rules.md` / AGENTS.md** — текст для **GUIDELINES** (правила и стиль).',
				'  - **`pinned.json`** — namespace «важных артефактов», на которые ссылаются rules и которые команда договаривается всегда обсуждать.',
				'- **Практика.** Держите минимальный живой список (5-10 записей). Важное всё равно прикрепляйте `@`-вложением или цитируйте через `rules.md`. Не превращайте файл в bookmark всего проекта — это снизит ценность сигнала.',
			].join('\n');

		case '.window-lock.json':
			return [
				'### Координатор окон VibeIDE — runtime (**.window-lock**)',
				'',
				'- **Что это.** Runtime-арбитраж владельца workspace, когда у вас открыто **несколько окон VibeIDE на одной папке**. Один процесс держит lock + heartbeat (20с cadence / 60с TTL), остальные становятся observer\'ами для `.vibe/`.',
				'- **Редактировать руками не нужно.** Файл пишется и обновляется автоматически через `vibeMultiWindowCoordinatorContribution`. В нём только runtime-поля: `pid`, `startedAtMs`, `lastHeartbeatAtMs`, `windowId`.',
				'- **В git не коммитится** — должен быть в `.gitignore` (по дефолту весь `.vibe/` исключён, кроме `pinned.json` / `rules.md` / `goals.md`; см. wizard `vibe init`).',
				'- **«Застрял» после краша.** Если VibeIDE упал ненормально и при следующем запуске диалог предлагает takeover — нажмите **«Перехватить»**. В крайнем случае при **закрытых** окнах файл можно безопасно удалить вручную — при старте создастся новый.',
				'- **Полная справка:** см. `windowLockPolicy.ts` (`decideWindowRole`, 18 unit-тестов).',
			].join('\n');

		case 'permissions.json':
			return [
				'### Точечные разрешения по путям (**permissions**)',
				'',
				'- **Что это.** Per-file allow/deny исключения **точечно** для отдельных файлов или паттернов. Дополняет `constraints.json` (жёсткие правила всего workspace).',
				'- **Когда использовать.**',
				'  - В `constraints.json` запретили запись в `**/*.env*` целиком, но конкретный `.env.example` хотите оставить редактируемым → запись в `permissions.json`.',
				'  - Отдельный пользователь команды хочет временно разрешить агенту трогать legacy-папку, которая по конвенции запрещена.',
				'- **Структура.** `entries[]` с полями `path`/`pattern`, `effect: "allow" | "deny"`, опционально `until` (ISO-8601), `reason`. Точный формат — в `vibePerFilePermissionsService.ts`.',
				'- **Git-стратегия.** **По умолчанию** `permissions.json` добавляется в `.gitignore` через wizard `vibe init` — это **локальные** исключения отдельного разработчика. Если команда договорилась о общих исключениях — уберите файл из `.gitignore` руками.',
				'- **Приоритет.** `permissions.json` (точечно) перекрывает `constraints.json` (глобально). Внутри файла — последнее совпадение побеждает.',
			].join('\n');

		case 'persona.json':
			return [
				'### Стиль ответа агента (**persona**)',
				'',
				'- **Что это.** Tone-of-voice настройки агента на уровне workspace: краткость, готовность задавать уточняющие вопросы, формат списков, привычные обороты.',
				'- **Основные поля.**',
				'  - **`verbosity`** — `"terse" | "normal" | "verbose"`. Дефолт `normal`.',
				'  - **`ask_before_assume`** — `true` ⇒ агент явно спрашивает при неоднозначности вместо «угадываю и делаю». Дефолт `false`.',
				'  - **`tone`** _(опционально)_ — произвольная строка-описание («строгий ревьюер», «дружелюбный наставник»).',
				'  - **`language`** _(опционально)_ — `"ru" | "en" | …`; перекрывает глобальную `vibeide.agent.responseLanguage`.',
				'- **Где читается.** `vibePersonaService` читает файл и экспонирует значения в `vibeUnifiedConfigService` snapshot; используется при сборке system prompt.',
				'- **Связь с `.vibe/personas/`.** Подкаталог `personas/` хранит **именованные пресеты** (можно переключать через палитру `VibeIDE: Switch Persona`). `persona.json` в корне — **активный** профиль, дефолт workspace.',
				'- **Git-стратегия.** Обычно **коммитится** (команда договаривается об общем стиле). Если хотите личную persona — добавьте в локальный `.gitignore`.',
			].join('\n');

		case 'commands.json':
			return [
				'### Проектные команды (**commands**) — терминальные скрипты с UI-кнопкой',
				'',
				'- **Что это в одной фразе.** Список многоразовых команд проекта (терминал/скрипты), которые видны в **палитре**, в **тулбаре статус-бара** (для `pinned: true`) и могут запускаться вручную или агентом.',
				'',
				'#### Отличие от `/my:` и `/workflow:`',
				'',
				'| Механизм | Файлы | Что делает | Кто исполняет |',
				'|---|---|---|---|',
				'| **`commands.json`** | этот файл | **Запускает shell-команду** в терминале | IDE |',
				'| **`/my:имя`** | `.vibe/prompts/имя.md` | **Подставляет текст** в чат с переменными `$VAR` | LLM |',
				'| **`/workflow:имя`** | `.vibe/workflows/имя.json` | **Многошаговый сценарий** в чат для агента | LLM |',
				'',
				'#### Структура записи',
				'',
				'- **`id`** _(обязательно)_ — латиница, цифры, дефисы; ≤64 символов; уникален в файле.',
				'- **`name`** _(обязательно)_ — отображаемое имя кнопки/пункта палитры.',
				'- **`description`** _(опционально)_ — текст для тултипа и подсказки в палитре.',
				'- **`command`** _(обязательно)_ — исполняемый файл (`npm`, `docker`, `python`).',
				'- **`args[]`** _(опционально)_ — аргументы (`["run", "lint"]`).',
				'- **`cwd`** _(опционально)_ — рабочая папка относительно корня workspace.',
				'- **`env{}`** _(опционально)_ — переменные окружения (`{"DB_ENV": "dev"}`).',
				'- **`shell`** _(опционально, `false` по дефолту)_ — запуск через `/bin/sh -c` / `cmd.exe`. Включайте только если **точно** нужны pipe `|`, `&&`, glob.',
				'- **`terminal`** — `"integrated"` (встроенный VS Code терминал, по дефолту) или `"external"` (системная консоль).',
				'- **`pinned`** _(опционально, `false`)_ — показать кнопку в статус-баре.',
				'- **`order`** _(опционально, `0`)_ — порядок сортировки в тулбаре (слева направо).',
				'- **`icon`** _(опционально)_ — codicon (`zap`, `play`, `rocket`).',
				'',
				'#### Плейсхолдеры и секреты',
				'',
				'- **`$ENV_NAME`** — подставляется значение переменной окружения процесса VibeIDE.',
				'- **`${secret:NAME}`** — подставляется секрет из безопасного хранилища VibeIDE (`safeStorage`). Если значение не задано — команда **не запустится** с уведомлением «отсутствуют значения для плейсхолдеров».',
				'- **Где задать секреты:** палитра `VibeIDE: Manage Secrets` (или через `vibeide.commands.*` команды).',
				'- **Литералы вида `password=...`** в `command`/`args`/`env` — отлавливаются санитайзером (`findSuspiciousLiteralSecrets`) и блокируются с предупреждением.',
				'',
				'#### Как запустить',
				'',
				'1. **Палитра (`Ctrl+Shift+P`)** → начните набирать «Run Project Command» → выбор из Quick Pick.',
				'2. **Статус-бар** — для `pinned: true` команд появится кнопка с именем команды. Левый клик открывает Quick Pick, правый клик → контекстное меню «Run / Edit / Pin/Unpin / Copy command line / Delete».',
				'3. **Хоткей** — если назначен (см. `Ctrl+K Ctrl+S`, фильтр «vibeide.commands»). `allocateDefaultChords` раздаёт default-chord по порядку команд.',
				'4. **Из чата агента** — агент может вызвать команду через `run_project_command` tool (если включён в текущем профиле).',
				'',
				'#### Trust-механика и `commands.trust.json`',
				'',
				'- При первом запуске команды VibeIDE **запрашивает approval** (если команда выглядит подозрительно или впервые видится).',
				'- Approval сохраняется как **FNV-1a хеш формы команды** (`command + args + cwd + env + shell`) в `commands.trust.json`.',
				'- **Любое изменение** одного из этих полей → хеш меняется → потребуется повторное approval.',
				'- `commands.trust.json` редактировать руками **не нужно** — это локальный runtime-файл.',
				'',
				'#### Git-стратегия',
				'',
				'- **`commands.json`** — **коммитится** (команда команды).',
				'- **`commands.trust.json`** — **локальный**, попадает в `.gitignore` через wizard `vibe init` (у каждого разработчика свой trust state).',
				'',
				'#### Безопасность',
				'',
				'- `constraints.json` и санитайзер (`projectCommandsSanitizer.checkCommandConstraints`, `checkCwdTraversal`) применяются **до** запуска.',
				'- `cwd` не может выходить за пределы workspace (anti-traversal).',
				'- `command` сверяется с deny-листами; пользователь видит причину отказа.',
				'',
				'#### Импорт из `.vscode/tasks.json`',
				'',
				'- Палитра → «Import from tasks.json» (`vibeide.commands.importTasksJson`). Diff-preview показывает добавляемые / изменённые / удаляемые команды.',
				'- Импорт-сервис фильтрует подозрительные на секреты записи.',
				'',
				'#### Пример',
				'',
				'```json',
				'{',
				`\t"vibeVersion": "${VV}",`,
				'\t"commands": [',
				'\t\t{',
				'\t\t\t"id": "lint",',
				'\t\t\t"name": "Run lint",',
				'\t\t\t"description": "Запустить ESLint на проекте",',
				'\t\t\t"command": "npm",',
				'\t\t\t"args": ["run", "lint"],',
				'\t\t\t"terminal": "integrated",',
				'\t\t\t"pinned": true,',
				'\t\t\t"order": 10',
				'\t\t},',
				'\t\t{',
				'\t\t\t"id": "deploy-dev",',
				'\t\t\t"name": "Deploy to dev",',
				'\t\t\t"command": "python",',
				'\t\t\t"args": ["scripts/deploy.py", "--env", "$DEPLOY_ENV", "--token", "${secret:DEPLOY_TOKEN}"],',
				'\t\t\t"terminal": "integrated"',
				'\t\t}',
				'\t]',
				'}',
				'```',
			].join('\n');

		case 'commands.trust.json':
			return [
				'### Trust-state проектных команд — runtime (**commands.trust**)',
				'',
				'- **Что это.** Локальный runtime-файл с хешами уже одобренных команд. Привязка: `id → FNV-1a хеш формы команды` (`command + args + cwd + env + shell`).',
				'- **Редактировать руками не нужно.** Файл пишется при approval диалога; любое изменение формы команды в `commands.json` сбрасывает trust для этого id.',
				'- **В git не коммитится** — по дефолту в `.gitignore` (у каждого разработчика свой trust state).',
				'- **Сброс trust:** палитра → «VibeIDE: Revoke Project Command Trust» (`vibeide.commands.revokeTrust`) — удалит запись и потребует повторное approval.',
				'- **Подробности:** см. справку для `commands.json` выше (раздел «Trust-механика»).',
			].join('\n');

		case 'onboarding.json':
			return [
				'### Состояние онбординга — runtime (**onboarding**)',
				'',
				'- **Что это.** Локальный runtime-файл, который отслеживает, какие onboarding-toasts и welcome-шаги пользователь уже видел (чтобы не показывать дважды).',
				'- **Редактировать руками не нужно.** Записывается соответствующими сервисами при показе toast / прохождении шага.',
				'- **Сбросить onboarding:** палитра → `VibeIDE: Reset Project Commands Onboarding` (`vibeide.commands.resetOnboarding`) — заново покажет вводные подсказки про Project Commands.',
				'- **Git-стратегия.** Обычно **в `.gitignore`** (личное состояние). Не критично, если попадёт в коммит — другие просто увидят шаги пройденными.',
			].join('\n');

		default:
			return [
				'### Любой другой `.json` в корне `.vibe/`',
				'',
				`- Сохраняйте **валидный JSON** и поле **vibeVersion** по договорённости команды (сейчас ориентир **${VV}**).`,
				'- Встроенная логика VibeIDE **не импортирует произвольные** корневые JSON — они для скриптов, CI и ваших процессов, пока вы сами их не начнёте читать.',
				'- Если этот файл создан VibeIDE автоматически и непонятно, как им пользоваться — проверьте список руководств: `agent-locks`, `allowed-models`, `constraints`, `pinned`, `permissions`, `persona`, `commands`, `commands.trust`, `onboarding`, `.window-lock`.',
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
	notifications: 'Уведомления',
	safety: 'Безопасность',
	mcp: 'MCP',
	all: 'Все настройки',
} as const;

export const safetyS = {
	sectionTitle: 'Безопасность и диагностика',
	sectionDesc: 'Параметры авто-стэша, маршрутизации моделей по путям и дашборд Performance Guardrails.',

	autostashTitle: 'Auto-stash перед агентским edit',
	autostashDesc: 'Стэш незакоммиченных изменений перед массовыми правками агента. agent-protected target в `vibeide.constraints` всегда выигрывает над `never`.',
	autostashAlways: 'Всегда стэшить',
	autostashAlwaysHint: 'Стэшит даже на «чистом» дереве; гарантирует точку отката, но создаёт лишние stash entries.',
	autostashDirtyOnly: 'Только при «грязном» дереве',
	autostashDirtyOnlyHint: 'Стэш только если есть незакоммиченные изменения. Рекомендуемый default.',
	autostashNever: 'Никогда',
	autostashNeverHint: 'Отключает auto-stash. agent-protected target в constraints обходит этот выбор (защита от потери критических файлов).',

	modelRoutingTitle: 'Per-file маршрутизация моделей',
	modelRoutingDesc: 'Pure helper `modelRoutingByPath` уже принимает правила match→model. Live-редактор правил пока в backlog; используйте `.vibe/model-routing.json` напрямую.',
	modelRoutingEditFile: 'Открыть .vibe/model-routing.json',

	perfGuardrailsTitle: 'Performance Guardrails dashboard',
	perfGuardrailsDesc: 'Сводка trip count / max / avg / threshold по каждому защитному правилу за текущую сессию. Live-агрегатор `perfGuardrailsAggregator` собирает данные; UI-просмотр откроется в Output channel.',
	perfGuardrailsOpen: 'Открыть `vibe doctor --perf`',
	perfGuardrailsBacklog: 'Live dashboard в Settings — backlog (нужны streaming hooks из Performance Guardrails service).',

	// L991-992 — PerfGuardrailsPanel.tsx
	perfPanelTitle: 'Performance Guardrails',
	perfPanelIntro: 'Защитные правила (P95 latency, max memory, max FIM context) фиксируют срабатывания в `vibe doctor --perf` и в Output channel «VibeIDE Perf».',
	perfPanelRefresh: 'Обновить снимок',
	perfPanelOpenOutput: 'Открыть Output channel',
	perfPanelEmpty: 'За текущую сессию ни одно правило не срабатывало.',
	perfPanelColRule: 'Правило',
	perfPanelColTrips: 'Срабатываний',
	perfPanelColAvg: 'Среднее',
	perfPanelColMax: 'Макс.',
	perfPanelColThreshold: 'Порог',

	// L991-992 — MemoryPanel.tsx
	memoryPanelTitle: 'Память сессии',
	memoryPanelIntro: 'Записи, накопленные `VibeSessionMemoryService` за текущую сессию. Они подмешиваются в системный промпт, влияют на edit-risk-vs-confidence и хранятся в `.vibe/session-memory.jsonl`.',
	memoryPanelReload: 'Перечитать с диска',
	memoryPanelClear: 'Очистить (только текущая сессия)',
	memoryPanelClearConfirm: 'Очистить in-memory snapshot? Файл .vibe/session-memory.jsonl останется на диске.',
	memoryPanelEmpty: 'Записей нет — память пустая.',
	memoryPanelColKind: 'Тип',
	memoryPanelColAge: 'Возраст',
	memoryPanelColPreview: 'Содержимое',
	memoryPanelDocsLink: 'Документация: docs/v1/session-memory.md',

	// R.4.1 — Project rules panel
	rulesPanelTitle: 'Правила проекта',
	rulesPanelIntro: 'Найденные правила: `.vibe/rules.md`, `AGENTS.md`, `.vibe/rules/**` (`.md`/`.mdc`). Включённые подмешиваются в системный промпт с метками источника. Условные (`alwaysApply:false` / `globs` / `triggers`) активируются по контексту или через `@rule:<имя>`.',
	rulesPanelReload: 'Перечитать',
	rulesPanelEmpty: 'Правил проекта не найдено.',
	rulesPanelColEnabled: 'Статус',
	rulesPanelColSource: 'Источник',
	rulesPanelColSize: 'Размер',
	rulesPanelOn: 'Вкл',
	rulesPanelOff: 'Выкл',
	rulesPanelRedacted: '(секреты вычищены)',
	rulesPanelDocsLink: 'Клик по источнику — превью содержимого. Тоггл выключает правило только в этом workspace.',
	rulesModeAlways: 'всегда',
	rulesModeTrigger: 'триггер',
	rulesModeGlob: 'glob',
	rulesModeAgent: 'по запросу',
	rulesPanelSummary: (n: number, kb: number, off: number) => `${n} правил · ~${kb} КБ · ${off} выкл`,

	// Settings.tsx — extra (L481 long-tail)
	perfPanelRunDoctorMsg: 'Запустите `npx vibe doctor --perf` в терминале для текстового отчёта.',
	ageLessThanMin: '<1 мин',
	ageMinutes: (n: number) => `${n} мин`,
	ageHours: (n: number) => `${n} ч`,
	ageDays: (n: number) => `${n} дн`,
	modelsCountTotal: (n: number) => `${n} всего`,

	// O.10 — AutoDowngradeOverridesPanel (Tool-call resilience)
	autoDowngradeTitle: 'Auto-detected tool-call overrides',
	autoDowngradeIntro: 'Модели, автоматически переведённые на XML-формат тулов из-за повторных quirk-ошибок (например, эмиссия численных имён тулов "0"/"1"/"5" или пропуск обязательных полей). Действует TTL 7 дней — после этого override снимется и модели снова дадут native function-calling.',
	autoDowngradeEmpty: 'Сейчас все модели работают на дефолтном формате tool-call. Если модель начнёт повторно ломаться на quirks, она автоматически появится здесь.',
	autoDowngradeColProvider: 'Провайдер',
	autoDowngradeColModel: 'Модель',
	autoDowngradeColReason: 'Причина',
	autoDowngradeColAge: 'Обнаружено',
	autoDowngradeColTTL: 'TTL осталось',
	autoDowngradeColActions: 'Действия',
	autoDowngradeRevert: 'Снять',
	autoDowngradePin: 'Закрепить',
	autoDowngradeRevertHint: 'Удалить override полностью — модель попробует native FC на следующем запросе. Если quirk остался, override автоматически вернётся.',
	autoDowngradePinHint: 'Конвертировать auto-detected в manual override — он не истечёт по TTL. Используйте если знаете, что модель навсегда сломана на native FC.',
	autoDowngradeTTLExpired: 'истекло',
	autoDowngradeReasonNumeric: 'Численные имена тулов (minimax/qwen quirk)',
	autoDowngradeReasonMissingField: 'Пропущенные обязательные параметры',
	autoDowngradeReasonWrongName: 'Несуществующие имена тулов',
	autoDowngradeReasonOther: 'Прочие повторные ошибки tool-call',
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
	tooltipVisionAuto: 'Изображения: режим авто — vision определяется по эвристике и каталогу. Кликните, чтобы включить принудительно (полезно для новой vision-модели, которую эвристика ещё не знает).',
	tooltipVisionForcedOn: 'Изображения включены принудительно для этой модели. Кликните, чтобы выключить.',
	tooltipVisionForcedOff: 'Изображения выключены принудительно для этой модели — полезно, если провайдер заявляет vision, но молча игнорирует картинку. Кликните, чтобы вернуть режим авто.',
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
	/** Inline pill rendered next to free models (Pollinations + `:free`-suffixed ids). */
	freeBadgeLabel: 'free',
	freeBadgeTooltip: 'Бесплатная модель',
} as const;

export const providersS = {
	dynamicProvidersTitle: 'Свои провайдеры (из .vibe/providers.json)',
	// Dynamic-provider key validation status (shown under the key field in the provider card).
	dynKeyValid: 'Ключ действителен',
	dynKeyInvalid: 'Ключ недействителен (ошибка авторизации)',
	dynKeyError: 'Не удалось проверить ключ (сеть или сервер)',
	dynKeyPending: 'Проверка ключа…',
	dynKeyUnverified: 'Ключ не проверяется (static-список)',
	dynKeyNone: 'Ключ не задан',
	dynKeySrcPrefix: 'источник',
	dynKeySrc: { gui: 'введён в IDE', env: '.vibe/.env', ref: 'apiKeyRef', none: '—' } satisfies Record<string, string>,
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

export const notifyS = {
	sectionTitle: 'Звуковые уведомления',
	sectionDesc: 'Короткий звук, когда агент завершил ход, встал или ждёт вашего ответа. По умолчанию звучит, только когда окно IDE не в фокусе.',
	enabledLabel: 'Проигрывать звук уведомления',
	soundTitle: 'Звук',
	soundHint: 'Нажмите на вариант, чтобы выбрать и прослушать.',
	previewTooltip: 'Прослушать',
	customLabel: 'Свой файл',
	customNotSet: 'Файл не выбран',
	browseBtn: 'Обзор…',
	browseDialogTitle: 'Выберите звуковой файл уведомления',
	customRules: 'Форматы: mp3, ogg, wav. Лимиты: до 1 МБ, до 5 секунд.',
	customRejected: (reason: string) => `Файл не принят: ${reason}`,
	customAccepted: 'Свой звук установлен.',
	volumeTitle: 'Громкость',
	muteWhenFocusedLabel: 'Молчать, когда окно IDE в фокусе',
	eventsTitle: 'Когда звучать',
	onCompleteLabel: 'Ход завершён',
	onStalledLabel: 'Прогон встал («Продолжить»)',
	onAwaitingUserLabel: 'Агент ждёт ответа или подтверждения',
	// Default-sound display names — mirror the config enumDescriptions.
	soundNames: {
		taskCompleted: 'Завершение задачи',
		success: 'Успех',
		chatUserActionRequired: 'Требуется действие',
		terminalBell: 'Звонок терминала',
		break: 'Короткий сигнал',
	} satisfies Record<string, string>,
	// «VibeIDE Звуки» modal (brain menu)
	modalTitle: 'VibeIDE Звуки',
	deleteTooltip: 'Удалить',
	customBadge: 'свой',
	noCustoms: 'Своих звуков пока нет — загрузите трек ниже и вырежьте фрагмент.',
	customDeletedReset: 'Выбранный свой звук удалён — включён стандартный.',
	editorTitle: 'Загрузить и обрезать свой трек',
	editorHint: (maxSec: number, maxMb: string) => `Тащите бегунок над дорожкой или кликните по дорожке, чтобы навести окно (до ${maxSec} с); края окна меняют длину. Входной файл — до ${maxMb} МБ; сохранится моно-WAV в папку sounds.`,
	editorScrubTip: 'Перетащите диапазон по треку',
	editorLoad: 'Загрузить трек',
	editorTooBig: (maxMb: string) => `Файл слишком большой (лимит ${maxMb} МБ). Возьмите трек покороче.`,
	editorDecodeFail: 'Не удалось декодировать аудио. Поддерживаются mp3, ogg, wav.',
	editorSelection: (start: string, end: string, len: string) => `Выделено: ${start}–${end} с (${len} с)`,
	editorPreview: 'Прослушать фрагмент',
	editorStop: 'Остановить',
	editorSave: 'Сохранить',
	editorSaved: 'Фрагмент сохранён и выбран.',
	editorSaveFail: 'Не удалось сохранить фрагмент.',
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
	chatDisplayTitle: 'Чат',
	chatDisplayDesc: 'Отображение элементов в окне чата.',
	showChatTimestamps: 'Показывать дату и время сообщений',
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
	builtinProvidersToggle: (n: number) => `Встроенные провайдеры (${n})`,
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
	// Provenance tooltips for dynamic-provider models (.vibe/providers.json), shown on the "✎" badge.
	fileNoteOverride: 'Параметры модели заданы в .vibe/providers.json',
	fileNoteManual: 'Модель добавлена в .vibe/providers.json (нет в каталоге провайдера)',
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
	runtimeJsonGroupLabel: 'Runtime (read-only)',
	runtimeJsonTooltip: 'Служебный файл VibeIDE: пишется автоматически, редактирование вручную не рекомендуется',
	pcJsonActionsLabel: 'Действия:',
	pcJsonOpenForm: '+ Новая команда (форма)',
	pcJsonOpenFormTip: 'Открыть подкатегорию Project Commands и развернуть inline-форму добавления',
	pcJsonOpenTable: 'Открыть таблицу',
	pcJsonOpenTableTip: 'Перейти к подкатегории Project Commands с таблицей всех команд',
	pcJsonOpenPalette: 'Запустить из палитры',
	pcJsonOpenPaletteTip: 'Открыть Quick Pick: VibeIDE: Run Project Command',
	pcJsonReload: 'Перечитать',
	pcJsonReloadTip: 'Перечитать .vibe/commands.json с диска (vibeide.commands.reload)',
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
	// L480 long-tail — sub-tab pill labels for workspace forms
	pillRules: 'Правила (.vibe/rules.md)',
	pillAgents: 'Агенты (AGENTS.md)',
	pillGoals: 'Цели (.vibe/goals.md)',
	pillPrompts: 'Промпты (.vibe/prompts)',
	pillWorkflows: 'Workflows (.vibe/workflows)',
	pillSkills: 'Навыки (.vibe/skills)',
	pillProjectCommands: 'Project Commands (.vibe/commands.json)',
	// Project Commands surface (roadmap §"Project Commands" — Settings group)
	pcGroupTitle: 'Project Commands',
	pcGroupIntro: 'Workspace-first shell-команды из `.vibe/commands.json`. Видны в палитре `VibeIDE: Run Project Command` и (при `pinned: true`) в верхнем баре.',
	pcCountLabel: (n: number) => `Загружено команд: ${n} · закреплено: `,
	pcPinnedCount: (n: number) => `${n}`,
	pcToolbarPositionLabel: 'Где показывать закреплённые команды',
	pcToolbarPositionTitlebar: 'В title-bar (слева)',
	pcToolbarPositionStatusbar: 'В статус-баре (справа)',
	pcToolbarPositionHidden: 'Скрыто (только палитра/шорткаты)',
	pcMaxPinnedLabel: 'Макс. кнопок в баре:',
	pcMaxPinnedHint: 'диапазон 1–20; остальные команды доступны из палитры',
	// Form (standalone Add/Edit modal) — labels and messages
	pcFormAddTitle: 'Новая команда .vibe/commands.json',
	pcFormEditTitle: (id: string) => `Редактирование команды «${id}»`,
	pcFormIntro: 'Заполните поля и нажмите «Сохранить». Изменения пишутся в .vibe/commands.json и сразу подхватываются в палитре, статус-баре и menubar.',
	pcFormCancel: 'Отмена',
	pcFormSaveAdd: 'Сохранить и добавить',
	pcFormSaveEdit: 'Сохранить изменения',
	pcFormSaveBusy: 'Сохраняю…',
	pcFormHasErrors: 'есть ошибки валидации',
	pcFormPreviewToggle: 'Предпросмотр JSON',
	pcFieldId: 'id',
	pcFieldIdHint: 'латиница в нижнем регистре, цифры, дефисы; до 64 символов; уникален в файле',
	pcFieldName: 'Имя',
	pcFieldDescription: 'Описание',
	pcFieldDescriptionPlaceholder: 'Опционально (для тултипа в палитре и menubar)',
	pcFieldCommand: 'Команда',
	pcFieldArgs: 'Аргументы',
	pcFieldArgsHint: 'по одному в строке (пустые строки игнорируются)',
	pcFieldCwd: 'cwd',
	pcFieldCwdPlaceholder: 'относительный путь от корня workspace',
	pcFieldCwdHint: 'абсолютные пути и «..» запрещены',
	pcFieldTerminal: 'Где запускать',
	pcFieldPinned: 'Закрепить в статус-баре (pinned)',
	pcFieldOrder: 'Порядок',
	pcFieldOrderHint: 'целое число; меньше — левее в баре',
	pcTerminalDefault: '— по умолчанию (встроенный) —',
	pcTerminalIntegrated: 'Встроенный терминал',
	pcTerminalExternal: 'Внешняя консоль',
	pcTerminalBackground: 'Фоновый процесс (без UI)',
	pcEditMissing: 'Не найдено: возможно, команда удалена внешним инструментом.',
	pcAddDone: (name: string) => `Команда «${name}» добавлена в .vibe/commands.json.`,
	pcEditDone: (name: string) => `Команда «${name}» обновлена в .vibe/commands.json.`,
	pcSaveFailed: (reason: string) => `Не удалось сохранить: ${reason}`,
	pcDeleteConfirmTitle: (name: string) => `Удалить команду «${name}»?`,
	pcDeleteConfirmDetail: 'Запись будет удалена из .vibe/commands.json. Откатить можно только через git.',
	pcDeleteOk: 'Удалить',
	pcDeleteCancel: 'Отмена',
	pcDeleteMissing: 'Команда не найдена в workspace .vibe/commands.json (возможно, она из global-источника).',
	pcDeleteDone: (name: string) => `Команда «${name}» удалена.`,
	pcOpenJson: 'Открыть .vibe/commands.json',
	pcImportTasks: 'Импорт из .vscode/tasks.json',
	pcImportUrl: 'Импорт из URL',
	pcReload: 'Перечитать с диска',
	pcAddNew: '+ Новая команда',
	pcOpenPalette: 'Открыть палитру',
	pcOpenEditor: 'Полный редактор',
	// Project Commands — table (Прогон 3)
	pcTableTitle: 'Команды',
	pcTableFilterPlaceholder: 'Фильтр по id / name / command…',
	pcTableEmpty: 'Команды не загружены. Нажмите «+ Новая команда» или импортируйте из tasks.json.',
	pcTableEmptyFiltered: 'Под фильтр ничего не подходит.',
	pcTableColId: 'id',
	pcTableColName: 'Имя',
	pcTableColCommand: 'Команда',
	pcTableColPinned: 'Pin',
	pcTableColOrder: 'Порядок',
	pcTableColActions: 'Действия',
	pcRowRun: 'Запустить',
	pcRowRunTip: 'Выполнить команду в терминале',
	pcRowCopy: 'Копировать',
	pcRowCopyTip: 'Копировать shell-строку в буфер',
	pcRowPin: 'Закрепить',
	pcRowPinTip: 'Закрепить в верхнем баре',
	pcRowUnpin: 'Открепить',
	pcRowUnpinTip: 'Открепить из верхнего бара',
	pcRowEdit: 'Редактировать',
	pcRowEditTip: 'Открыть форму редактирования команды',
	pcRowDelete: 'Удалить',
	pcRowDeleteConfirm: (name: string) => `Удалить команду «${name}» из .vibe/commands.json? Действие нельзя отменить из UI (но файл в git).`,
	pcRowGlobalOnly: 'Команда из global-источника — изменять можно только в исходном файле.',
	pcRowCopyDone: 'Скопировано в буфер.',
	pcRowRunRefused: (reason: string) => `Запуск отклонён: ${reason}`,
	pcRowRunFailure: (reason: string) => `Команда упала: ${reason}`,
	// Project Commands — Add form (Прогон 3)
	pcAddFormToggleOpen: 'Скрыть форму',
	pcAddFormToggleClosed: '+ Новая команда (форма)',
	pcAddFormTitle: 'Добавить команду в .vibe/commands.json',
	pcAddFieldId: 'id',
	pcAddFieldIdHint: 'Латиница / цифры / дефис; ≤64; должен быть уникален.',
	pcAddFieldName: 'Имя',
	pcAddFieldNameHint: 'Отображается в палитре и на кнопке.',
	pcAddFieldDescription: 'Описание (опционально)',
	pcAddFieldCommand: 'Исполняемый файл',
	pcAddFieldCommandHint: 'Например: npm, docker, python.',
	pcAddFieldArgs: 'Аргументы (по одному на строку)',
	pcAddFieldArgsHint: 'Пустые строки игнорируются. Плейсхолдеры $ENV / ${secret:KEY}.',
	pcAddFieldCwd: 'Рабочая папка (cwd, относительная)',
	pcAddFieldCwdHint: 'Относительно корня workspace. Абсолютные пути и `..` запрещены.',
	pcAddFieldTerminal: 'Терминал',
	pcAddTerminalDefault: '— по умолчанию (integrated) —',
	pcAddTerminalIntegrated: 'integrated (встроенный)',
	pcAddTerminalExternal: 'external (системная консоль)',
	pcAddTerminalBackground: 'background (без UI)',
	pcAddFieldPinned: 'Закреплено в верхнем баре (pinned)',
	pcAddFieldOrder: 'Порядок (опционально, целое)',
	pcAddFieldOrderHint: 'Меньше — левее. Пусто ⇒ команда уходит в конец.',
	pcAddPreviewTitle: 'Предпросмотр JSON-записи',
	pcAddSave: 'Сохранить в commands.json',
	pcAddCancel: 'Отмена',
	pcAddSaveSuccess: (id: string) => `Команда «${id}» добавлена. Файл .vibe/commands.json обновлён.`,
	pcAddSaveError: (reason: string) => `Не удалось сохранить: ${reason}`,
	pcAddNoWorkspace: 'Откройте папку workspace, чтобы добавить команду.',
	// Field error messages (mapped from AddCommandErrorCode)
	pcErrIdMissing: 'Укажите id.',
	pcErrIdPattern: 'Только латиница / цифры / дефис; ≤64 символов; не начинается с дефиса.',
	pcErrIdDuplicate: 'Такой id уже используется.',
	pcErrNameMissing: 'Укажите имя.',
	pcErrCommandMissing: 'Укажите исполняемый файл.',
	pcErrCwdAbsolute: 'cwd должен быть относительным (без `/`, диска).',
	pcErrCwdTraversal: 'cwd не может содержать `..` (выход за пределы workspace).',
	pcErrOrderNotNumber: 'Порядок — целое число (или пусто).',
	exampleSkeletonMarkup: 'Пример разметки (скелет для копирования)',
	exampleSkeleton: 'Пример (скелет для копирования)',
	skillsHintLine1Prefix: 'Каталог под ',
	skillsHintLine1Mid: ' с файлом ',
	skillsHintLine1Suffix: '.',
	skillsHintLine2Prefix: 'Поле ',
	skillsHintLine2Mid: ' в YAML — id для ',
	skillsHintLine2Suffix: ' (может отличаться от папки).',
	// New workflow template literals (insert when creating a new workflow file)
	workflowTplDescription: 'Опишите многошаговый сценарий для агента.',
	workflowTplStepName: 'Шаг 1',
	workflowTplStepDescription: 'Что сделать на этом шаге.',
} as const;

/** Russian UI strings for CommandsEditorPanel.tsx (L316). */
export const commandsEditorS = {
	title: 'Project Commands — редактор',
	toggleToJson: 'Переключить на JSON',
	toggleToForm: 'Переключить на формы',
	reload: 'Перечитать с диска',
	save: 'Сохранить',
	addCommand: '+ Добавить команду',
	deleteCommand: 'Удалить команду',
	selectOrAdd: 'Выберите команду слева или добавьте новую.',
	unnamed: '(без имени)',
	noWorkspace: 'Откройте рабочую папку — `.vibe/commands.json` создаётся в корне.',
	loadParseFailed: 'Ошибка парсинга `.vibe/commands.json`',
	loadDecodeFailed: 'Ошибка валидации `.vibe/commands.json`',
	saveDecodeFailed: 'Не сохранено: ошибка валидации схемы',
	jsonParseFailed: 'JSON: ошибка парсинга',
	toggleParseFailed: 'Переключение не выполнено: текущий JSON не парсится',
	toggleDecodeFailed: 'Переключение не выполнено: схема не валидна',
	saveDone: '`.vibe/commands.json` сохранён.',
	fixErrors: 'Исправьте ошибки в полях перед сохранением.',
	duplicateId: (id: string) => `Дублирующийся id «${id}». Идентификаторы команд должны быть уникальными.`,
	secretSuspect: (name: string, where: string) =>
		`«${name}»: подозрение на plaintext-секрет в ${where}. Используйте \${secret:KEY} вместо инлайнового значения.`,
	fieldId: 'id (slug, [a-z0-9-])',
	fieldName: 'Имя (видно в палитре)',
	fieldCommand: 'Команда (исполняемый файл)',
	fieldDescription: 'Описание',
	fieldArgs: 'Аргументы (по одному в строке)',
	fieldCwd: 'cwd (относительно корня workspace)',
	fieldEnv: 'env (KEY=VALUE по строкам)',
	fieldPinned: 'pinned',
	fieldSingleton: 'singleton',
	fieldConfirm: 'confirm',
} as const;
