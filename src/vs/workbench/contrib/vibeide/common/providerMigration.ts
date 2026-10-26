/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Перенос настроек вырезанных встроенных провайдеров на провайдеров из файлов общего набора.
 *
 * OpenCode Go, Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations, Vertex, Azure, Bedrock и «Совместимо с OpenAI API»
 * перестали быть встроенными: их подключают файлы набора `.vibe/providers/*.jsonc`. Человек, у которого был ключ, выбранные
 * модели, адрес или правки моделей под прежним id, не должен получить пустого провайдера и молча сброшенный выбор.
 *
 * Что переезжает:
 * - ключ — в `dynamicProviderApiKeys[<id из файла>]`, туда же его кладёт карточка провайдера; уже введённый ключ не затирается
 * - значения полей карточки (регион и проект Vertex, ресурс и версия API Azure, адрес шлюза Bedrock, адрес и заголовки
 *   «Совместимо с OpenAI API») — в `dynamicProviderParams[<id из файла>]` под именами параметров файла; значение, равное
 *   умолчанию встроенного, не переносится: человек его не вводил
 * - выбор модели по функциям и по ролям агентов, параметры выбора, правки моделей
 * - модели, которые человек включил вручную, — явными переключателями видимости; добавленные им самим (`custom`) — списком
 *   своих моделей провайдера
 *
 * Чистая функция над сырым состоянием, прочитанным из хранилища: тестируется без сервисов и вызывается один раз при чтении.
 * Состояние после переноса прежних записей не содержит, поэтому повторный вызов ничего не делает.
 */

import { CONFIG_ID_OF_VENDOR, ProviderVendor } from './providerVendor.js';

/** Как прежний встроенный провайдер переезжает к провайдеру из файла. */
export interface LegacyProviderMove {
	/** Прежний id встроенного провайдера. */
	readonly legacyId: string;
	/** id провайдера в файле набора. */
	readonly configId: string;
	/** Поле карточки встроенного → имя параметра провайдера из файла. */
	readonly paramOfField?: Readonly<Record<string, string>>;
	/** Значения полей у встроенного по умолчанию: совпавшее с ними не переносится. */
	readonly legacyDefaults?: Readonly<Record<string, string>>;
	/** Приведение значения поля к виду, который ждёт параметр файла (имя параметра → функция). */
	readonly normalize?: Readonly<Record<string, (value: string) => string>>;
	/** Файла такого провайдера в наборе нет: он создаётся в `~/.vibe/providers/` из `MIGRATED_PROVIDER_FILES`. */
	readonly createsFile?: boolean;
}

/** Адрес шлюза с версией пути, как его собирал прежний встроенный Bedrock: без `/v1` на конце дописывается. */
const withVersionSegment = (endpoint: string): string => /\/v1\/?$/.test(endpoint) ? endpoint.replace(/\/+$/, '') : `${endpoint.replace(/\/+$/, '')}/v1`;

const moveOfVendor = (vendor: ProviderVendor, rest: Omit<LegacyProviderMove, 'legacyId' | 'configId'> = {}): LegacyProviderMove =>
	({ legacyId: vendor, configId: CONFIG_ID_OF_VENDOR[vendor], ...rest });

/**
 * Весь список переездов в одном месте: добавить ещё одного вырезанного провайдера — значит дописать строку сюда.
 * OpenCode Go вырезан раньше остальных, его файл набора называется `opencode-go`.
 */
export const LEGACY_PROVIDER_MOVES: readonly LegacyProviderMove[] = [
	{ legacyId: 'openCodeGo', configId: 'opencode-go' },
	moveOfVendor('anthropic'),
	moveOfVendor('openAI'),
	moveOfVendor('gemini'),
	moveOfVendor('xAI'),
	moveOfVendor('mistral'),
	moveOfVendor('groq'),
	moveOfVendor('pollinations'),
	moveOfVendor('googleVertex', { paramOfField: { region: 'region', project: 'project' }, legacyDefaults: { region: 'us-west2' } }),
	// Адрес Bedrock-шлюза: прежнее поле `region` код отправки не читал, переносить в параметры нечего.
	// Прежний код дописывал `/v1` к адресу без него, а файл ждёт адрес целиком
	moveOfVendor('awsBedrock', { paramOfField: { endpoint: 'endpoint' }, normalize: { endpoint: withVersionSegment } }),
	// Версия API Azure не переносится: файл ходит на v1 API, где дата версии в запросе не нужна и датированное значение
	// прежнего встроенного провайдера (`2024-05-01-preview`) на его пути ничего хорошего не сделало бы
	moveOfVendor('microsoftAzure', { paramOfField: { project: 'resource' } }),
	moveOfVendor('openAICompatible', { paramOfField: { endpoint: 'endpoint', headersJSON: 'headersJSON' }, legacyDefaults: { headersJSON: '{}' }, createsFile: true }),
];

