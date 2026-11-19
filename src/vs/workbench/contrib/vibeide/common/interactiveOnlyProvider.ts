/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Провайдер с `"interactiveOnly": true` разрешает только ручную работу человека в IDE.
 *
 * Тарифы вроде Qwen Token Plan запрещают автоматический трафик: выбранная человеком модель в чате
 * работает как обычно, а «Авто», роли оркестрации, шаги пайплайна, HTTP API и Telegram получают отказ.
 * Здесь — чистое решение «провайдер + источник запуска → можно или причина отказа», без побочных эффектов.
 */

/** Откуда пришёл запуск: рука человека в чате или автоматический путь */
export type VibeLaunchSource = 'manual' | 'auto' | 'orchestration' | 'pipeline' | 'httpApi' | 'telegram';

/** Что решению нужно знать о провайдере */
export interface VibeInteractiveOnlyProvider {
	readonly id: string;
	readonly name?: string;
	/** Значение поля из файла провайдеров; флагом считается только явное `true` */
	readonly interactiveOnly?: boolean;
}

export type VibeLaunchVerdict =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: string };

/** Чем оборачивается автоматический запуск для тарифа: фраза подставляется в отказ */
const AUTOMATIC_CONSEQUENCE: Readonly<Record<Exclude<VibeLaunchSource, 'manual'>, string>> = {
	auto: 'автоматический выбор модели («Авто») нарушает условия тарифа',
	orchestration: 'автоматическое назначение модели роли оркестрации нарушает условия тарифа',
	pipeline: 'автоматический запуск шага пайплайна нарушает условия тарифа',
	httpApi: 'запросы через HTTP API нарушают условия тарифа',
	telegram: 'запросы из бота Telegram нарушают условия тарифа',
};

/** Разрешён ли запуск: рука человека — всегда, автоматический путь — только не для `interactiveOnly` */
export function interactiveOnlyVerdict(provider: VibeInteractiveOnlyProvider, source: VibeLaunchSource): VibeLaunchVerdict {
	if (source === 'manual' || provider.interactiveOnly !== true) {
		return { allowed: true };
	}
	const name = provider.name || provider.id;
	return {
		allowed: false,
		reason: `Провайдер «${name}» разрешает только ручную работу в IDE: ${AUTOMATIC_CONSEQUENCE[source]}. Выберите модель этого провайдера в чате вручную.`,
	};
}

/** Что настройки провайдера несут о флаге и подписи */
export interface InteractiveOnlySettings {
	readonly title?: string;
	readonly interactiveOnly?: boolean;
}

/** Флаг в настройках провайдера: сид файлового провайдера или патч встроенного */
export function isInteractiveOnlyProvider(
	providerName: string,
	settingsOfProvider: Readonly<Record<string, InteractiveOnlySettings | undefined>>,
): boolean {
	return settingsOfProvider[providerName]?.interactiveOnly === true;
}

/**
 * То же решение по выбранной модели
 * `undefined` и «Авто» пропускаются: у них нет провайдера, который мог бы наложить тариф
 */
export function interactiveOnlyVerdictForSelection(
	settingsOfProvider: Readonly<Record<string, InteractiveOnlySettings | undefined>>,
	selection: { readonly providerName: string } | null | undefined,
	source: VibeLaunchSource,
): VibeLaunchVerdict {
	if (!selection || selection.providerName === 'auto') {
		return { allowed: true };
	}
	const settings = settingsOfProvider[selection.providerName];
	return interactiveOnlyVerdict({
		id: selection.providerName,
		name: settings?.title,
		interactiveOnly: settings?.interactiveOnly,
	}, source);
}
