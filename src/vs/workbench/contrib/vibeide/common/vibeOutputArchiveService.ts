/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { EXPAND_LINE_LIMIT, IExpandResult, OutputArchive, archiveMarker } from './outputArchive.js';

/**
 * Общий на окно архив сырого вывода команд.
 *
 * Сервис нужен потому, что кладёт и достаёт РАЗНЫЙ код: сжатие живёт в терминальном сервисе,
 * а разворачивает инструмент агента. Логика при этом целиком в чистом `outputArchive.ts` —
 * здесь только владение экземпляром и время.
 */
export interface IVibeOutputArchiveService {
	readonly _serviceBrand: undefined;
	/**
	 * Кладёт сырой вывод перед сжатием и возвращает СЖАТЫЙ текст с меткой возврата — либо его же
	 * без метки, когда разворачивать нечего.
	 */
	keep(command: string, raw: string, compressed: string): string;
	expand(ref: string, query?: string, limit?: number): IExpandResult;
}

export const IVibeOutputArchiveService = createDecorator<IVibeOutputArchiveService>('vibeOutputArchiveService');

export class VibeOutputArchiveService extends Disposable implements IVibeOutputArchiveService {
	declare readonly _serviceBrand: undefined;

	private readonly _archive = new OutputArchive();

	keep(command: string, raw: string, compressed: string): string {
		const ref = this._archive.store(command, raw, compressed, Date.now());
		return ref ? `${compressed}${archiveMarker(ref, raw, compressed)}` : compressed;
	}

	expand(ref: string, query?: string, limit: number = EXPAND_LINE_LIMIT): IExpandResult {
		return this._archive.expand(ref, query, limit);
	}
}

registerSingleton(IVibeOutputArchiveService, VibeOutputArchiveService, InstantiationType.Delayed);