interface RawModelSelection {
	providerName?: string;
	modelName?: string;
}

interface RawLegacyModel {
	modelName?: unknown;
	isHidden?: unknown;
	type?: unknown;
}

/** Только те поля сырого состояния, которых касается перенос; остальное проходит мимо. */
export interface ProviderMigratableState {
	settingsOfProvider?: Record<string, ({ models?: ReadonlyArray<RawLegacyModel> } & Record<string, unknown>) | undefined>;
	modelSelectionOfFeature?: Record<string, RawModelSelection | null | undefined>;
	modelSelectionOfRole?: Record<string, RawModelSelection | null | undefined>;
	optionsOfModelSelection?: Record<string, Record<string, unknown> | undefined>;
	overridesOfModel?: Record<string, unknown>;
	dynamicProviderApiKeys?: Record<string, string>;
	dynamicProviderParams?: Record<string, Record<string, string>>;
	dynamicModelHidden?: Record<string, Record<string, boolean>>;
	dynamicCustomModels?: Record<string, string[]>;
}

/** Что перенесено одному провайдеру. */
export interface MovedProvider {
	readonly legacyId: string;
	readonly configId: string;
	readonly movedKey: boolean;
	/** Сколько выборов модели (по функциям и ролям) переведено на провайдера из файла. */
	readonly movedSelections: number;
	/** Сколько вручную включённых моделей перенесено переключателями. */
	readonly movedVisibleModels: number;
	/** Сколько добавленных человеком моделей перенесено в список своих моделей провайдера. */
	readonly movedCustomModels: number;
	/** Имена параметров провайдера из файла, получивших значения. */
	readonly movedParams: readonly string[];
}

export interface ProviderMigrationReport {
	/** Только те провайдеры, с которыми человек что-то делал: пустое стартовое значение переносить нечем и говорить о нём не о чем. */
	readonly moved: readonly MovedProvider[];
	/** Файлы провайдеров, которых нет в наборе и которые надо создать в `~/.vibe/providers/` (`MIGRATED_PROVIDER_FILES`). */
	readonly filesToCreate: readonly string[];
}

/** Файл провайдера, которого в наборе нет: создаётся при переносе, постоянный, с параметрами вместо вписанных значений. */
export interface MigratedProviderFile {
	readonly fileName: string;
	readonly text: string;
}

export const MIGRATED_PROVIDER_FILES: Readonly<Record<string, MigratedProviderFile>> = {
	[CONFIG_ID_OF_VENDOR.openAICompatible]: {
		fileName: `${CONFIG_ID_OF_VENDOR.openAICompatible}.jsonc`,
		text: [
			'// Совместимо с OpenAI API: свой адрес и свои заголовки, ключ вводится в карточке.',
			'// Файл создан при переносе настроек встроенного провайдера с таким именем: встроенных такого вида больше нет.',
			'// Значения (адрес, заголовки, ключ) хранятся в настройках и вводятся в карточке провайдера —',
			'// Настройки → Облачные провайдеры → Свои провайдеры. Для нового провайдера нажмите «Добавить провайдера» там же.',
			'{',
			'  "version": 1,',
			'  "providers": [',
			'    {',
			`      "id": "${CONFIG_ID_OF_VENDOR.openAICompatible}",`,
			'      "name": "Совместимо с OpenAI API",',
			'      "active": true,',
			'      "protocol": "openai",',
			'      "baseURL": "{endpoint}",',
			'      "auth": "bearer",',
			'      "order": 100,',
			'      "params": {',
			'        "endpoint": { "title": "baseURL", "placeholder": "https://my-website.com/v1" },',
			'        "headersJSON": { "title": "Произвольные заголовки", "placeholder": "{ \\"X-Request-Id\\": \\"...\\" }", "as": "headers" }',
			'      },',
			'      "models": { "fetch": true }',
			'    }',
			'  ]',
			'}',
			'',
		].join('\n'),
	},
};

/** Выбор модели переводится на id из файла; там, где id тот же (`anthropic`), выбор остаётся и переносом не считается. */
function moveSelection(selection: RawModelSelection | null | undefined, move: LegacyProviderMove): boolean {
	if (selection && selection.providerName === move.legacyId && move.legacyId !== move.configId) {
		selection.providerName = move.configId;
		return true;
	}
	return false;
}

/** Параметры выбора и правки лежат под id провайдера: переезжают под новый id, то, что там уже есть, не затирается. */
function moveKeyed(container: Record<string, unknown> | undefined, move: LegacyProviderMove): void {
	if (container && Object.hasOwn(container, move.legacyId) && move.legacyId !== move.configId) {
		if (!Object.hasOwn(container, move.configId)) { container[move.configId] = container[move.legacyId]; }
		delete container[move.legacyId];
	}
}

