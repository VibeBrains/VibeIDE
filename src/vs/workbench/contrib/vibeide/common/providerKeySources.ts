/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Откуда берётся ключ провайдера и не заданы ли два источника сразу
 *
 * Путь отправки предпочитает ключ, разрешённый в окне (карточка, apiKeyRef, .vibe/.env),
 * переменной окружения из apiKeyEnv — так устроен transportKeyOf в electron-main
 * Здесь этот порядок один на всех, и карточка с предупреждением о проигравшем источнике не расходятся
 */

export type ProviderKeySource = 'gui' | 'ref' | 'env-file' | 'os-env' | 'none';

/** Что может дать каждый источник; пустое или отсутствующее значение источником не считается */
export interface ProviderKeyCandidates {
	/** Ключ, введённый в карточке провайдера в настройках */
	readonly guiKey?: string;
	/** Ключ провайдера, на который указывает apiKeyRef */
	readonly refKey?: string;
	/** Значение переменной apiKeyEnv из .vibe/.env */
	readonly envFileKey?: string;
	/** Переменная apiKeyEnv задана в окружении ОС; значение остаётся в electron-main */
	readonly osEnvPresent?: boolean;
}

export interface ResolvedProviderKey {
	/** Значение, которое окно может отдать пути отправки; у ключа только из ОС его нет */
	readonly key?: string;
	readonly source: ProviderKeySource;
	/** Ключ из настроек IDE и переменная apiKeyEnv заданы одновременно — один из них игнорируется */
	readonly conflict: boolean;
}

/** Ключ карточки → apiKeyRef → .vibe/.env → окружение ОС, как в transportKeyOf */
export const resolveProviderKey = (candidates: ProviderKeyCandidates): ResolvedProviderKey => {
	const guiKey = candidates.guiKey?.trim() ? candidates.guiKey : undefined;
	const refKey = candidates.refKey?.trim() ? candidates.refKey : undefined;
	const envFileKey = candidates.envFileKey?.trim() ? candidates.envFileKey : undefined;
	const conflict = !!(guiKey || refKey) && !!(envFileKey || candidates.osEnvPresent);
	if (guiKey) { return { key: guiKey, source: 'gui', conflict }; }
	if (refKey) { return { key: refKey, source: 'ref', conflict }; }
	if (envFileKey) { return { key: envFileKey, source: 'env-file', conflict }; }
	if (candidates.osEnvPresent) { return { source: 'os-env', conflict }; }
	return { source: 'none', conflict };
};
