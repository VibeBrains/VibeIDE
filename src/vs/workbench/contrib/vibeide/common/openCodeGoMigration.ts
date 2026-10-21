/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Перенос настроек OpenCode Go с встроенного провайдера на провайдера из файла.
 *
 * OpenCode Go перестал быть встроенным: его подключает файл общего набора `.vibe/providers/opencode-go.jsonc`
 * (id `opencode-go`). Пользователь, у которого был свой ключ, выбранные модели или правки моделей под старым id `openCodeGo`,
 * не должен получить пустого провайдера и молча сброшенный выбор.
 *
 * Что переезжает:
 * - ключ — в `dynamicProviderApiKeys['opencode-go']`, туда же его кладёт карточка провайдера из файла;
 *   ключ, который уже введён у провайдера из файла, не затирается
 * - выбор модели по функциям и по ролям агентов, параметры выбора, правки моделей
 * - модели, которые человек включил вручную (`isHidden: false`) — как явные переключатели видимости
 *
 * Чистая функция над сырым состоянием, прочитанным из хранилища: тестируется без сервисов и вызывается один раз при чтении.
 * Состояние после переноса `openCodeGo` не содержит, поэтому повторный вызов ничего не делает.
 */

/** Прежний id встроенного провайдера. */
export const LEGACY_OPENCODE_GO_ID = 'openCodeGo';

/** id провайдера в файле набора (`providers/opencode-go.jsonc`). */
export const OPENCODE_GO_CONFIG_ID = 'opencode-go';

interface RawModelSelection {
	providerName?: string;
	modelName?: string;
}

/** Только те поля сырого состояния, которых касается перенос; остальное проходит мимо. */
export interface OpenCodeGoMigratableState {
	settingsOfProvider?: Record<string, { apiKey?: unknown; models?: ReadonlyArray<{ modelName?: unknown; isHidden?: unknown }> } | undefined>;
	modelSelectionOfFeature?: Record<string, RawModelSelection | null | undefined>;
	modelSelectionOfRole?: Record<string, RawModelSelection | null | undefined>;
	optionsOfModelSelection?: Record<string, Record<string, unknown> | undefined>;
	overridesOfModel?: Record<string, unknown>;
	dynamicProviderApiKeys?: Record<string, string>;
	dynamicModelHidden?: Record<string, Record<string, boolean>>;
}

export interface OpenCodeGoMigrationReport {
	/** Ключ был и перенесён к провайдеру из файла. */
	readonly movedKey: boolean;
	/** Сколько выборов модели (по функциям и ролям) переведено на провайдера из файла. */
	readonly movedSelections: number;
	/** Сколько вручную включённых моделей перенесено как явные переключатели. */
	readonly movedVisibleModels: number;
}

function moveSelection(selection: RawModelSelection | null | undefined): boolean {
	if (selection && selection.providerName === LEGACY_OPENCODE_GO_ID) {
		selection.providerName = OPENCODE_GO_CONFIG_ID;
		return true;
	}
	return false;
}

/**
 * Переносит данные `openCodeGo` в состояние провайдера из файла. Меняет `state` на месте.
 * Возвращает отчёт, если у пользователя было что переносить, иначе `undefined`: свежему профилю уведомление ни к чему.
 */
export function migrateOpenCodeGoState(state: OpenCodeGoMigratableState): OpenCodeGoMigrationReport | undefined {
	const legacy = state.settingsOfProvider?.[LEGACY_OPENCODE_GO_ID];

	let movedKey = false;
	let movedVisibleModels = 0;
	if (legacy) {
		const key = typeof legacy.apiKey === 'string' ? legacy.apiKey.trim() : '';
		const keys = state.dynamicProviderApiKeys ?? (state.dynamicProviderApiKeys = {});
		if (key && !keys[OPENCODE_GO_CONFIG_ID]?.trim()) {
			keys[OPENCODE_GO_CONFIG_ID] = legacy.apiKey as string;
			movedKey = true;
		}
		const visible = (legacy.models ?? []).filter(m => m.isHidden === false && typeof m.modelName === 'string');
		if (visible.length > 0) {
			const hidden = state.dynamicModelHidden ?? (state.dynamicModelHidden = {});
			const ofProvider = hidden[OPENCODE_GO_CONFIG_ID] ?? (hidden[OPENCODE_GO_CONFIG_ID] = {});
			for (const model of visible) {
				const name = model.modelName as string;
				if (!(name in ofProvider)) {
					ofProvider[name] = false;
					movedVisibleModels++;
				}
			}
		}
		delete state.settingsOfProvider![LEGACY_OPENCODE_GO_ID];
	}

	let movedSelections = 0;
	for (const selection of Object.values(state.modelSelectionOfFeature ?? {})) {
		if (moveSelection(selection)) { movedSelections++; }
	}
	for (const selection of Object.values(state.modelSelectionOfRole ?? {})) {
		if (moveSelection(selection)) { movedSelections++; }
	}

	// Параметры выбора (уровень рассуждения) и правки моделей лежат под id провайдера: то, что уже есть у нового id, не затирается
	for (const options of Object.values(state.optionsOfModelSelection ?? {})) {
		if (options && LEGACY_OPENCODE_GO_ID in options) {
			if (!(OPENCODE_GO_CONFIG_ID in options)) { options[OPENCODE_GO_CONFIG_ID] = options[LEGACY_OPENCODE_GO_ID]; }
			delete options[LEGACY_OPENCODE_GO_ID];
		}
	}
	const overrides = state.overridesOfModel;
	if (overrides && LEGACY_OPENCODE_GO_ID in overrides) {
		if (!(OPENCODE_GO_CONFIG_ID in overrides)) { overrides[OPENCODE_GO_CONFIG_ID] = overrides[LEGACY_OPENCODE_GO_ID]; }
		delete overrides[LEGACY_OPENCODE_GO_ID];
	}

	if (!legacy && movedSelections === 0) {
		return undefined;
	}
	return { movedKey, movedSelections, movedVisibleModels };
}

/**
 * Стоит ли сказать человеку о переносе: только если с OpenCode Go он что-то делал. Пустой `openCodeGo`
 * в хранилище есть у каждого — стартовое значение, и сообщение об «уходе» неиспользованного провайдера было бы шумом.
 */
export function openCodeGoMigrationWorthMentioning(report: OpenCodeGoMigrationReport | undefined): boolean {
	return !!report && (report.movedKey || report.movedSelections > 0 || report.movedVisibleModels > 0);
}