function nonEmpty(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function migrateOne(state: ProviderMigratableState, move: LegacyProviderMove, filesToCreate: Set<string>): MovedProvider | undefined {
	const legacy = state.settingsOfProvider?.[move.legacyId];

	let movedKey = false;
	let movedVisibleModels = 0;
	let movedCustomModels = 0;
	const movedParams: string[] = [];

	if (legacy) {
		const key = nonEmpty(legacy.apiKey);
		const keys = state.dynamicProviderApiKeys ?? (state.dynamicProviderApiKeys = {});
		if (key && !keys[move.configId]?.trim()) {
			keys[move.configId] = legacy.apiKey as string;
			movedKey = true;
		}

		for (const [field, param] of Object.entries(move.paramOfField ?? {})) {
			const value = nonEmpty(legacy[field]);
			if (!value || value === move.legacyDefaults?.[field]) { continue; }
			const params = state.dynamicProviderParams ?? (state.dynamicProviderParams = {});
			const ofProvider = params[move.configId] ?? (params[move.configId] = {});
			if (!ofProvider[param]?.trim()) {
				ofProvider[param] = move.normalize?.[param]?.(value) ?? value;
				movedParams.push(param);
			}
		}

		const hidden = state.dynamicModelHidden ?? (state.dynamicModelHidden = {});
		for (const model of legacy.models ?? []) {
			if (typeof model.modelName !== 'string') { continue; }
			const name = model.modelName;
			if (model.type === 'custom') {
				const custom = state.dynamicCustomModels ?? (state.dynamicCustomModels = {});
				const list = custom[move.configId] ?? (custom[move.configId] = []);
				if (!list.includes(name)) {
					list.push(name);
					movedCustomModels++;
				}
				// Скрытая вручную своя модель остаётся скрытой
				if (model.isHidden === true) {
					(hidden[move.configId] ?? (hidden[move.configId] = {}))[name] = true;
				}
			} else if (model.isHidden === false) {
				const ofProvider = hidden[move.configId] ?? (hidden[move.configId] = {});
				if (!Object.hasOwn(ofProvider, name)) {
					ofProvider[name] = false;
					movedVisibleModels++;
				}
			}
		}
		delete state.settingsOfProvider![move.legacyId];

		if (move.createsFile && movedParams.length > 0) {
			filesToCreate.add(move.configId);
		}
	}

	let movedSelections = 0;
	for (const selection of Object.values(state.modelSelectionOfFeature ?? {})) {
		if (moveSelection(selection, move)) { movedSelections++; }
	}
	for (const selection of Object.values(state.modelSelectionOfRole ?? {})) {
		if (moveSelection(selection, move)) { movedSelections++; }
	}

	for (const options of Object.values(state.optionsOfModelSelection ?? {})) {
		moveKeyed(options, move);
	}
	moveKeyed(state.overridesOfModel, move);

	if (!legacy && movedSelections === 0) {
		return undefined;
	}
	const used = movedKey || movedSelections > 0 || movedVisibleModels > 0 || movedCustomModels > 0 || movedParams.length > 0;
	return used ? { legacyId: move.legacyId, configId: move.configId, movedKey, movedSelections, movedVisibleModels, movedCustomModels, movedParams } : undefined;
}

/**
 * Переносит данные вырезанных встроенных провайдеров на провайдеров из файлов. Меняет `state` на месте.
 * Возвращает отчёт, если у человека было что переносить, иначе `undefined`: свежему профилю уведомление ни к чему.
 * Прежняя запись удаляется всегда, даже пустая, — и там, где id файла совпадает с прежним (`anthropic`): запись старой формы
 * в состоянии выглядела бы заготовкой файлового провайдера.
 */
export function migrateLegacyProviders(state: ProviderMigratableState): ProviderMigrationReport | undefined {
	const moved: MovedProvider[] = [];
	const filesToCreate = new Set<string>();
	for (const move of LEGACY_PROVIDER_MOVES) {
		const result = migrateOne(state, move, filesToCreate);
		if (result) { moved.push(result); }
	}
	if (moved.length === 0 && filesToCreate.size === 0) {
		return undefined;
	}
	return { moved, filesToCreate: [...filesToCreate] };
}

/**
 * Стоит ли сказать человеку о переносе: только если он что-то делал с этими провайдерами. Пустое стартовое значение
 * есть у каждого профиля, и сообщение об «уходе» неиспользованных провайдеров было бы шумом.
 */
export function providerMigrationWorthMentioning(report: ProviderMigrationReport | undefined): report is ProviderMigrationReport {
	return !!report && report.moved.length > 0;
}
