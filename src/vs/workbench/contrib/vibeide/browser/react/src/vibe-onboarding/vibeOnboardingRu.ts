/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import type { FeatureName, ProviderName } from '../../../../common/vibeideSettingsTypes.js';

export const tabNames = ['Free', 'Paid', 'Local'] as const;
export type TabName = typeof tabNames[number] | 'Cloud/Other';

export const onboardingS = {
	heroLogoAlt: 'Логотип VibeIDE',
	welcomeHighlights: [
		'Чат и быстрое редактирование',
		'Быстрое применение диффов',
		'Загрузка PDF и изображений',
		'Локальные и облачные модели',
	] as readonly string[],
	welcomeStats: [
		{ label: 'Вложения', value: 'PDF и изображения', detail: 'Кидайте ТЗ, скриншоты и заметки прямо в чат.' },
		{ label: 'Быстрое применение', value: 'Построчно', detail: 'Утверждайте каждое изменение из того же диффа, что его сгенерировал.' },
		{ label: 'Роутер моделей', value: 'Автовыбор', detail: 'Anthropic, GPT-4o, Gemini, DeepSeek или Ollama — под задачу.' },
		{ label: 'Надстройки VibeIDE', value: 'Больше из коробки', detail: 'Fast Apply, вложения и подсказки с учётом SCM без плагинов.' },
	] as ReadonlyArray<{ label: string; value: string; detail: string }>,
	tabLabel: {
		Free: 'Бесплатно',
		Paid: 'Платно',
		Local: 'Локально',
		'Cloud/Other': 'Облако / другое',
	} satisfies Record<TabName, string>,
	tabDescription: {
		Free: 'OpenCode Zen и другие провайдеры с бесплатным уровнем — OpenRouter, Gemini, Pollinations. Добавляйте сколько нужно.',
		Paid: 'Прямое подключение к любому провайдеру (свой API-ключ).',
		Local: 'Активные провайдеры подхватываются автоматически. Добавляйте сколько нужно.',
		'Cloud/Other': 'Добавляйте сколько нужно. Для нестандартной конфигурации — свяжитесь с нами.',
	} satisfies Record<TabName, string>,
	featureLabel: [
		{ display: 'Чат', featureName: 'Chat' },
		{ display: 'Быстрое редактирование', featureName: 'Ctrl+K' },
		{ display: 'Автодополнение', featureName: 'Autocomplete' },
		{ display: 'Быстрое применение', featureName: 'Apply' },
		{ display: 'Контроль версий', featureName: 'SCM' },
	] as ReadonlyArray<{ display: string; featureName: FeatureName }>,
	step2Label: 'Шаг 2',
	step2Title: 'Выберите провайдеры моделей',
	step2Lead: 'Подключите несколько провайдеров сразу: VibeIDE направляет Чат, быстрое редактирование и автодополнение на сильнейшую модель под каждый запрос.',
	connectModelPrompt: 'Подключите хотя бы одну модель с поддержкой чата перед продолжением.',
	requiredFieldsTooltip: 'Заполните все обязательные поля или выберите другого провайдера.',
	tagSmart: 'Модели с лучшими показателями на бенчмарках.',
	tagPrivate: 'На вашем ПК или в локальной сети — данные не уходят наружу.',
	tagCheap: 'Бесплатные и недорогие варианты.',
	tagAgent: 'Максимально способные, удобны для агентного режима.',
	// L481 long-tail — onboarding additions
	featureCoverage: 'Покрытие функций',
	statusConnected: 'Подключено',
	statusPending: 'Ожидает',
	addProviderTitle: (title: string) => `Добавить ${title}`,
	moreInfo: 'Подробнее',
	localBadge: 'Локально',
	modelsHeading: 'Модели',
	localModelsHint: 'Локальные модели по возможности определяются автоматически. Добавьте записи вручную для тонкой настройки роутинга.',
	nextBtn: 'Далее',
	previousBtn: 'Назад',
	welcomeKicker: 'Добро пожаловать',
	heroTitle: 'Сборка там, где ИИ уже встроен в редактор',
	heroLead: 'VibeIDE держит чат, быстрое редактирование, Fast Apply и работу с репозиторием в одной тёмной среде — с нативной загрузкой PDF и изображений, чтобы ТЗ и макеты всегда были вместе с разговором.',
	startSetup: 'Начать настройку',
	skipBtn: 'Пропустить',
	startInVibe: 'Начать в VibeIDE',
	tagPrivateDetail: 'Приватный хостинг: данные не покидают ваш компьютер или сеть. [Напишите нам](mailto:founders@voideditor.com) для помощи с развёртыванием в компании.',
	tagCheapDetail: 'Выгодные тарифы вроде Gemini 2.5 Pro или свой хостинг через Ollama и vLLM бесплатно.',
	settingsAndThemes: 'Настройки и темы',
	transferFromOther: 'Перенести настройки из другого редактора?',
	providerTooltip: (providerName: ProviderName): string => {
		switch (providerName) {
			case 'openCodeZen':
				return 'OpenCode Zen: отобранные модели через opencode.ai/zen; бесплатные модели указаны в документации (MiniMax M2.5 Free, Ling 2.6 Flash и др.).';
			case 'openCodeGo':
				return 'OpenCode Go: подписка Go на том же аккаунте Zen; модели и endpoint /zen/go — см. dev.opencode.ai/docs/go.';
			case 'minimax':
				return 'MiniMax: прямой OpenAI-совместимый API. Флагман MiniMax-M3 (контекст 1M, мультимодальная, thinking переключается). Ключ на platform.minimax.io.';
			case 'gemini':
				return 'Gemini 2.5 Pro — до 25 бесплатных чатов в день, Flash — около 500. При нехватке кредитов можно перейти на платный тариф.';
			case 'openRouter':
				return 'OpenRouter: до 50 бесплатных чатов в день (1000 при депозите $10) на моделях с тегом :free.';
			case 'pollinations':
				return 'Дешёвый API со множеством моделей (кредиты Pollen). Ключ на enter.pollinations.ai.';
			default:
				return '';
		}
	},
} as const;
